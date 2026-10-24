import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import * as Provider from "@deepseek-ai/dsh-llm-pi-ai";
import { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
import {
  createDshRuntime,
  DshRuntimeError,
  type DshChatRuntime,
  type DshChatSession,
} from "@zhishu/dsh-agent";
import type { ApprovalDecision, ChatFrame, SubmitChatMessage } from "@zhishu/chat-contracts";
import { installWriting, validateInput, type WritingInput } from "@zhishu/ai-plugins/writing";
import { installResearch } from "@zhishu/ai-plugins/research";
import { installImage } from "@zhishu/ai-plugins/image";
import type { WritingImages } from "./writing.image.js";
import {
  validateAuthoringProposal,
  type AiTaskEvent,
  type AuthoringProposal,
  type EvidenceBundle,
} from "@zhishu/ai-contracts";
import type { RuntimeOptions as LegacyOptions } from "@zhishu/ai-runtime";
import type { Principal } from "../identity/identity.types.js";
import type { AiDocumentAccess } from "../documents/index.js";
import type { AppConfig } from "../../config.js";
import { DomainError } from "../../shared/domain-error.js";
import { WritingRepository } from "./writing.repository.js";
import { postgresSessionPersistence } from "./writing.persistence.js";

type AuthoringContext = {
  input: WritingInput;
  options: LegacyOptions;
  proposal?: AuthoringProposal;
};
export class WritingService {
  private runtime?: Promise<DshChatRuntime>;
  private principals = new Map<string, Principal>();
  private authoring = new Map<string, AuthoringContext>();
  private handles = new Map<string, { session: DshChatSession; used: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private shutdown = new AbortController();
  readonly repository: WritingRepository;
  private configurationId() {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "writing-v1",
          "research-v1",
          "image-v1",
          this.config.AI_MODEL ?? "test",
          this.config.AI_BASE_URL,
          this.config.AI_API_FORMAT,
          this.config.AI_THINKING,
          this.config.AI_REASONING_EFFORT,
        ]),
      )
      .digest("hex");
  }
  constructor(
    private pool: Pool,
    private documents: AiDocumentAccess,
    private config: AppConfig,
    private adapter?: LlmAdapter,
    private images?: WritingImages,
  ) {
    this.repository = new WritingRepository(pool);
  }
  capabilities() {
    return {
      enabled: !!(this.adapter || (this.config.AI_MODEL && this.config.AI_API_KEY)),
      engine: "dsh-v1" as const,
      image: this.images?.capability() ?? { available: false, reason: "图片服务尚未配置" },
    };
  }
  private async configure(ctx: Context) {
    await ctx.plugin(postgresSessionPersistence(this.pool));
    if (this.adapter) ctx.llm.registerAdapter(["writing"], this.adapter);
    else {
      ctx.set(
        "launchEnvironment",
        createLaunchEnvironmentSnapshot([
          { source: "process", values: { AI_API_KEY: this.config.AI_API_KEY ?? "" } },
        ]),
      );
      const anthropic =
        (this.config.AI_API_FORMAT ??
          (this.config.AI_BASE_URL?.includes("/anthropic") ? "anthropic" : "openai")) ===
        "anthropic";
      await ctx.plugin(Provider, {
        providers: {
          writing: {
            apiKeyEnv: "AI_API_KEY",
            api: anthropic ? "anthropic-messages" : "openai-completions",
            baseURL:
              this.config.AI_BASE_URL ??
              (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
            models: [
              { id: this.config.AI_MODEL!, contextWindow: 65536, maxTokens: 4096, input: ["text"] },
            ],
            timeoutMs: this.config.AI_TIMEOUT_MS,
            retryPolicy: { mode: "normal", maxRetries: 0 },
            reasoning:
              this.config.AI_THINKING === "disabled" ? "off" : this.config.AI_REASONING_EFFORT,
          },
        },
      });
    }
  }
  private getRuntime() {
    if (!this.capabilities().enabled)
      throw new DomainError("SERVICE_UNAVAILABLE", "写作模型尚未配置");
    this.runtime ??= createDshRuntime({
      persistence: "required",
      store: this.repository,
      configure: (ctx) => this.configure(ctx),
      agentOptions: { provider: "writing", model: this.config.AI_MODEL ?? "test", maxTokens: 4096 },
      configurationId: this.configurationId(),
      limits: {
        maxSessions: this.config.AI_MAX_CONCURRENT * 2,
        maxQueued: 4,
        timeoutMs: this.config.AI_TIMEOUT_MS,
      },
      authorize: (id) => this.authorize(id),
      resultText: (records, run) => {
        const context = this.authoring.get(run.conversationId);
        if (!context) return undefined;
        const proposal = records.filter((e) => e.type === "plugin:zhishu/authoring").at(-1)?.data;
        const checked = validateAuthoringProposal(proposal, {
          request: context.input.request,
          snapshot: context.input.snapshot,
          evidence: context.input.evidence ?? { freshness: "current", items: [] },
        });
        return checked.success ? checked.data.summary || "文章草稿已生成，等待确认。" : undefined;
      },
      setup: async (scope, agent, id) => {
        const principal = this.principals.get(id)!;
        const row = await this.repository.get(principal, id);
        const sources = await this.documents.sources(principal, row.source_document_ids);
        const task = this.authoring.get(id);
        const evidence: EvidenceBundle =
          task?.input.request.intent === "research"
            ? { freshness: "current", items: [] }
            : structuredClone(sources.evidence);
        if (!task && this.images) {
          const capability = installImage(scope, this.images.ports(principal, id));
          if (capability.available)
            scope.on("tools/pre-execute", async (exec, next) =>
              exec.name === "create_image"
                ? {
                    kind: "ask",
                    reason:
                      "创建一张 1024×1024 图片会调用收费图片服务，停止生成不能撤销已产生的费用。",
                  }
                : next(),
            );
        }
        const calls = { search: 0, read: 0 };
        if (row.source_document_ids.length)
          installResearch(scope, {
            reserve: async (kind, signal) => {
              signal.throwIfAborted();
              await this.authorize(id);
              if (++calls[kind] > 6) throw new DshRuntimeError("BUDGET_EXCEEDED");
              await task?.options.reserveUsage?.(
                { threadId: task.input.threadId, kind, inputTokens: 0, maxOutputTokens: 0 },
                signal,
              );
            },
            search: async (query) => {
              await this.authorize(id);
              return row.source_document_ids.map((sourceId) => {
                const items = sources.evidence.items.filter((i) => i.source.sourceId === sourceId);
                return {
                  sourceId,
                  title: items[0]?.title ?? "资料",
                  excerpt: items
                    .filter((i) => i.text.includes(query))
                    .map((i) => i.text)
                    .join(" ")
                    .slice(0, 1200),
                };
              });
            },
            read: async (sourceId) => {
              await this.authorize(id);
              if (!row.source_document_ids.includes(sourceId))
                throw new DomainError("AI_ACCESS_REVOKED", "来源不可访问");
              return sources.evidence.items.filter((i) => i.source.sourceId === sourceId);
            },
            register: async (items) => {
              for (const item of items)
                if (!evidence.items.some((i) => i.evidenceId === item.evidenceId))
                  evidence.items.push(item);
            },
          });
        if (task) {
          installWriting(scope, {
            input: task.input,
            evidence: () => evidence,
            verify: async (signal) => {
              signal.throwIfAborted();
              await this.authorize(id);
              await task.options.verifyEvidence?.(evidence.items, signal);
            },
            save: async (proposal) => {
              task.proposal = proposal;
            },
          });
          scope.on("agent/request", async (payload, next) => {
            const inputTokens = Buffer.byteLength(JSON.stringify(agent.session.deriveMessages()));
            if (inputTokens > task.options.limits.maxInputTokens)
              throw new DshRuntimeError("BUDGET_EXCEEDED");
            await task.options.reserveUsage?.(
              {
                threadId: task.input.threadId,
                kind: "model",
                inputTokens,
                maxOutputTokens: task.options.limits.maxOutputTokens,
              },
              payload.signal,
            );
            return next();
          });
        }
        scope.systemPrompt.section({
          name: "source-scope",
          order: 10,
          text: `可用资料 ID：${JSON.stringify(row.source_document_ids)}。没有网页检索能力。${this.images?.capability().available ? "图片每次仅创建一张，创建前需要单次审批。" : "图片创建不可用。"}`,
        });
      },
    });
    this.timer ??= setInterval(() => {
      void this.releaseIdle();
    }, 30000);
    this.timer.unref();
    return this.runtime;
  }
  private async releaseIdle() {
    for (const [id, entry] of this.handles) {
      if (Date.now() - entry.used < 60000) continue;
      try {
        const snapshot = await entry.session.snapshot();
        if (snapshot.runs.some((r) => ["running", "queued", "waiting-approval"].includes(r.status)))
          continue;
        await entry.session.dispose();
        this.handles.delete(id);
        this.principals.delete(id);
        this.authoring.delete(id);
      } catch {
        try {
          await entry.session.dispose();
        } catch {
          /* The persisted prefix remains the recovery authority. */
        }
        this.handles.delete(id);
        this.principals.delete(id);
        this.authoring.delete(id);
      }
    }
  }
  private async authorize(id: string) {
    const principal = this.principals.get(id);
    if (!principal || !principal.active) throw new DomainError("UNAUTHENTICATED", "请重新登录");
    const row = await this.repository.get(principal, id);
    await this.documents.verifySourceVersions(principal, row.source_context.sourceVersions);
  }
  private async attach(principal: Principal, id: string) {
    const row = await this.repository.get(principal, id);
    this.principals.set(id, principal);
    const existing = this.handles.get(id);
    if (existing) {
      existing.used = Date.now();
      return existing.session;
    }
    const runtime = await this.getRuntime();
    const session = row.state ? await runtime.restoreSession(id) : await runtime.createSession(id);
    this.handles.set(id, { session, used: Date.now() });
    return session;
  }
  async create(principal: Principal, sourceIds: string[]) {
    const sourceContext = await this.documents.sources(principal, sourceIds);
    const id = randomUUID();
    await this.repository.create(principal, id, sourceIds, sourceContext);
    return (await this.attach(principal, id)).snapshot();
  }
  async snapshot(principal: Principal, id: string) {
    const row = await this.repository.get(principal, id);
    if (row.state?.configurationId && row.state.configurationId !== this.configurationId()) {
      await this.documents.verifySourceVersions(principal, row.source_context.sourceVersions);
      return row.state.snapshot;
    }
    const session = await this.attach(principal, id);
    try {
      return await session.snapshot();
    } catch (error) {
      if (error instanceof DshRuntimeError && error.code === "SESSION_UNAVAILABLE") {
        try {
          await session.dispose();
        } catch {
          /* Leave recovery to the next authorized attach. */
        }
        this.handles.delete(id);
        this.principals.delete(id);
      }
      throw error;
    }
  }
  async submit(principal: Principal, id: string, input: SubmitChatMessage) {
    const session = await this.attach(principal, id);
    const snapshot = await session.snapshot();
    const duplicate = snapshot.runs.some(
      (r) =>
        r.idempotencyKey === input.idempotencyKey || r.inputMessageId === input.clientMessageId,
    );
    const run = duplicate
      ? await session.submit(input)
      : await this.repository.admit(principal, this.config.AI_MAX_CONCURRENT, () =>
          session.submit(input),
        );
    return { runId: run.id, snapshot: await session.snapshot() };
  }
  async cancel(principal: Principal, id: string, runId: string) {
    const s = await this.attach(principal, id);
    await s.cancel(runId);
    return s.snapshot();
  }
  async resume(principal: Principal, id: string, runId: string) {
    const s = await this.attach(principal, id);
    await s.resume(runId);
    return s.snapshot();
  }
  async decide(principal: Principal, id: string, input: ApprovalDecision) {
    const s = await this.attach(principal, id);
    await s.decide(input);
    return s.snapshot();
  }
  async imageList(principal: Principal, id: string) {
    await this.repository.get(principal, id);
    return this.images ? this.images.list(id) : [];
  }
  async imageRefresh(principal: Principal, id: string, jobId: string) {
    await this.repository.get(principal, id);
    if (!this.images) throw new DomainError("SERVICE_UNAVAILABLE", "图片服务未配置");
    return this.images.refresh(principal, id, jobId);
  }
  async imageAccess(principal: Principal, id: string, assetId: string) {
    await this.repository.get(principal, id);
    if (!this.images) throw new DomainError("SERVICE_UNAVAILABLE", "图片服务未配置");
    return this.images.access(principal, id, assetId);
  }
  async *observe(
    principal: Principal,
    id: string,
    cursor: string,
    subscriberSignal: AbortSignal,
  ): AsyncGenerator<ChatFrame> {
    const signal = AbortSignal.any([subscriberSignal, this.shutdown.signal]);
    const session = await this.attach(principal, id);
    // Install the live listener before reading the durable barrier. Outbox replay owns ordering.
    const live: ChatFrame[] = [];
    const stop = new AbortController();
    const drain = (async () => {
      for await (const frame of session.observe(AbortSignal.any([signal, stop.signal]))) {
        if (live.length < 128) live.push(frame);
        else {
          live.length = 0;
          live.push({ type: "resync-required", conversationId: id });
        }
      }
    })();
    try {
      while (!signal.aborted) {
        await this.authorize(id);
        const events = await this.repository.events(id, cursor);
        for (const event of events) {
          cursor = event.sequence;
          yield event;
        }
        for (const frame of live.splice(0)) if (frame.type !== "snapshot") yield frame;
        if (events.length === 128) continue;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 250);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    } finally {
      stop.abort();
      await drain;
    }
  }
  async *generateProposal(
    principal: Principal,
    input: WritingInput,
    options: LegacyOptions,
    signal: AbortSignal,
    resume: boolean,
  ): AsyncGenerator<AiTaskEvent> {
    validateInput(input, options);
    const id = `authoring_${createHash("sha256").update(input.threadId).digest("hex")}`;
    let seq = 0;
    const event = <T extends AiTaskEvent["type"]>(
      type: T,
      payload: Extract<AiTaskEvent, { type: T }>["payload"],
    ): AiTaskEvent =>
      ({
        protocolVersion: 1,
        requestId: input.request.requestId,
        seq: ++seq,
        type,
        payload,
      }) as AiTaskEvent;
    yield event("started", { kind: "authoring" });
    const context = { input, options } as AuthoringContext;
    this.authoring.set(id, context);
    try {
      const sources =
        input.evidence?.items
          .map((i) => i.source.sourceId)
          .filter((v, i, a) => a.indexOf(v) === i) ?? [];
      const sourceContext = await this.documents.sources(principal, sources);
      await this.repository.ensure(principal, id, sources, sourceContext);
      const session = await this.attach(principal, id);
      const before = await session.snapshot();
      let runId = before.runs[0]?.id;
      if (!runId) {
        const text = JSON.stringify({
          instruction: input.request.instruction,
          intent: input.request.intent,
          target: input.request.target,
          document: input.snapshot.content,
          evidence: input.evidence?.items ?? [],
          history: input.history,
        });
        if (text.length > 32000)
          throw new DomainError("RESOURCE_LIMIT", "目标与资料过长，请缩小范围");
        runId = (
          await session.submit({
            clientMessageId: input.request.requestId,
            idempotencyKey: input.request.requestId,
            text,
          })
        ).id;
      } else if (resume && before.runs[0]?.status === "interrupted") await session.resume(runId);
      const cancel = () => {
        void session.cancel(runId!).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        let snapshot = await session.snapshot();
        while (
          snapshot.runs.some(
            (r) => r.id === runId && ["queued", "running", "waiting-approval"].includes(r.status),
          )
        ) {
          await new Promise((r) => setTimeout(r, 30));
          snapshot = await session.snapshot();
        }
        const run = snapshot.runs.find((r) => r.id === runId);
        if (run?.status !== "completed")
          throw new DshRuntimeError(run?.errorCode ?? "MODEL_FAILED");
        const proposal = session
          .pluginRecords()
          .filter((e) => e.type === "plugin:zhishu/authoring")
          .at(-1)?.data;
        const checked = validateAuthoringProposal(proposal, {
          request: input.request,
          snapshot: input.snapshot,
          evidence: input.evidence ?? { freshness: "current", items: [] },
        });
        if (!checked.success) throw new DshRuntimeError("OUTPUT_REQUIRED");
        yield event("proposal", checked.data);
        yield event("completed", { resultKind: "proposal" });
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    } finally {
      const entry = this.handles.get(id);
      if (entry) {
        await entry.session.dispose();
        this.handles.delete(id);
      }
      this.authoring.delete(id);
      this.principals.delete(id);
    }
  }
  async close() {
    this.shutdown.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.runtime) await (await this.runtime).dispose();
  }
}
