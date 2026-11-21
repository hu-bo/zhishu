import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  createAssistantMessage,
  createUserMessage,
  freezeMessage,
  MessageId,
  type UserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { PluginRecord } from "@deepseek-ai/dsh-session";
import {
  DshRuntimeError,
  type ApprovalRequest,
  type DshRuntimeOptions,
  type NativeApprovalOutcome,
  type NativeSession,
  type PreviewToolFact,
  type SessionAccess,
  type TurnHost,
  type TurnRequest,
  type TurnResult,
} from "./types.js";

const APPROVAL_TTL_MS = 120_000;

/**
 * Native assistant execution. Drives one official DSH Agent session for a
 * (conversation, contextRevision) pair. Product state (Runs, messages, approvals, artifacts
 * and events) lives entirely in the shared application store through TurnHost.
 */
export class DshSession implements NativeSession, SessionAccess {
  private handle!: AgentHandle;
  private closed = false;
  private lastUsedAt = Date.now();
  private epoch = randomUUID();
  private mutations: Promise<unknown> = Promise.resolve();
  private current?: TurnRequest;
  private host?: TurnHost;
  private answers = new Map<string, (outcome: NativeApprovalOutcome) => void>();
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private approvalSignals = new Map<string, AbortSignal | undefined>();
  /** Last streamed attempt revision; tool lifecycle frames reuse it as their stream position. */
  private attemptRevision = 0;
  private toolIndex = 0;
  private toolNames = new Map<string, string>();

  private constructor(
    private ctx: Context,
    private options: DshRuntimeOptions,
    readonly conversationId: string,
    readonly contextRevision: number,
    readonly nativeSessionId: string,
    private detached: () => void,
  ) {}

  static async open(
    ctx: Context,
    options: DshRuntimeOptions,
    input: {
      conversationId: string;
      contextRevision: number;
      nativeSessionId: string;
      restore: boolean;
    },
    detached: () => void,
  ): Promise<DshSession> {
    const session = new DshSession(
      ctx,
      options,
      input.conversationId,
      input.contextRevision,
      input.nativeSessionId,
      detached,
    );
    const persistence = ctx.get("sessionPersistence");
    const resumeNative =
      input.restore && !!(await persistence?.stat(SessionId(input.nativeSessionId)));
    if (input.restore && !resumeNative) throw new DshRuntimeError("NOT_FOUND");
    const setup = async (scope: Context, agent: AgentHandle["agent"]) => {
      session.installHooks(scope, agent);
      await options.setup?.(scope, agent, session);
    };
    session.handle = resumeNative
      ? await ctx.agents.resume({
          resumeSessionId: SessionId(input.nativeSessionId),
          agentOptions: options.agentOptions,
          setup,
        })
      : await ctx.agents.create({
          sessionId: SessionId(input.nativeSessionId),
          agentOptions: options.agentOptions,
          setup,
        });
    if (input.restore) await session.handle.agent.whenIdle();
    return session;
  }

  /** Kernel hooks replicate the durability protocol of the pinned official release. */
  private installHooks(scope: Context, agent: AgentHandle["agent"]): void {
    this.installRequestGuard(scope, agent);
    this.installStreamPreview(scope, agent);
    this.installToolActivity(scope, agent);
    this.installApprovalLifecycle(scope, agent);
  }

  /** Authorize and reserve every model request, then enforce the input byte limit. */
  private installRequestGuard(scope: Context, agent: AgentHandle["agent"]): void {
    scope.on("agent/request", async (payload, next) => {
      if (payload.agent !== agent) return next();
      const turn = this.current;
      const host = this.host;
      if (!turn || !host) throw new DshRuntimeError("NO_ACTIVE_RUN");
      await host.authorize(turn);
      await host.reserveModelCall(turn);
      const config = await next();
      const messages = agent.session.deriveMessages();
      if (
        Buffer.byteLength(JSON.stringify(messages)) >
        (this.options.limits?.maxInputBytes ?? 128_000)
      )
        throw new DshRuntimeError("INPUT_LIMIT");
      return config;
    });
  }

  /** Output byte limit plus live text/thinking/tool-argument previews; the attempt cursor is confined here. */
  private installStreamPreview(scope: Context, agent: AgentHandle["agent"]): void {
    let textAttempt: string | undefined;
    let textRevision = 0;
    let textIndex = 0;
    let thinkingIndex = 0;
    let argsIndex = 0;
    let outputBytes = 0;
    scope.on("agent/assistant-stream", ({ agent: subject, frame }) => {
      if (subject !== agent) return;
      if (frame.type === "start") {
        textAttempt = frame.attemptId;
        // The pinned release increments native revision on EVERY frame.
        // Product revision identifies the whole attempt, not each text token.
        textRevision = frame.revision;
        this.attemptRevision = frame.revision;
        textIndex = 0;
        thinkingIndex = 0;
        argsIndex = 0;
        outputBytes = 0;
        return;
      }
      if (frame.type !== "chunk") return;
      outputBytes += Buffer.byteLength(JSON.stringify(frame.chunk));
      if (outputBytes > (this.options.limits?.maxOutputBytes ?? 128_000)) {
        agent.cancel({ kind: "hook", reason: "OUTPUT_LIMIT" });
        return;
      }
      if (frame.attemptId !== textAttempt) return;
      const chunk = frame.chunk;
      // Only text, reasoning and raw tool-argument deltas are public preview facts;
      // what each channel means for the product is decided by the host, never here.
      switch (chunk.type) {
        case "text-delta":
          this.preview({
            channel: "text",
            revision: textRevision,
            index: textIndex++,
            text: chunk.text,
          });
          break;
        case "reasoning-delta":
          this.preview({
            channel: "thinking",
            revision: textRevision,
            index: thinkingIndex++,
            text: chunk.text,
          });
          break;
        case "tool-call-delta":
          this.preview({
            channel: "tool-args",
            revision: textRevision,
            index: argsIndex++,
            text: chunk.argumentsDelta,
            tool: { id: chunk.id, name: chunk.name ?? "", status: "running" },
          });
          break;
        default:
          break;
      }
    });
  }

  /**
   * Tool lifecycle replicated from the durable session feed: the committed call is the
   * honest "running" fact, the committed result settles it. Preview-only; runs and
   * approvals stay owned by the host through their own callbacks.
   */
  private installToolActivity(scope: Context, agent: AgentHandle["agent"]): void {
    scope.on("session/event", (session, event) => {
      if (session !== agent.session) return;
      const turn = this.current;
      const host = this.host;
      if (!turn || !host || this.attemptRevision === 0) return;
      if (event.type === "tool/call") {
        const callId = String(event.data.callId);
        this.toolNames.set(callId, event.data.name);
        host.emitPreview(turn, {
          streamEpoch: this.epoch,
          revision: this.attemptRevision,
          index: this.toolIndex++,
          text: "",
          channel: "tool",
          tool: { id: callId, name: event.data.name, status: "running" },
        });
        return;
      }
      if (event.type === "tool/result") {
        const callId = String(event.data.message.toolCallId);
        const name = this.toolNames.get(callId);
        this.toolNames.delete(callId);
        // Without a committed call there is no honest name to report.
        if (!name) return;
        const failed = event.data.error !== undefined || event.data.message.isError === true;
        host.emitPreview(turn, {
          streamEpoch: this.epoch,
          revision: this.attemptRevision,
          index: this.toolIndex++,
          text: "",
          channel: "tool",
          tool: { id: callId, name, status: failed ? "failed" : "completed" },
        });
      }
    });
  }

  /** Emit one preview frame while a turn is active; between turns previews are meaningless. */
  private preview(frame: {
    channel: "text" | "thinking" | "tool-args";
    revision: number;
    index: number;
    text: string;
    tool?: PreviewToolFact;
  }): void {
    const turn = this.current;
    const host = this.host;
    if (!turn || !host || frame.revision === 0) return;
    host.emitPreview(turn, {
      streamEpoch: this.epoch,
      revision: frame.revision,
      index: frame.index,
      text: frame.text,
      channel: frame.channel,
      ...(frame.tool ? { tool: frame.tool } : {}),
    });
  }

  /** Durable one-shot approval: persist the wait, resolve via decide(), always clean up. */
  private installApprovalLifecycle(scope: Context, agent: AgentHandle["agent"]): void {
    scope.on("approval/request", async (request, next) => {
      if (request.agent !== agent) return next();
      const turn = this.current;
      const host = this.host;
      if (!turn || !host) return "unavailable";
      const approval: ApprovalRequest = {
        ...turn,
        approvalId: randomUUID(),
        action: request.toolName,
        description: request.reason?.slice(0, 1_000),
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      };
      let resolve!: (outcome: NativeApprovalOutcome) => void;
      const answer = new Promise<NativeApprovalOutcome>((r) => {
        resolve = r;
      });
      this.answers.set(approval.approvalId, resolve);
      this.pendingApprovals.set(approval.approvalId, approval);
      this.approvalSignals.set(approval.approvalId, request.signal);
      const cancel = () => resolve("cancelled");
      request.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(approval.approvalId)) resolve("unavailable");
      }, APPROVAL_TTL_MS);
      try {
        await host.onApprovalRequested(approval);
        // Persist the one-shot approval audit before any billable tool dispatch.
        await this.ctx.sessions.flush(agent.session);
        if (request.signal?.aborted) return "cancelled";
        const outcome = await answer;
        await host.onApprovalResolved(approval, outcome);
        return outcome;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
        this.answers.delete(approval.approvalId);
        this.pendingApprovals.delete(approval.approvalId);
        this.approvalSignals.delete(approval.approvalId);
      }
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  private ensureAvailable() {
    if (this.closed) throw new DshRuntimeError("SESSION_UNAVAILABLE");
  }

  async execute(request: TurnRequest, host: TurnHost, signal: AbortSignal): Promise<TurnResult> {
    this.ensureAvailable();
    return this.mutate(async () => {
      if (this.current) throw new DshRuntimeError("ALREADY_RUNNING");
      this.current = request;
      this.host = host;
      try {
        // Durable-before-deliver: persist the native identity, send, then confirm.
        let nativeMessageId = request.plannedNativeMessageId;
        if (nativeMessageId === undefined) {
          const message = createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: request.inputText }],
          });
          nativeMessageId = message.id;
          await host.onDeliveryPlanned(request, nativeMessageId);
          if (request.deadlineAtMs - Date.now() <= 0)
            return this.plain(request, nativeMessageId, "failed", "DEADLINE");
          if (signal.aborted) return this.plain(request, nativeMessageId, "cancelled");
          this.handle.agent.send(message, "next-turn", true);
          await host.onDeliveryConfirmed(request, nativeMessageId);
        }
        return await this.awaitTurn(request, nativeMessageId, host, signal);
      } finally {
        this.current = undefined;
        this.host = undefined;
        this.lastUsedAt = Date.now();
      }
    });
  }

  /**
   * Restart path. When the native log already carries the delivered input, settle from it
   * without touching the model; otherwise re-deliver the exact planned message identity.
   */
  async settle(request: TurnRequest, host: TurnHost, signal: AbortSignal): Promise<TurnResult> {
    this.ensureAvailable();
    return this.mutate(async () => {
      if (this.current) throw new DshRuntimeError("ALREADY_RUNNING");
      this.current = request;
      this.host = host;
      try {
        const planned = request.plannedNativeMessageId;
        if (planned === undefined)
          return this.plain(request, "", "interrupted", "OUTPUT_UNKNOWN", false);
        const state = this.projection();
        const inLog =
          state?.inputs[planned] !== undefined || state?.pending["next-turn"].includes(planned);
        if (!inLog) {
          this.handle.agent.send(
            this.rebuildMessage(planned, request.inputText),
            "next-turn",
            true,
          );
          await host.onDeliveryConfirmed(request, planned);
        }
        return await this.awaitTurn(request, planned, host, signal, inLog);
      } finally {
        this.current = undefined;
        this.host = undefined;
        this.lastUsedAt = Date.now();
      }
    });
  }

  /**
   * Deterministic no-model exchange: the trusted answer is appended to the native log so
   * later turns keep full context. Re-recording an already stored planned id is a no-op.
   */
  async recordExchange(request: TurnRequest, host: TurnHost, text: string): Promise<TurnResult> {
    this.ensureAvailable();
    return this.mutate(async () => {
      if (this.current) throw new DshRuntimeError("ALREADY_RUNNING");
      this.current = request;
      this.host = host;
      try {
        const state = this.projection();
        let nativeMessageId = request.plannedNativeMessageId;
        const recorded =
          nativeMessageId !== undefined && state?.inputs[nativeMessageId] !== undefined;
        if (!recorded) {
          const message =
            nativeMessageId !== undefined
              ? this.rebuildMessage(nativeMessageId, request.inputText)
              : createUserMessage({
                  source: { kind: "user" },
                  content: [{ type: "text", text: request.inputText }],
                });
          nativeMessageId = message.id;
          await host.onDeliveryPlanned(request, nativeMessageId);
          const session = this.handle.agent.session;
          const turn = (state?.currentTurn ?? 0) + 1;
          session.append("turn/start", { turn });
          session.append("user/message", message, { surfaceOp: "append" });
          session.append(
            "assistant/message",
            {
              turn,
              step: 0,
              message: createAssistantMessage({
                // Deterministic server-authored answer, honestly labelled as non-provider output.
                source: { model: "deterministic-exchange", provider: "dsh-agent" },
                content: [{ type: "text", text }],
              }),
              stream: [],
            },
            { surfaceOp: "append" },
          );
          session.append("turn/end", { turn, reason: { kind: "completed" } });
          await this.ctx.sessions.flush(session);
          await host.onDeliveryConfirmed(request, nativeMessageId);
        }
        return {
          conversationId: request.conversationId,
          runId: request.runId,
          attempt: request.attempt,
          contextRevision: request.contextRevision,
          nativeMessageId: nativeMessageId!,
          deliveryConfirmed: true,
          status: "completed",
          resultText: text,
          hasToolFacts: false,
          pluginRecords: this.projection()?.records ?? [],
        };
      } finally {
        this.current = undefined;
        this.host = undefined;
        this.lastUsedAt = Date.now();
      }
    });
  }

  private async awaitTurn(
    request: TurnRequest,
    nativeMessageId: string,
    host: TurnHost,
    signal: AbortSignal,
    skipDeadline = false,
  ): Promise<TurnResult> {
    const agent = this.handle.agent;
    const remaining = skipDeadline ? undefined : request.deadlineAtMs - Date.now();
    if (remaining !== undefined && remaining <= 0)
      return this.plain(request, nativeMessageId, "failed", "DEADLINE");
    const timer =
      remaining !== undefined
        ? setTimeout(() => agent.cancel({ kind: "hook", reason: "DEADLINE" }), remaining)
        : undefined;
    const abort = () => agent.cancel({ kind: "user" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await agent.whenIdle();
      return await this.settleTurn(request, nativeMessageId);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private rebuildMessage(id: string, text: string): UserMessage {
    return freezeMessage({
      id: MessageId(id),
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text }],
    } as UserMessage);
  }

  private projection() {
    return this.ctx.sessionProjections.stateOf(this.handle.agent.session, "dshAssistant");
  }

  private async settleTurn(request: TurnRequest, nativeMessageId: string): Promise<TurnResult> {
    await this.ctx.sessions.flush(this.handle.agent.session);
    const state = this.projection();
    const turn = request.knownTurn ?? state?.inputs[nativeMessageId];
    const turnState = turn === undefined ? undefined : state?.turns[String(turn)];
    const reason = turnState?.reason;
    if (!reason) {
      return this.plain(
        request,
        nativeMessageId,
        "interrupted",
        "DELIVERY_UNCONFIRMED",
        true,
        turn,
        state,
      );
    }
    const pluginRecords = state?.records ?? [];
    const turnText = turnState?.text ?? "";
    const output = this.options.resultText?.(pluginRecords, turnText) ?? turnText;
    const base = {
      conversationId: request.conversationId,
      runId: request.runId,
      attempt: request.attempt,
      contextRevision: request.contextRevision,
      nativeMessageId,
      deliveryConfirmed: true,
      turn,
      hasToolFacts: turnState?.hasTools === true,
      ...(turnState?.usage ? { usage: turnState.usage } : {}),
      pluginRecords,
    };
    if (
      reason.kind === "completed" &&
      output &&
      Buffer.byteLength(output) <= (this.options.limits?.maxOutputBytes ?? 128_000)
    )
      return { ...base, status: "completed", resultText: output };
    let outcome: { status: TurnResult["status"]; errorCode?: string };
    switch (reason.kind) {
      case "completed":
        // Empty or over-limit output is not an admissible result.
        outcome = { status: "failed", errorCode: "OUTPUT_REQUIRED" };
        break;
      case "aborted":
        switch (reason.reason.kind) {
          case "user":
            outcome = { status: "cancelled", errorCode: undefined };
            break;
          case "disposed":
            // Session teardown interrupts the turn; the durable cause stays ABORTED.
            outcome = { status: "interrupted", errorCode: "ABORTED" };
            break;
          case "hook":
            outcome =
              reason.reason.reason === "DEADLINE"
                ? { status: "interrupted", errorCode: "TIMEOUT" }
                : { status: "failed", errorCode: "ABORTED" };
            break;
          case "parent":
          case "legacy":
            outcome = { status: "failed", errorCode: "ABORTED" };
            break;
        }
        break;
      case "interrupted":
        outcome = { status: "interrupted", errorCode: "INTERRUPTED" };
        break;
      case "error": {
        const code = reason.error.code;
        outcome = {
          status: "failed",
          errorCode: code !== "UNKNOWN" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "ERROR",
        };
        break;
      }
      default:
        // blocked / max-tokens / forked and plugin-merged kinds surface their upper-cased kind.
        outcome = { status: "failed", errorCode: reason.kind.toUpperCase() };
        break;
    }
    return { ...base, ...outcome, resultText: output || undefined };
  }

  private plain(
    request: TurnRequest,
    nativeMessageId: string,
    status: TurnResult["status"],
    errorCode?: string,
    deliveryConfirmed = true,
    turn?: number,
    state = this.projection(),
  ): TurnResult {
    const turnUsage = turn !== undefined ? state?.turns[String(turn)]?.usage : undefined;
    return {
      conversationId: request.conversationId,
      runId: request.runId,
      attempt: request.attempt,
      contextRevision: request.contextRevision,
      nativeMessageId,
      deliveryConfirmed,
      status,
      errorCode,
      turn,
      hasToolFacts: false,
      ...(turnUsage ? { usage: turnUsage } : {}),
      pluginRecords: state?.records ?? [],
    };
  }

  /** Host-side entry for user decisions; the kernel hook resolves when a pending approval matches. */
  async decide(approvalId: string, decision: "allow-once" | "reject"): Promise<void> {
    this.ensureAvailable();
    this.lastUsedAt = Date.now();
    const resolve = this.answers.get(approvalId);
    if (!resolve || !this.pendingApprovals.has(approvalId))
      throw new DshRuntimeError("APPROVAL_EXPIRED");
    if (this.approvalSignals.get(approvalId)?.aborted)
      throw new DshRuntimeError("APPROVAL_EXPIRED");
    resolve(decision === "allow-once" ? "allowed-once" : "rejected");
  }

  cancelActive(runId: string): void {
    if (this.current?.runId === runId) this.handle.agent.cancel({ kind: "user" });
  }

  /**
   * Last turn activity for idle eviction; undefined while a turn (or its approval) is
   * active or after close, so recyclers never interrupt in-flight work.
   */
  idleSince(): number | undefined {
    if (this.closed || this.current) return undefined;
    return this.lastUsedAt;
  }

  pluginRecords(): readonly PluginRecord[] {
    return this.projection()?.records ?? [];
  }

  /** SessionAccess: run-specific inputs for tool installers. */
  currentTurn(): TurnRequest | undefined {
    return this.current;
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handle.agent.cancel({ kind: "disposed" });
    for (const resolve of this.answers.values()) resolve("cancelled");
    try {
      await this.mutations;
      await this.ctx.sessions.flush(this.handle.agent.session);
    } finally {
      await this.handle.dispose();
      this.detached();
    }
  }
}

export function deterministicNativeSessionId(
  conversationId: string,
  contextRevision: number,
): string {
  return `dsh_${createHash("sha256")
    .update(JSON.stringify([conversationId, contextRevision]))
    .digest("hex")
    .slice(0, 40)}`;
}
