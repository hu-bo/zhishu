import type {
  Citation,
  EvidenceBundle,
  EvidenceRef,
  QaRunContext,
  ScopeSelection,
} from "@zhishu/ai-contracts";
import { validateEvidenceBundle } from "@zhishu/ai-contracts";
import { runQaAnswerFlow, QaFlowError, type QaFlowPorts } from "@zhishu/ai-qa";
import type { ConversationSnapshot, MessagePart, Run } from "@zhishu/chat-contracts";
import type { Principal } from "../identity/identity.types.js";
import type { AppConfig } from "../../config.js";
import { DomainError } from "../../shared/domain-error.js";
import type { AiService, ConversationOwner } from "../ai/index.js";
import type { ArtifactRow, ConversationRow, RunRow } from "../ai/index.js";
import {
  conversationKey,
  runDto,
  streamConversation,
  type ConversationEventBus,
  type SseHandle,
} from "../ai/index.js";
import type { RagService, RetrievalScope } from "../rag/rag.service.js";
import { createQaGenerateAdapter, type QaGenerateAdapter } from "./qa.model.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/** Audiences that may drive the same QA engine: an internal principal or one public site visitor. */
export type QaAudience =
  | { kind: "internal"; principal: Principal }
  | {
      kind: "site";
      tenantId: string;
      siteId: string;
      visitorId: string;
      /** Live approved set resolved by qa-sites on every request. */
      approved: readonly { documentId: string; workspaceId: string; publicLabel: string }[];
      /** Admin preview: an internal identity bound to the site, projected exactly like visitors. */
      internal?: Principal;
    };

/** Public evidence projection shape, mirrored by the qa-sites route response schema. */
export interface QaPublicEvidence {
  sources: { sourceKind: "document"; title: string; label?: string }[];
  items: { evidenceId: string; locator: Record<string, unknown>; text: string }[];
}

export interface QaSubmitInput {
  clientMessageId: string;
  idempotencyKey: string;
  text: string;
  expectedContextRevision: number;
  scope?: ScopeSelection;
}

export interface HandoffCommand {
  tenantId: string;
  identityId: string;
  sourceConversationId: string;
  messageIds: string[];
  artifactIds: string[];
  instruction: string;
  intent?: "auto" | "create" | "continue" | "rewrite" | "summarize" | "translate" | "research";
  targetDocumentId?: string | null;
  creationKey: string;
}

export interface WritingHandoffPort {
  createFromHandoff(
    cmd: HandoffCommand,
  ): Promise<{ conversationId: string; runId: string; replayed: boolean }>;
}

const HISTORY_LIMIT = 16;
const HISTORY_BYTE_LIMIT = 16_000;

export interface QaServiceDeps {
  store: AiService;
  bus: ConversationEventBus;
  rag: RagService | null;
  model: BaseChatModel | null;
  config: AppConfig;
  log: (event: string, meta: Record<string, unknown>) => void;
}

/**
 * QA business assembly: validates the audience, drives the ai-qa bounded flow through the
 * shared product store and the same trusted retrieval used by writing. It owns no second
 * checkpoint, no LangGraph and no engine switch.
 */
export class QaService {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private activeRuns = new Map<string, AbortController>();

  constructor(private readonly deps: QaServiceDeps) {}

  capabilities() {
    const enabled = !!(this.deps.model && this.deps.rag);
    return {
      enabled,
      reason: enabled
        ? undefined
        : !this.deps.model
          ? "尚未配置回答模型，请设置 AI_MODEL 与 AI_API_KEY"
          : "尚未配置知识检索，请设置 AI_EMBEDDING_MODEL 与 QDRANT_URL 并执行 pnpm ai:setup",
      retrieval: {
        contextTokenBudget: 12_000,
        maxEvidenceItems: 32,
        maxRepairRounds: 1,
        scopeLimits: { maxWorkspaces: 8, maxDocuments: 64, maxAllDocuments: 10_000 },
      },
      // QA never browses the web; missing evidence is reported, not auto-completed.
      webSearch: false as const,
      handoff: true as const,
    };
  }

  private ownerOf(audience: QaAudience): ConversationOwner {
    if (audience.kind === "internal")
      return {
        kind: "identity",
        tenantId: audience.principal.tenantId,
        identityId: audience.principal.identityId,
      };
    if (audience.internal)
      return {
        kind: "identity",
        tenantId: audience.tenantId,
        identityId: audience.internal.identityId,
        siteId: audience.siteId,
      };
    return {
      kind: "visitor",
      tenantId: audience.tenantId,
      visitorId: audience.visitorId,
      siteId: audience.siteId,
    };
  }

  private requireOwned(audience: QaAudience, conversation: ConversationRow): void {
    if (conversation.purpose !== "qa") throw new DomainError("NOT_FOUND", "会话不存在");
    if (
      conversation.tenantId !==
      (audience.kind === "internal" ? audience.principal.tenantId : audience.tenantId)
    )
      throw new DomainError("NOT_FOUND", "会话不存在");
    if (audience.kind === "internal") {
      if (conversation.identityId !== audience.principal.identityId || conversation.visitorId)
        throw new DomainError("NOT_FOUND", "会话不存在");
      if (conversation.siteId) throw new DomainError("NOT_FOUND", "会话不存在");
      return;
    }
    if (conversation.siteId !== audience.siteId) throw new DomainError("NOT_FOUND", "会话不存在");
    if (audience.internal) {
      if (conversation.identityId !== audience.internal.identityId || conversation.visitorId)
        throw new DomainError("NOT_FOUND", "会话不存在");
    } else if (conversation.visitorId !== audience.visitorId)
      throw new DomainError("NOT_FOUND", "会话不存在");
  }

  private defaultScope(): ScopeSelection {
    return { kind: "all" };
  }

  private retrievalScope(audience: QaAudience, selection: ScopeSelection): RetrievalScope {
    if (audience.kind === "internal")
      return { kind: "principal", principal: audience.principal, selection };
    if (selection.kind === "documents") {
      const allowed = new Set(audience.approved.map((a) => a.documentId));
      if (selection.documentIds.some((id) => !allowed.has(id)))
        throw new DomainError("AI_ACCESS_REVOKED", "所选资料不在本站点公开范围内");
      return {
        kind: "site",
        tenantId: audience.tenantId,
        approved: audience.approved,
        documentIds: selection.documentIds,
      };
    }
    return { kind: "site", tenantId: audience.tenantId, approved: audience.approved };
  }

  async createConversation(
    audience: QaAudience,
    input: { scope?: ScopeSelection; creationKey?: string } = {},
  ): Promise<ConversationRow> {
    const scope = input.scope ?? this.defaultScope();
    const { conversation } = await this.deps.store.createConversation({
      purpose: "qa",
      owner: this.ownerOf(audience),
      scope,
      creationKey: input.creationKey ?? null,
      configurationId: this.configurationId(),
      ttlMs: audience.kind === "site" ? 12 * 3_600_000 : undefined,
    });
    return conversation;
  }

  async listConversations(audience: QaAudience): Promise<ConversationRow[]> {
    return this.deps.store.listConversations(this.ownerOf(audience), "qa", {
      limit: audience.kind === "site" ? 10 : 20,
    });
  }

  async snapshot(
    audience: QaAudience,
    conversationId: string,
    page?: { before?: string; limit?: number },
  ) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(audience, conversation);
    return this.projectSnapshot(audience, await this.deps.store.snapshot(conversation, page));
  }

  private async projectSnapshot(
    audience: QaAudience,
    snapshot: ConversationSnapshot,
  ): Promise<ConversationSnapshot> {
    if (audience.kind !== "site") return snapshot;
    // Public projection: strip internal identities and unknown-source citations, keep allowed summaries.
    return {
      ...snapshot,
      conversation: { ...snapshot.conversation, siteId: audience.siteId },
      messages: snapshot.messages.map((message) => ({
        ...message,
        parts: message.parts.filter((part) => part.kind !== "artifact"),
      })),
    };
  }

  configurationId(): string {
    return `qa-${this.deps.config.AI_MODEL ?? "none"}`;
  }

  /** Accept a user message: one shared Run identity is returned (202). */
  async submitMessage(
    audience: QaAudience,
    conversationId: string,
    input: QaSubmitInput,
  ): Promise<{ runId: string }> {
    const store = this.deps.store;
    const conversation = await store.getConversation(audienceTenant(audience), conversationId);
    this.requireOwned(audience, conversation);
    const scope = input.scope ?? conversation.scopeSelection;
    if (audience.kind === "site") this.retrievalScope(audience, scope); // validates sub-scope now
    if (!this.deps.model || !this.deps.rag)
      throw new DomainError("SERVICE_UNAVAILABLE", this.capabilities().reason ?? "问答服务未启用");
    const context: QaRunContext = {
      contextRevision: conversation.contextRevision,
      configurationId: this.configurationId(),
      scope,
      retrieval: { contextTokenBudget: 12_000, maxEvidenceItems: 32, maxRepairRounds: 1 },
    };
    const admitted = await store.admitMessage(
      {
        conversation,
        purpose: "qa",
        expectedContextRevision: input.expectedContextRevision,
        clientMessageId: input.clientMessageId,
        idempotencyKey: input.idempotencyKey,
        parts: [{ kind: "text", text: input.text }],
        identityInput: { ...input },
        context,
      },
      {
        tenantRunningMax: this.deps.config.AI_MAX_CONCURRENT,
        ownerHourlyMax: 120,
        siteHourlyMax:
          audience.kind === "site"
            ? await this.siteQuota(conversation.tenantId, audience.siteId)
            : undefined,
      },
    );
    this.kick();
    return { runId: admitted.run.id };
  }

  /** qa-sites installs the per-site quota lookup; default keeps public traffic bounded. */
  siteQuota: (tenantId: string, siteId: string) => Promise<number> = async () => 120;

  async setScope(
    audience: QaAudience,
    conversationId: string,
    expectedContextRevision: number,
    scope: ScopeSelection,
  ) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(audience, conversation);
    if (audience.kind === "site") this.retrievalScope(audience, scope);
    const result = await this.deps.store.setScope(conversation, expectedContextRevision, scope);
    for (const runId of result.cancelledRunIds)
      this.activeRuns.get(runId)?.abort(new Error("CANCELLED"));
    return {
      contextRevision: result.conversation.contextRevision,
      scope: result.conversation.scopeSelection,
      cancelledRunIds: result.cancelledRunIds,
    };
  }

  async cancelRun(audience: QaAudience, conversationId: string, runId: string): Promise<Run> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(audience, conversation);
    const run = await this.deps.store.readRun(conversation.tenantId, runId);
    if (!run || run.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "任务不存在");
    this.activeRuns.get(runId)?.abort(new Error("CANCELLED"));
    return runDto(await this.deps.store.cancelRun(conversation.tenantId, runId));
  }

  async retryRun(
    audience: QaAudience,
    conversationId: string,
    runId: string,
  ): Promise<{ kind: "already-terminal" | "queued" | "redeliver-staged"; run: Run }> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(audience, conversation);
    const run = await this.deps.store.readRun(conversation.tenantId, runId);
    if (!run || run.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "任务不存在");
    const result = await this.deps.store.retryRun(conversation.tenantId, runId);
    this.kick();
    return { kind: result.kind, run: runDto(result.run) };
  }

  /**
   * Artifact read boundary for conversation owners: the full stored payload, kind untouched.
   * Public audiences use the projection method below instead.
   */
  async readArtifact(
    audience: QaAudience,
    conversationId: string,
    artifactId: string,
  ): Promise<Record<string, unknown>> {
    if (audience.kind !== "internal") throw new DomainError("FORBIDDEN", "公开读取请使用证据投影");
    const artifact = await this.loadOwnedArtifact(audience, conversationId, artifactId);
    if (artifact.kind === "evidence") return artifact.payload as EvidenceBundle;
    return (artifact.payload ?? {}) as Record<string, unknown>;
  }

  /**
   * Public projection of an evidence artifact for site visitors: approved titles, source
   * labels and capped quote excerpts only; never internal paths, workspace ids or full payloads.
   */
  async readPublicEvidence(
    audience: QaAudience,
    conversationId: string,
    artifactId: string,
  ): Promise<QaPublicEvidence> {
    if (audience.kind !== "site") throw new DomainError("FORBIDDEN", "证据投影仅面向站点访客");
    const artifact = await this.loadOwnedArtifact(audience, conversationId, artifactId);
    if (artifact.kind !== "evidence" || artifact.purpose !== "qa")
      throw new DomainError("NOT_FOUND", "产物不存在");
    const bundle = artifact.payload as EvidenceBundle;
    const allowed = new Set(audience.approved.map((a) => a.documentId));
    if (!bundle.sources.every((s) => s.sourceKind === "document" && allowed.has(s.documentId)))
      throw new DomainError("AI_ACCESS_REVOKED", "来源已不在公开范围");
    return {
      sources: bundle.sources.map((source) => ({
        sourceKind: "document" as const,
        title: source.sourceKind === "document" ? source.title : "",
        label: audience.approved.find(
          (a) => a.documentId === (source as { documentId?: string }).documentId,
        )?.publicLabel,
      })),
      items: bundle.items.map((item) => ({
        evidenceId: item.evidenceId,
        locator: item.locator,
        text: item.text.slice(0, 600),
      })),
    };
  }

  private async loadOwnedArtifact(
    audience: QaAudience,
    conversationId: string,
    artifactId: string,
  ): Promise<ArtifactRow> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(audience, conversation);
    const artifact = await this.deps.store.findArtifact(conversation.tenantId, artifactId);
    if (!artifact || artifact.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "产物不存在");
    return artifact;
  }

  /** QA → writing handoff with continuous re-authorization of every carried source. */
  async createWritingSession(
    audience: Extract<QaAudience, { kind: "internal" }>,
    conversationId: string,
    messageId: string,
    body: {
      artifactIds?: string[];
      instruction: string;
      intent?: HandoffCommand["intent"];
      targetDocumentId?: string | null;
      creationKey: string;
    },
    port: WritingHandoffPort,
  ) {
    const store = this.deps.store;
    const conversation = await store.getConversation(audience.principal.tenantId, conversationId);
    this.requireOwned(audience, conversation);
    const message = await store.readMessage(conversation.tenantId, messageId);
    if (!message || message.conversationId !== conversation.id || message.role !== "assistant")
      throw new DomainError("NOT_FOUND", "消息不存在");
    const artifactIds = new Set<string>(body.artifactIds ?? []);
    for (const part of message.parts)
      if (part.kind === "citation") artifactIds.add(part.citation.evidenceArtifactId);
    if (!artifactIds.size) throw new DomainError("VALIDATION_ERROR", "该回答没有可携带的资料引用");
    const bundles: EvidenceBundle[] = [];
    for (const artifactId of artifactIds) {
      const artifact = await store.findArtifact(conversation.tenantId, artifactId);
      if (!artifact || artifact.conversationId !== conversation.id || artifact.kind !== "evidence")
        throw new DomainError("NOT_FOUND", "资料已不可用");
      bundles.push(artifact.payload as EvidenceBundle);
    }
    const merged = mergeBundles(bundles);
    const scoped: RetrievalScope = {
      kind: "principal",
      principal: audience.principal,
      selection: { kind: "documents", documentIds: documentIdsOf(merged) },
    };
    if (!(await this.deps.rag!.verifyStoredEvidence(scoped, merged.items)))
      throw new DomainError("AI_ACCESS_REVOKED", "部分资料权限或版本已变化，请重新检索后再交接");
    return port.createFromHandoff({
      tenantId: conversation.tenantId,
      identityId: audience.principal.identityId,
      sourceConversationId: conversation.id,
      messageIds: [message.id],
      artifactIds: [...artifactIds],
      instruction: body.instruction,
      intent: body.intent,
      targetDocumentId: body.targetDocumentId ?? null,
      creationKey: body.creationKey,
    });
  }

  /** Same-event-envelope stream shared with writing and the public entry. */
  async streamEvents(
    audience: QaAudience,
    conversationId: string,
    cursor: string,
    sse: SseHandle,
    signal: AbortSignal,
  ): Promise<void> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(audience, conversation);
    await streamConversation(this.deps.store, this.deps.bus, conversation, cursor, sse, signal);
  }

  // ---------------------------------------------------------------- dispatch

  start() {
    if (this.controller) return;
    this.controller = new AbortController();
    const loop = async () => {
      while (this.controller && !this.controller.signal.aborted) {
        const processed = await this.drainOnce().catch((error) => {
          this.deps.log("qa_dispatch_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
        await new Promise((r) => setTimeout(r, processed ? 50 : 400));
      }
    };
    this.running = loop();
  }

  async stop() {
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  private kick() {
    if (!this.controller) return;
    this.timer = setTimeout(() => void this.drainOnce().catch(() => undefined), 50);
    this.timer.unref();
  }

  private async drainOnce(): Promise<boolean> {
    if (!this.controller || this.activeRuns.size >= this.deps.config.AI_MAX_CONCURRENT)
      return false;
    if (!this.deps.model || !this.deps.rag) return false;
    const claimed = await this.deps.store.claimNext("qa", this.deps.config.AI_TIMEOUT_MS + 30_000);
    if (!claimed) return false;
    void this.executeAttempt(claimed.conversation, claimed.run);
    return true;
  }

  private async executeAttempt(conversation: ConversationRow, run: RunRow): Promise<void> {
    const store = this.deps.store;
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("DEADLINE")),
      this.deps.config.AI_TIMEOUT_MS,
    );
    try {
      const audience = await this.audienceFor(conversation);
      const context = run.context as QaRunContext;
      const userMessage = await store.userMessageForRun(run.tenantId, run.id, run.conversationId);
      const question = userMessage?.parts.find((p) => p.kind === "text")?.text ?? "";
      if (!question) throw new QaFlowError("INVALID_OUTPUT");
      const history = await this.buildAllowedHistory(audience, conversation, run);
      const scope = this.retrievalScope(audience, context.scope);
      const model = this.deps.model!;
      const rag = this.deps.rag!;
      const adapter: QaGenerateAdapter = createQaGenerateAdapter(model);
      let bundle: EvidenceBundle = { sources: [], items: [], freshness: "current" };
      let evidenceArtifactId: string | undefined;
      const steps: {
        stepId: string;
        status: "pending" | "running" | "done" | "failed";
        updatedAt: string;
      }[] = [];
      const persistStep = async (stepId: string, status: "running" | "done") => {
        steps.push({ stepId, status, updatedAt: new Date().toISOString() });
        const execution = {
          evidenceRefs: [],
          steps,
          evidenceArtifactIds: evidenceArtifactId ? [evidenceArtifactId] : [],
        } as QaOutcomeExecution;
        const written = await store.writeExecution({ run, owner: store.instanceId, execution });
        if (!written) throw new QaFlowError("LEASE_LOST");
        const fresh = await store.readRun(run.tenantId, run.id);
        if (fresh?.cancelRequested) controller.abort(new Error("CANCELLED"));
      };
      const ports: QaFlowPorts = {
        onStep: async (stepId, status) => {
          if (status === "done") await persistStep(stepId, status);
        },
        retrieve: async ({ query, tokenBudget, signal }) => {
          const result = await rag.retrieve(scope, query, tokenBudget, signal);
          bundle = result.evidence;
          return bundle;
        },
        registerEvidence: async ({ bundle: provided, stepId, signal }) => {
          signal.throwIfAborted();
          const validated = validateEvidenceBundle(provided);
          if (!validated.success) throw new QaFlowError("INVALID_CITATION");
          const registered = await store.registerArtifact({
            run,
            owner: store.instanceId,
            producerCallId: `step:${stepId}:${run.attempt}`,
            resultIndex: 0,
            kind: "evidence",
            schemaVersion: 1,
            payload: provided,
            evidenceIds: provided.items.map((item) => item.evidenceId),
            trackEvidence: true,
          });
          evidenceArtifactId = registered.artifact.id;
          return {
            evidenceArtifactId: registered.artifact.id,
            evidenceRefs: refsOf(provided, registered.artifact.id),
          };
        },
        generate: async ({ query, history: turns, evidence, repairFeedback, signal }) => {
          if (!model) throw new QaFlowError("MODEL_FAILED");
          return adapter.generate({
            question,
            query,
            history: turns,
            evidenceJson: JSON.stringify(evidenceJson(evidence)),
            ...(repairFeedback ? { repairFeedback } : {}),
            signal,
          });
        },
        verifyEvidence: async ({ bundle: provided, signal }) => {
          signal.throwIfAborted();
          return rag.verifyStoredEvidence(scope, provided.items);
        },
        stage: async ({ answer, signal }) => {
          signal.throwIfAborted();
          await store.stageAssistantMessage(run, store.instanceId, answerParts(answer));
        },
      };
      const resume = await this.resumeState(run, store);
      const outcome = await runQaAnswerFlow(ports, {
        runId: run.id,
        conversationId: conversation.id,
        question,
        history,
        scope: context.scope,
        retrieval: context.retrieval,
        signal: controller.signal,
        attempt: run.attempt,
        ...(resume ? { resume } : {}),
      });
      const written = await store.commitRunOutput({
        run,
        owner: store.instanceId,
        status: "completed",
        assistantParts: answerParts(outcome.answer),
        execution: {
          evidenceRefs: outcome.evidenceRefs,
          steps: outcome.steps.map((step) => ({
            stepId: step.stepId,
            status: "done",
            updatedAt: new Date().toISOString(),
          })),
          evidenceArtifactIds: outcome.evidenceArtifactId ? [outcome.evidenceArtifactId] : [],
          stagedMessageId: undefined,
          repairRounds: undefined,
        },
      });
      this.deps.bus.wake(conversationKey(conversation));
      void written;
    } catch (error) {
      await this.finishFailure(conversation, run, error, controller.signal.aborted);
    } finally {
      clearTimeout(deadline);
      this.activeRuns.delete(run.id);
    }
  }

  private async finishFailure(
    conversation: ConversationRow,
    run: RunRow,
    error: unknown,
    aborted: boolean,
  ) {
    const store = this.deps.store;
    const code =
      error instanceof QaFlowError
        ? error.code === "LEASE_LOST"
          ? undefined
          : error.code
        : aborted
          ? "CANCELLED"
          : error instanceof DomainError
            ? error.code === "AI_ACCESS_REVOKED"
              ? "ACCESS_REVOKED"
              : error.code === "SERVICE_UNAVAILABLE"
                ? "KNOWLEDGE_NOT_READY"
                : "MODEL_FAILED"
            : "MODEL_FAILED";
    if (code === undefined) return; // lease lost: maintain() finalizes as interrupted
    const status =
      code === "CANCELLED" ? "cancelled" : code === "OUTPUT_UNKNOWN" ? "interrupted" : "failed";
    try {
      await store.commitRunOutput({ run, owner: store.instanceId, status, errorCode: code });
    } catch {
      await store
        .commitRunOutput({
          run,
          owner: store.instanceId,
          status: "interrupted",
          errorCode: "OUTPUT_UNKNOWN",
        })
        .catch(() => undefined);
    }
    this.deps.bus.wake(conversationKey(conversation));
  }

  /** Committed staged output from a prior attempt is re-delivered without regenerating. */
  private async resumeState(
    run: RunRow,
    store: AiService,
  ): Promise<Partial<import("@zhishu/ai-qa").QaRunInput["resume"]> | undefined> {
    const execution = run.execution as {
      evidenceArtifactIds?: string[];
      stagedMessageId?: string;
    } | null;
    const committed = await store.listArtifacts(run.tenantId, run.conversationId, 200);
    const evidenceArtifacts = committed
      .filter((artifact) => artifact.runId === run.id && artifact.kind === "evidence")
      .toReversed();
    const latest = evidenceArtifacts.find((artifact) =>
      execution?.evidenceArtifactIds?.includes(artifact.id),
    );
    if (!latest) return undefined;
    const bundle = latest.payload as EvidenceBundle;
    const stagedRow = execution?.stagedMessageId
      ? await store.readMessage(run.tenantId, execution.stagedMessageId)
      : undefined;
    const answer =
      stagedRow && stagedRow.state === "staged" ? stagedAnswer(stagedRow.parts) : undefined;
    return {
      evidence: { bundle, evidenceArtifactId: latest.id },
      ...(answer ? { staged: { answer } } : {}),
    };
  }

  /** Allowed history rebuild: revocation-aware so old evidence cannot leak into context. */
  private async buildAllowedHistory(
    audience: QaAudience,
    conversation: ConversationRow,
    run: RunRow,
  ): Promise<{ role: "user" | "assistant"; text: string }[]> {
    const store = this.deps.store;
    const messages = await store.listCommittedMessages(conversation.tenantId, conversation.id, 40);
    const beforeRun = messages.filter((m) => m.createdAt < run.createdAt && m.runId !== run.id);
    const turns: { role: "user" | "assistant"; text: string }[] = [];
    let bytes = 0;
    for (const message of beforeRun.toReversed()) {
      if (turns.length >= HISTORY_LIMIT) break;
      const text = message.parts
        .filter((p) => p.kind === "text")
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      if (message.role === "assistant") {
        const citations = message.parts
          .filter((p) => p.kind === "citation")
          .map((p) => (p.kind === "citation" ? p.citation : undefined)) as (Citation | undefined)[];
        const artifactIds = [
          ...new Set(citations.filter(Boolean).map((c) => c!.evidenceArtifactId)),
        ];
        let allowed = true;
        for (const artifactId of artifactIds) {
          const artifact = await store.findArtifact(conversation.tenantId, artifactId);
          if (!artifact || artifact.state !== "committed") {
            allowed = false;
            break;
          }
          const bundle = artifact.payload as EvidenceBundle;
          const citedItems = bundle.items.filter((item) =>
            citations.some((c) => c && c.evidenceId === item.evidenceId),
          );
          const scope =
            audience.kind === "internal"
              ? ({
                  kind: "principal",
                  principal: audience.principal,
                  selection: { kind: "documents", documentIds: documentIdsOf(bundle) },
                } as RetrievalScope)
              : ({
                  kind: "site",
                  tenantId: audience.tenantId,
                  approved: audience.approved,
                  documentIds: documentIdsOf(bundle),
                } as RetrievalScope);
          if (!(await this.deps.rag!.verifyStoredEvidence(scope, citedItems))) {
            allowed = false;
            break;
          }
        }
        if (!allowed) continue;
      }
      bytes += Buffer.byteLength(text);
      if (bytes > HISTORY_BYTE_LIMIT) break;
      turns.unshift({ role: message.role, text });
    }
    return turns;
  }

  /** Reconstruct the execution audience for a claimed conversation. */
  private async audienceFor(conversation: ConversationRow): Promise<QaAudience> {
    if (conversation.identityId) {
      return {
        kind: "internal",
        principal: {
          tenantId: conversation.tenantId,
          identityId: conversation.identityId,
          username: conversation.identityId,
          displayName: "",
          email: "",
          globalRoles: [],
          active: true,
        },
      };
    }
    if (!conversation.siteId || !conversation.visitorId)
      throw new DomainError("AI_ACCESS_REVOKED", "访客会话缺少站点上下文");
    // Public attempts refresh the approved set through qa-sites before execution.
    const approved = await this.siteApproved(conversation);
    return {
      kind: "site",
      tenantId: conversation.tenantId,
      siteId: conversation.siteId,
      visitorId: conversation.visitorId,
      approved,
    };
  }

  /** qa-sites keeps the live approval resolver in place before registering the service. */
  siteApproved: (
    conversation: ConversationRow,
  ) => Promise<readonly { documentId: string; workspaceId: string; publicLabel: string }[]> =
    async () => {
      throw new DomainError("AI_ACCESS_REVOKED", "公开问答站点未注册");
    };

  /** Root assembly injects the writing handoff after both modules exist. */
  handoffPort!: WritingHandoffPort;
}

type QaOutcomeExecution = import("@zhishu/ai-contracts").QaExecution;

function audienceTenant(audience: QaAudience): string {
  return audience.kind === "internal" ? audience.principal.tenantId : audience.tenantId;
}

function documentIdsOf(bundle: EvidenceBundle): string[] {
  return [...new Set(bundle.items.map((i) => i.sourceId))];
}

function mergeBundles(bundles: EvidenceBundle[]): EvidenceBundle {
  const sources = new Map<string, EvidenceBundle["sources"][number]>();
  const items = [];
  for (const bundle of bundles) {
    for (const source of bundle.sources)
      sources.set(`${source.sourceId}\u0000${source.snapshotId}`, source);
    items.push(...bundle.items);
  }
  const merged = { sources: [...sources.values()], items, freshness: "current" as const };
  if (!validateEvidenceBundle(merged).success) throw new DomainError("CONFLICT", "资料组合不合法");
  return merged;
}

function refsOf(bundle: EvidenceBundle, artifactId: string): EvidenceRef[] {
  return bundle.items.map((item) => ({
    evidenceArtifactId: artifactId,
    evidenceId: item.evidenceId,
  }));
}

function evidenceJson(bundle: EvidenceBundle) {
  return {
    sources: bundle.sources.map((s) => ({
      sourceId: s.sourceId,
      snapshotId: s.snapshotId,
      sourceKind: s.sourceKind,
      title: s.title,
      ...(s.sourceKind === "web" ? { url: s.canonicalUrl, contentKind: s.contentKind } : {}),
    })),
    items: bundle.items.map((i) => ({ evidenceId: i.evidenceId, text: i.text })),
  };
}

export function answerParts(answer: {
  status: string;
  text: string;
  citations: Citation[];
}): MessagePart[] {
  const parts: MessagePart[] = [{ kind: "text", text: answer.text }];
  for (const citation of answer.citations) parts.push({ kind: "citation", citation });
  return parts;
}

function stagedAnswer(parts: MessagePart[]): import("@zhishu/ai-contracts").QaAnswer | undefined {
  const text = parts.find((p) => p.kind === "text");
  const citations = parts
    .filter((p) => p.kind === "citation")
    .map((p) => (p.kind === "citation" ? p.citation : undefined)) as Citation[];
  if (!text || text.kind !== "text") return undefined;
  return {
    status: citations.length ? "answered" : "insufficient-evidence",
    text: text.text,
    citations,
    ...(citations[0] ? { evidenceArtifactId: citations[0].evidenceArtifactId } : {}),
  };
}
