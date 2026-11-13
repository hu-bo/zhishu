import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import {
  createWritingRuntime,
  installImage,
  installPlatformResearch,
  installWebResearch,
  installWriting,
  WritingRuntimeError,
  type ImagePorts,
  type NativeWritingSession,
  type PlatformResearchPorts,
  type WebResearchPorts,
  type WritingRuntime,
  type WritingSessionAccess,
  type WritingTurnHost,
  type WritingTurnRequest,
  type WritingTurnResult,
} from "@zhishu/ai-writing";
import {
  createLaunchEnvironmentSnapshot,
  PiAiProvider,
  type Agent,
  type Context,
  type LlmAdapter,
  type PluginRecord,
} from "@zhishu/ai-writing/kernel";
import type { WebSearchPort } from "@zhishu/ai-writing/contracts";
import type {
  DocumentSnapshot,
  OperationBatch,
  StructureReceipt,
} from "@zhishu/document-contracts";
import { documents, identityProfiles } from "../../../database/schema/index.js";
import {
  DEFAULT_GENERATION_LIMITS,
  validateEvidenceBundle,
  validateWritingRequest,
  type EvidenceBundle,
  type EvidenceItem,
  type EvidenceSource,
  type ProposalApplicationState,
  type ProposalReview,
  type ScopeSelection,
  type WritingApproval,
  type WritingExecution,
  type WritingProposalPayload,
  type WritingRequest,
  type WritingRunContext,
} from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-contracts/hash";
import type { MessagePart, PreviewFrame } from "@zhishu/chat-contracts";
import type { AppConfig } from "../../config.js";
import { DomainError } from "../../shared/domain-error.js";
import type { Database } from "../../../database/index.js";
import {
  conversationKey,
  DEFAULT_OWNER_HOURLY_MAX,
  DispatchLoop,
  failureRunStatus,
  mergeEvidenceBundles,
  runDto,
  streamConversation,
  type AiService,
  type ConversationEventBus,
  type ConversationRow,
  type DomainFailureMap,
  type HandoffCommand,
  type RunRow,
  type SseHandle,
  type WritingHandoffPort,
} from "../ai/index.js";
import type { CollaborationOwner, DocumentWriteTransaction } from "../collaboration/owner.js";
import { documentActionSql } from "../authorization/document-access.js";
import type { PermissionAction } from "../authorization/policy.js";
import type { RagService, RetrievalScope } from "../rag/rag.service.js";
import type { Principal } from "../identity/identity.types.js";
import { WritingImages } from "./writing.images.js";
import {
  nativeSessionIdFor,
  parseNativeSessionId,
  postgresNativeSessionPersistence,
} from "./writing.native.js";
import { createTavilyPort } from "./writing.tavily.js";

/** Run-scoped state shared by tools installed once per attached session. */
interface TurnToolState {
  conversation: ConversationRow;
  run: RunRow;
  principal: Principal;
  bundles: EvidenceBundle[];
  artifactIdByEvidence: Map<string, string>;
  webSources: Map<string, Extract<EvidenceSource, { sourceKind: "web" }>>;
  proposalArtifactIds: string[];
  leaseOwner: string;
  context: WritingRunContext;
  image: { ports: ImagePorts } | undefined;
}

export interface WritingServiceDeps {
  store: AiService;
  bus: ConversationEventBus;
  db: Database;
  pool: Pool;
  rag: RagService | null;
  owner: CollaborationOwner;
  images: WritingImages;
  config: AppConfig;
  log: (event: string, meta: Record<string, unknown>) => void;
}

const webSearchLimits = {
  resultsPerCall: DEFAULT_GENERATION_LIMITS.webSearchResultsPerCall,
  extractMaxBytes: DEFAULT_GENERATION_LIMITS.webExtractMaxBytes,
  timeoutMs: 30_000,
};

/**
 * Writing business assembly. ai-writing's runtime drives the official DSH kernel; every
 * product state transition (Run, messages, approvals, evidence/draft/proposal/image
 * artifacts, events) goes through the shared AiService. Proposals apply to documents only
 * through the collaboration structure channel with a durable receipt recorded in the same
 * transaction as the body change.
 */
export class WritingService {
  private runtime?: Promise<WritingRuntime>;
  /** Cached native handles keyed by nativeSessionId; eviction notifies via onSessionDetached. */
  private sessions = new Map<string, Promise<NativeWritingSession>>();
  /** Live SSE observers per conversation; observed sessions are retained against idle eviction. */
  private observers = new Map<string, number>();
  private turnStates = new Map<string, TurnToolState>();
  private previews = new Map<string, PreviewFrame[]>();
  private activeRuns = new Map<string, AbortController>();
  private readonly dispatch: DispatchLoop;
  /** Test seam: hosts may inject a deterministic LLM adapter like the smoke scripts do. */
  adapter?: LlmAdapter;

  constructor(private readonly deps: WritingServiceDeps) {
    this.dispatch = new DispatchLoop(() => this.drainOnce(), deps.log, "writing");
  }

  configurationId(): string {
    const c = this.deps.config;
    return hashContent([
      "writing-v2",
      c.AI_MODEL ?? "none",
      c.AI_BASE_URL ?? "",
      c.AI_API_FORMAT ?? "",
      c.AI_THINKING ?? "",
      c.AI_REASONING_EFFORT ?? "",
      this.webAvailable() ? "web" : "noweb",
      this.deps.images.capability().available ? "image" : "noimage",
    ]).slice(7, 39);
  }

  webAvailable(): boolean {
    return !!this.deps.config.TAVILY_API_KEY;
  }

  capabilities() {
    const image = this.deps.images.capability();
    const enabled = !!(this.deps.config.AI_MODEL && this.deps.config.AI_API_KEY);
    return {
      enabled,
      engine: "dsh-native-v1" as const,
      reason: enabled ? undefined : "尚未配置写作模型，请设置 AI_MODEL 与 AI_API_KEY",
      image: { available: image.available, reason: image.reason },
      webSearchAvailable: this.webAvailable(),
      webSearchLimits: this.webAvailable()
        ? {
            searchCallsPerRun: DEFAULT_GENERATION_LIMITS.webSearchCallsPerRun,
            resultsPerSearch: DEFAULT_GENERATION_LIMITS.webSearchResultsPerCall,
            readPagesPerRun: DEFAULT_GENERATION_LIMITS.webReadPagesPerRun,
          }
        : undefined,
      configurationId: this.configurationId(),
    };
  }

  private requireEnabled(): void {
    if (!this.capabilities().enabled)
      throw new DomainError("SERVICE_UNAVAILABLE", this.capabilities().reason ?? "写作服务未启用");
  }

  private initRuntime(): Promise<WritingRuntime> {
    this.runtime ??= createWritingRuntime({
      persistence: "required",
      agentOptions: {
        provider: "writing",
        model: this.deps.config.AI_MODEL ?? "test",
        maxTokens: 4096,
      },
      configurationId: this.configurationId(),
      limits: {
        maxSessions: this.sessionCapacity(),
        sessionIdleMs: this.deps.config.AI_SESSION_IDLE_MS,
        maxModelCalls: DEFAULT_GENERATION_LIMITS.maxModelCalls,
        maxInputBytes: 128_000,
        maxOutputBytes: DEFAULT_GENERATION_LIMITS.maxOutputBytes,
      },
      retainSession: (nativeSessionId) => {
        const parsed = parseNativeSessionId(nativeSessionId);
        return !!parsed && (this.observers.get(parsed.conversationId) ?? 0) > 0;
      },
      onSessionDetached: (nativeSessionId) => {
        this.sessions.delete(nativeSessionId);
      },
      configure: (ctx) => this.configureKernel(ctx),
      setup: (ctx, agent, access) => this.installTurnTools(ctx, agent, access),
      resultText: (records, turnText) => this.trustedResultText(records, turnText),
    }).catch((error: unknown) => {
      this.runtime = undefined;
      throw error;
    });
    return this.runtime;
  }

  /** Each native Session owns dedicated writer connections; keep the shared pool headroom. */
  private sessionCapacity(): number {
    const capacity = Math.min(
      this.deps.config.AI_MAX_CONCURRENT * 2,
      Math.floor(((this.deps.pool.options.max ?? 10) - 2) / 2),
    );
    if (capacity < 1)
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "数据库连接额度不足，请增加连接池或降低 AI 并发配置",
      );
    return capacity;
  }

  private async configureKernel(ctx: Context): Promise<void> {
    await ctx.plugin(
      postgresNativeSessionPersistence(this.deps.pool, (sessionId, error) => {
        this.deps.log("writing_native_append_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
    if (this.adapter) {
      ctx.llm.registerAdapter(["writing"], this.adapter);
      return;
    }
    const c = this.deps.config;
    ctx.provide(
      "launchEnvironment",
      createLaunchEnvironmentSnapshot([
        { source: "process", values: { AI_API_KEY: c.AI_API_KEY ?? "" } },
      ]),
    );
    const anthropic =
      (c.AI_API_FORMAT ?? (c.AI_BASE_URL?.includes("/anthropic") ? "anthropic" : "openai")) ===
      "anthropic";
    const reasoning = c.AI_THINKING === "disabled" ? undefined : c.AI_REASONING_EFFORT;
    await ctx.plugin(PiAiProvider, {
      providers: {
        writing: {
          apiKeyEnv: "AI_API_KEY",
          api: anthropic ? "anthropic-messages" : "openai-completions",
          baseURL:
            c.AI_BASE_URL ??
            (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
          models: [
            {
              id: c.AI_MODEL!,
              contextWindow: 65536,
              maxTokens: 4096,
              input: ["text"],
              ...(reasoning ? { reasoningEfforts: { off: null, [reasoning]: reasoning } } : {}),
              ...(anthropic && c.AI_THINKING === "adaptive"
                ? { compat: { forceAdaptiveThinking: true } }
                : {}),
            },
          ],
          timeoutMs: c.AI_TIMEOUT_MS,
          retryPolicy: { mode: "normal", maxRetries: 0 },
          reasoning: c.AI_THINKING === "disabled" ? "off" : c.AI_REASONING_EFFORT,
        },
      },
    });
  }

  private trustedResultText(records: readonly PluginRecord[], turnText: string): string {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record?.type === "plugin:zhishu/writing") {
        const payload = record.data as WritingProposalPayload;
        return payload.summary || "文章草稿已生成，等待确认。";
      }
    }
    return turnText;
  }

  // ------------------------------------------------------------- tool assembly

  /** Tools are installed once per attach; they resolve the active turn through access. */
  private installTurnTools(ctx: Context, agent: Agent, access: WritingSessionAccess): void {
    void agent;
    const state = () => this.turnStates.get(access.conversationId);
    ctx.systemPrompt.section({
      name: "writing-host",
      order: 5,
      text: "有目标文档时按写作意图交付提案；无目标文档时直接输出草稿文本。需要资料时使用 search_platform / read_platform_source（平台资料），联网能力开放时使用 web_search / read_web_source。",
    });
    const platformPorts: PlatformResearchPorts = {
      search: async (query, signal) => {
        const current = state();
        if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        const bundle = await this.retrievePlatformEvidence(current, query, signal);
        return bundle.sources;
      },
      read: async (sourceId, signal) => {
        const current = state();
        if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        const bundle = await this.retrievePlatformEvidence(current, sourceId, signal, [sourceId]);
        return bundle.items;
      },
      register: async (items, toolCallId, signal) => {
        const current = state();
        if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        await this.registerEvidenceItems(current, items, [], `tool:${toolCallId}`, signal);
      },
      reserve: async (kind, signal) => {
        const current = state();
        if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        await this.reserveUsage(
          current,
          kind === "search" ? { searchCalls: 1 } : { sourceReads: 1 },
          signal,
        );
      },
    };
    installPlatformResearch(ctx, platformPorts);
    const web = this.tavilyPort();
    if (web) {
      const webPorts: WebResearchPorts = {
        enabled: () => state()?.context.webSearch === true,
        reserve: async (kind, signal) => {
          const current = state();
          if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
          await this.reserveUsage(
            current,
            kind === "search" ? { webSearchCalls: 1 } : { webReadCalls: 1 },
            signal,
          );
        },
        register: async (partial, toolCallId, signal) => {
          const current = state();
          if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
          for (const source of partial.sources)
            if (source.sourceKind === "web") current.webSources.set(source.sourceId, source);
          await this.registerEvidenceItems(
            current,
            partial.items,
            partial.sources,
            `tool:${toolCallId}`,
            signal,
          );
        },
        knownSource: (sourceId) => state()?.webSources.get(sourceId),
        budget: {
          maxSearchCalls: DEFAULT_GENERATION_LIMITS.webSearchCallsPerRun,
          maxResultsPerSearch: DEFAULT_GENERATION_LIMITS.webSearchResultsPerCall,
          maxReadPages: DEFAULT_GENERATION_LIMITS.webReadPagesPerRun,
          maxSnippetChars: 2_000,
          maxExtractChars: 24_000,
          timeoutMs: webSearchLimits.timeoutMs,
        },
        now: () => new Date().toISOString(),
      };
      installWebResearch(ctx, webPorts, web);
    }
    installImage(ctx, {
      load: async (key) => state()?.image?.ports.load(key),
      save: async (key, job) => {
        const current = state();
        if (!current?.image) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        await current.image.ports.save(key, job);
        if (job.status === "ready") {
          const toolCallId = key.slice(key.indexOf(":") + 1);
          const registered = await this.deps.store.registerArtifact({
            run: current.run,
            owner: current.leaseOwner,
            producerCallId: `tool:${toolCallId}`,
            resultIndex: 0,
            kind: "image",
            schemaVersion: 1,
            payload: { jobId: key, assetId: job.assets[0]?.assetId ?? null, status: job.status },
            evidenceIds: [],
          });
          current.run = registered.run;
        }
      },
      reserve: async (key, signal) => state()?.image?.ports.reserve(key, signal),
      provider: {
        create: async (input, signal) => {
          const ports = state()?.image?.ports;
          if (!ports?.provider) throw new DomainError("SERVICE_UNAVAILABLE", "图片服务尚未配置");
          return ports.provider.create(input, signal);
        },
        poll: async (jobId, signal) => {
          const ports = state()?.image?.ports;
          if (!ports?.provider) throw new DomainError("SERVICE_UNAVAILABLE", "图片服务尚未配置");
          return ports.provider.poll(jobId, signal);
        },
      },
      store: async (key, image, signal) => {
        const ports = state()?.image?.ports;
        if (!ports) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        return ports.store(key, image, signal);
      },
    });
    installWriting(ctx, {
      access,
      buildInput: async () => this.buildWritingInput(access),
      evidence: () => mergeEvidenceBundles(state()?.bundles ?? []),
      artifactOf: (evidenceId) => state()?.artifactIdByEvidence.get(evidenceId),
      verify: async (signal) => {
        const current = state();
        if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        await this.verifyTurnAccess(current, signal, true);
      },
      save: async (proposal, callId, signal) => {
        const current = state();
        if (!current) throw new WritingRuntimeError("NO_ACTIVE_RUN");
        signal.throwIfAborted();
        const registered = await this.deps.store.registerArtifact({
          run: current.run,
          owner: current.leaseOwner,
          producerCallId: `tool:${callId}`,
          resultIndex: 0,
          kind: "proposal",
          schemaVersion: 1,
          payload: proposal,
          evidenceIds: [...new Set(proposal.citations.map((citation) => citation.evidenceId))],
          applicationState: "pending",
        });
        current.proposalArtifactIds.push(registered.artifact.id);
        current.run = registered.run;
        await this.persistExecution(current, {
          proposalArtifactIds: current.proposalArtifactIds,
        });
      },
      systemInstruction: "",
    });
  }

  private tavilyPort(): WebSearchPort | null {
    if (!this.webAvailable()) return null;
    return createTavilyPort(this.deps.config, {
      resultsPerCall: webSearchLimits.resultsPerCall,
      extractMaxBytes: webSearchLimits.extractMaxBytes,
      timeoutMs: webSearchLimits.timeoutMs,
    });
  }

  private async retrievePlatformEvidence(
    state: TurnToolState,
    query: string,
    signal: AbortSignal,
    sourceIds?: readonly string[],
  ): Promise<EvidenceBundle> {
    if (!this.deps.rag) throw new DomainError("SERVICE_UNAVAILABLE", "知识检索尚未配置");
    const selection: ScopeSelection = sourceIds?.length
      ? { kind: "documents", documentIds: [...sourceIds] }
      : ((state.context.scope ?? state.conversation.scopeSelection) as ScopeSelection);
    const scope: RetrievalScope = { kind: "principal", principal: state.principal, selection };
    const { evidence } = await this.deps.rag.retrieve(scope, query, 8_000, signal);
    return evidence;
  }

  private async registerEvidenceItems(
    state: TurnToolState,
    items: readonly EvidenceItem[],
    sources: readonly EvidenceSource[],
    producerCallId: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!items.length) return;
    const bundle: EvidenceBundle = {
      sources: sources.length
        ? [...sources]
        : mergeEvidenceBundles(state.bundles).sources.filter((source) =>
            items.some(
              (item) => item.sourceId === source.sourceId && item.snapshotId === source.snapshotId,
            ),
          ),
      items: [...items],
      freshness: "current",
    };
    if (!validateEvidenceBundle(bundle).success) throw new WritingRuntimeError("INVALID_CITATION");
    const registered = await this.deps.store.registerArtifact({
      run: state.run,
      owner: state.leaseOwner,
      producerCallId,
      resultIndex: 0,
      kind: "evidence",
      schemaVersion: 1,
      payload: bundle,
      evidenceIds: items.map((item) => item.evidenceId),
      trackEvidence: true,
    });
    // The ledger fold changed the row; keep the in-memory run current so later
    // fenced execution writes never revert it to a stale base.
    state.run = registered.run;
    for (const item of items)
      state.artifactIdByEvidence.set(item.evidenceId, registered.artifact.id);
    state.bundles.push(bundle);
  }

  private async reserveUsage(
    state: TurnToolState,
    delta: Partial<import("@zhishu/ai-contracts").RunUsage>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const written = await this.deps.store.writeExecution({
      run: state.run,
      owner: state.leaseOwner,
      reserve: { ...delta, modelCalls: delta.modelCalls ?? 0 },
      limits: DEFAULT_GENERATION_LIMITS,
      emitEvent: false,
      renewLeaseMs: this.deps.config.AI_TIMEOUT_MS + 30_000,
    });
    if (!written) throw new WritingRuntimeError("PERSISTENCE_FAILED");
    state.run = written;
  }

  private async verifyTurnAccess(
    state: TurnToolState,
    signal: AbortSignal,
    requireWrite: boolean,
  ): Promise<void> {
    signal.throwIfAborted();
    const conversation = await this.deps.store.getConversation(
      state.conversation.tenantId,
      state.conversation.id,
    );
    if (conversation.contextRevision !== state.run.context.contextRevision)
      throw new WritingRuntimeError("CONTEXT_CHANGED");
    if (conversation.status !== "active")
      throw new DomainError("AI_ACCESS_REVOKED", "会话不可继续");
    const documentId = state.context.capture?.document.documentId;
    if (documentId)
      await this.assertDocumentAccess(
        state.principal,
        documentId,
        requireWrite ? ["write", "ai"] : ["ai"],
      );
  }

  /** Live editor snapshot at generation time; the proposal binds the version it saw. */
  private async buildWritingInput(access: WritingSessionAccess) {
    const state = this.turnStates.get(access.conversationId);
    const turn = access.currentTurn();
    if (!state || !turn) return;
    const context = state.context;
    if (!context.capture || !context.request) return;
    const documentId = context.capture.document.documentId;
    const current = await this.deps.owner.snapshot(state.principal, documentId);
    const capture = {
      document: {
        documentId,
        generationId: current.snapshot.generationId,
        durableSeq: current.snapshot.durableSeq,
        contentHash: hashContent(current.snapshot.content),
      },
      structureRevision: current.structureRevision,
    };
    const target =
      context.request.target.kind === "blocks"
        ? {
            ...context.request.target,
            blocks: context.request.target.blocks.flatMap((entry) => {
              const block = current.snapshot.content.content.find(
                (candidate) => candidate.attrs.blockId === entry.blockId,
              );
              return block
                ? [
                    {
                      blockId: entry.blockId,
                      contentHash: hashContent(block),
                    },
                  ]
                : [];
            }),
          }
        : context.request.target.kind === "document-end"
          ? {
              ...context.request.target,
              afterBlockId: current.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
            }
          : context.request.target;
    return {
      threadId: state.conversation.id,
      runId: state.run.id,
      document: capture.document,
      baseStructureRevision: capture.structureRevision,
      request: { ...context.request, target },
      snapshot: current.snapshot,
      evidence: mergeEvidenceBundles(state.bundles),
      prompt: { id: "writing", version: "2", systemInstruction: "" },
    };
  }

  // ------------------------------------------------------------- conversations

  async createConversation(
    principal: Principal,
    input: { targetDocumentId?: string | null; scope?: ScopeSelection; creationKey?: string } = {},
  ): Promise<ConversationRow> {
    this.requireEnabled();
    if (input.targetDocumentId)
      await this.assertDocumentAccess(principal, input.targetDocumentId, ["ai"]);
    const { conversation } = await this.deps.store.createConversation({
      purpose: "writing",
      owner: { kind: "identity", tenantId: principal.tenantId, identityId: principal.identityId },
      scope: input.scope ?? { kind: "all" },
      targetDocumentId: input.targetDocumentId ?? null,
      configurationId: this.configurationId(),
      creationKey: input.creationKey ?? null,
    });
    return conversation;
  }

  async assertDocumentAccess(
    principal: Principal,
    documentId: string,
    actions: PermissionAction[],
  ): Promise<void> {
    for (const action of actions) {
      const rows = await this.deps.db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.id, documentId),
            eq(documents.status, "active"),
            documentActionSql(principal, action),
          ),
        )
        .limit(1);
      if (!rows.length) throw new DomainError("AI_ACCESS_REVOKED", `没有该文档的 ${action} 权限`);
    }
  }

  async listConversations(principal: Principal, targetDocumentId?: string) {
    return this.deps.store.listConversations(
      { kind: "identity", tenantId: principal.tenantId, identityId: principal.identityId },
      "writing",
      { targetDocumentId, limit: 20 },
    );
  }

  requireOwned(conversation: ConversationRow, principal: Principal): void {
    if (conversation.purpose !== "writing") throw new DomainError("NOT_FOUND", "会话不存在");
    if (
      conversation.tenantId !== principal.tenantId ||
      conversation.identityId !== principal.identityId ||
      conversation.visitorId
    )
      throw new DomainError("NOT_FOUND", "会话不存在");
  }

  async snapshot(
    principal: Principal,
    conversationId: string,
    page?: { before?: string; limit?: number },
  ) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    return this.deps.store.snapshot(conversation, page);
  }

  // ------------------------------------------------------------- submit

  async submitMessage(
    principal: Principal,
    conversationId: string,
    body: {
      clientMessageId: string;
      idempotencyKey: string;
      text: string;
      expectedContextRevision: number;
      intent?: WritingRequest["intent"];
      editorContext?: {
        documentId: string;
        target:
          | { kind: "document" }
          | { kind: "selection"; blockIds: string[] }
          | { kind: "blocks"; blockIds: string[] }
          | { kind: "document-end"; afterBlockId: string | null };
      };
      webSearch?: boolean;
      referenceArtifactIds?: string[];
    },
  ): Promise<{ runId: string }> {
    this.requireEnabled();
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    if (conversation.configurationId && conversation.configurationId !== this.configurationId())
      throw new DomainError("CONFLICT", "模型配置已更新，请在新上下文继续");
    if (body.webSearch === true && !this.webAvailable())
      throw new DomainError("SERVICE_UNAVAILABLE", "联网调研尚未配置，无法按请求检索网页");
    const targetDocumentId = conversation.targetDocumentId;
    let capture: WritingRunContext["capture"];
    let request: WritingRunContext["request"];
    if (body.editorContext) {
      const documentId = body.editorContext.documentId;
      if (targetDocumentId && documentId !== targetDocumentId)
        throw new DomainError("CONFLICT", "编辑上下文与目标文档不一致");
      await this.assertDocumentAccess(principal, documentId, ["ai"]);
      const current = await this.deps.owner.snapshot(principal, documentId);
      const target = this.resolveTarget(body.editorContext.target, current.snapshot);
      capture = {
        document: {
          documentId,
          generationId: current.snapshot.generationId,
          durableSeq: current.snapshot.durableSeq,
          contentHash: hashContent(current.snapshot.content),
        },
        structureRevision: current.structureRevision,
      };
      request = this.buildRequest(body, target);
    } else if (targetDocumentId) {
      await this.assertDocumentAccess(principal, targetDocumentId, ["ai"]);
      const current = await this.deps.owner.snapshot(principal, targetDocumentId);
      capture = {
        document: {
          documentId: targetDocumentId,
          generationId: current.snapshot.generationId,
          durableSeq: current.snapshot.durableSeq,
          contentHash: hashContent(current.snapshot.content),
        },
        structureRevision: current.structureRevision,
      };
      request = this.buildRequest(
        body,
        body.intent === "rewrite-document"
          ? { kind: "document" }
          : {
              kind: "document-end",
              afterBlockId: current.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
            },
      );
    }
    const admitted = await this.deps.store.admitMessage(
      {
        conversation,
        purpose: "writing",
        expectedContextRevision: body.expectedContextRevision,
        clientMessageId: body.clientMessageId,
        idempotencyKey: body.idempotencyKey,
        parts: [{ kind: "text", text: body.text }],
        identityInput: { ...body },
        context: {
          contextRevision: conversation.contextRevision,
          configurationId: this.configurationId(),
          scope: conversation.scopeSelection,
          webSearch: body.webSearch === true && this.webAvailable(),
          ...(capture ? { capture } : {}),
          ...(request ? { request } : {}),
          ...(body.referenceArtifactIds?.length
            ? { referenceArtifactIds: body.referenceArtifactIds }
            : {}),
        },
      },
      {
        tenantRunningMax: this.deps.config.AI_MAX_CONCURRENT,
        ownerHourlyMax: DEFAULT_OWNER_HOURLY_MAX,
      },
    );
    this.kick();
    return { runId: admitted.run.id };
  }

  private resolveTarget(
    target: NonNullable<Parameters<WritingService["submitMessage"]>[2]["editorContext"]>["target"],
    snapshot: DocumentSnapshot,
  ): WritingRequest["target"] {
    const blocks = snapshot.content.content;
    if (target.kind === "document") return { kind: "document" };
    if (target.kind === "document-end")
      return {
        kind: "document-end",
        afterBlockId: target.afterBlockId ?? blocks.at(-1)?.attrs.blockId ?? null,
      };
    const entries = target.blockIds.map((blockId) => {
      const block = blocks.find((candidate) => candidate.attrs.blockId === blockId);
      if (!block) throw new DomainError("CONFLICT", "所选段落已不存在，请重新选择");
      return { blockId, contentHash: hashContent(block) };
    });
    if (!entries.length) throw new DomainError("VALIDATION_ERROR", "未选择任何段落");
    return { kind: "blocks", blocks: entries };
  }

  private buildRequest(
    body: { intent?: WritingRequest["intent"]; text: string },
    target: WritingRequest["target"],
  ): WritingRequest {
    const intent = body.intent ?? (target.kind === "document" ? "rewrite-document" : "auto");
    const request: WritingRequest = { intent, instruction: body.text, target };
    const checked = validateWritingRequest(request);
    if (!checked.success) throw new DomainError("VALIDATION_ERROR", "写作指令与目标不匹配");
    return request;
  }

  async setScope(
    principal: Principal,
    conversationId: string,
    expectedContextRevision: number,
    scope: ScopeSelection,
  ) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    const result = await this.deps.store.setScope(conversation, expectedContextRevision, scope);
    for (const runId of result.cancelledRunIds)
      this.activeRuns.get(runId)?.abort(new Error("CANCELLED"));
    return {
      contextRevision: result.conversation.contextRevision,
      scope: result.conversation.scopeSelection,
      cancelledRunIds: result.cancelledRunIds,
    };
  }

  async cancelRun(principal: Principal, conversationId: string, runId: string) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    const run = await this.deps.store.readRun(conversation.tenantId, runId);
    if (!run || run.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "任务不存在");
    const result = await this.deps.store.cancelRun(conversation.tenantId, runId);
    // Durable intent first; the native agent stops only when this instance owns the run.
    this.activeRuns.get(runId)?.abort(new Error("CANCELLED"));
    return runDto(result);
  }

  async retryRun(principal: Principal, conversationId: string, runId: string) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    const run = await this.deps.store.readRun(conversation.tenantId, runId);
    if (!run || run.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "任务不存在");
    const result = await this.deps.store.retryRun(conversation.tenantId, runId);
    this.kick();
    return { kind: result.kind, run: runDto(result.run) };
  }

  async decide(
    principal: Principal,
    conversationId: string,
    approvalId: string,
    body: { decisionId: string; decision: "allow-once" | "reject" },
  ) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    const runs = await this.deps.store.listActiveRuns(conversation.tenantId, conversation.id);
    const run = runs.find(
      (candidate) => (candidate.execution as WritingExecution | null)?.approval?.id === approvalId,
    );
    if (!run) throw new DomainError("NOT_FOUND", "审批不存在或已处理");
    const approval = (run.execution as WritingExecution | null)?.approval;
    if (!approval || approval.id !== approvalId)
      throw new DomainError("NOT_FOUND", "审批不存在或已处理");
    if (approval.decisionId) {
      if (approval.decisionId !== body.decisionId || approval.decision !== body.decision)
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一审批已收到不同决定");
      return { status: approval.status };
    }
    const session = await this.attachedSession(conversation);
    if (!session) throw new DomainError("CONFLICT", "执行实例已失效，请刷新后重试");
    await session.decide(approvalId, body.decision);
    return {
      status: body.decision === "allow-once" ? ("allowed" as const) : ("rejected" as const),
    };
  }

  // ------------------------------------------------------------- images

  async listImages(principal: Principal, conversationId: string) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    return this.deps.images.list(conversation.tenantId, conversation.id);
  }

  async refreshImage(principal: Principal, conversationId: string, jobKey: string) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    return this.deps.images.refresh(principal, conversation.id, jobKey);
  }

  async imageAccess(principal: Principal, conversationId: string, assetId: string) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    return this.deps.images.access(principal, conversation.id, assetId);
  }

  // ------------------------------------------------------------- stream

  async streamEvents(
    principal: Principal,
    conversationId: string,
    cursor: string,
    sse: SseHandle,
    signal: AbortSignal,
  ) {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    const take = () => {
      const state = this.turnStates.get(conversation.id);
      if (!state) return [];
      const frames = this.previews.get(state.run.id) ?? [];
      this.previews.set(state.run.id, []);
      return frames;
    };
    this.observers.set(conversation.id, (this.observers.get(conversation.id) ?? 0) + 1);
    try {
      await streamConversation(
        this.deps.store,
        this.deps.bus,
        conversation,
        cursor,
        sse,
        signal,
        take,
      );
    } finally {
      const remaining = (this.observers.get(conversation.id) ?? 1) - 1;
      if (remaining > 0) this.observers.set(conversation.id, remaining);
      else this.observers.delete(conversation.id);
    }
  }

  async artifact(
    principal: Principal,
    conversationId: string,
    artifactId: string,
  ): Promise<Record<string, unknown>> {
    const conversation = await this.deps.store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, principal);
    const artifact = await this.deps.store.findArtifact(conversation.tenantId, artifactId);
    if (!artifact || artifact.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "产物不存在");
    return (artifact.payload ?? {}) as Record<string, unknown>;
  }

  // ------------------------------------------------------------- dispatch

  start() {
    this.dispatch.start();
  }

  async stop() {
    await this.dispatch.stop();
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime) await runtime.then((instance) => instance.dispose()).catch(() => undefined);
  }

  private kick() {
    this.dispatch.kick();
  }

  private async drainOnce(): Promise<boolean> {
    if (this.activeRuns.size >= this.deps.config.AI_MAX_CONCURRENT) return false;
    if (!this.capabilities().enabled) return false;
    const claimed = await this.deps.store.claimNext(
      "writing",
      this.deps.config.AI_TIMEOUT_MS + 30_000,
    );
    if (!claimed) return false;
    void this.executeNativeAttempt(claimed.conversation, claimed.run);
    return true;
  }

  private async attachedSession(conversation: ConversationRow): Promise<NativeWritingSession> {
    const revision = conversation.contextRevision;
    const nativeSessionId = nativeSessionIdFor(conversation.id, revision);
    const existing = this.sessions.get(nativeSessionId);
    if (existing) return existing;
    const runtime = await this.initRuntime();
    const persisted = await this.deps.pool.query("select 1 from writing_sessions where id=$1", [
      nativeSessionId,
    ]);
    const pending = runtime
      .attach({
        conversationId: conversation.id,
        contextRevision: revision,
        nativeSessionId,
        restore: !!persisted.rowCount,
      })
      .catch((error: unknown) => {
        this.sessions.delete(nativeSessionId);
        throw error;
      });
    this.sessions.set(nativeSessionId, pending);
    return pending;
  }

  private executionPatch(state: TurnToolState, patch: Partial<WritingExecution>): WritingExecution {
    const base = (state.run.execution as WritingExecution | null) ?? {
      evidenceRefs: [],
      evidenceArtifactIds: [],
      proposalArtifactIds: [],
      steps: [],
    };
    return { ...base, ...patch };
  }

  private async persistExecution(
    state: TurnToolState,
    patch: Partial<WritingExecution>,
    emit = false,
  ): Promise<void> {
    const written = await this.deps.store.writeExecution({
      run: state.run,
      owner: state.leaseOwner,
      execution: this.executionPatch(state, patch),
      emitEvent: emit,
      renewLeaseMs: this.deps.config.AI_TIMEOUT_MS + 30_000,
    });
    if (!written) throw new WritingRuntimeError("PERSISTENCE_FAILED");
    state.run = written;
  }

  private async executeNativeAttempt(conversation: ConversationRow, run: RunRow): Promise<void> {
    const store = this.deps.store;
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("DEADLINE")),
      this.deps.config.AI_TIMEOUT_MS,
    );
    let state: TurnToolState | undefined;
    try {
      const identityId = conversation.identityId;
      if (!identityId) throw new DomainError("AI_ACCESS_REVOKED", "写作会话缺少内部身份");
      const principal = await this.principalFor(conversation.tenantId, identityId);
      state = {
        conversation,
        run,
        principal,
        bundles: [],
        artifactIdByEvidence: new Map(),
        webSources: new Map(),
        proposalArtifactIds: [],
        leaseOwner: store.instanceId,
        context: run.context as WritingRunContext,
        image: this.deps.images.ports({
          principal,
          conversationId: conversation.id,
          runId: run.id,
        }),
      };
      this.turnStates.set(conversation.id, state);
      const userMessage = await store.userMessageForRun(run.tenantId, run.id, run.conversationId);
      const inputText = userMessage?.parts.find((part) => part.kind === "text");
      if (!inputText || inputText.kind !== "text") throw new WritingRuntimeError("INVALID_INPUT");
      await this.loadReferenceEvidence(state, controller.signal);
      let session = await this.attachedSession(conversation);
      const execution = (run.execution as WritingExecution | null) ?? {
        evidenceRefs: [],
        evidenceArtifactIds: [],
        proposalArtifactIds: [],
        steps: [],
      };
      const request: WritingTurnRequest = {
        conversationId: conversation.id,
        runId: run.id,
        attempt: run.attempt,
        contextRevision: run.context.contextRevision,
        inputText: inputText.text,
        nativeSessionId: nativeSessionIdFor(conversation.id, conversation.contextRevision),
        ...(execution.nativeMessageId
          ? {
              plannedNativeMessageId: execution.nativeMessageId,
              ...(execution.deliveryConfirmed ? { deliveryConfirmed: true } : {}),
            }
          : {}),
        ...(execution.turn !== undefined ? { knownTurn: execution.turn } : {}),
        deadlineAtMs: Date.now() + this.deps.config.AI_TIMEOUT_MS,
        context: run.context as WritingRunContext,
      };
      const host = this.turnHost(conversation, state);
      const deliver = (target: NativeWritingSession) =>
        execution.nativeMessageId
          ? target.settle(request, host, controller.signal)
          : target.execute(request, host, controller.signal);
      let result: WritingTurnResult;
      try {
        result = await deliver(session);
      } catch (error) {
        // Idle eviction can race a cached handle; SESSION_UNAVAILABLE is thrown before any
        // delivery side effect, so exactly one re-attach is safe.
        if (!(error instanceof WritingRuntimeError) || error.code !== "SESSION_UNAVAILABLE")
          throw error;
        this.sessions.delete(request.nativeSessionId);
        session = await this.attachedSession(conversation);
        result = await deliver(session);
      }
      await this.finishAttempt(state, session, result);
    } catch (error) {
      if (state) await this.finishFailure(state, error, controller.signal.aborted);
    } finally {
      clearTimeout(deadline);
      this.activeRuns.delete(run.id);
      this.turnStates.delete(conversation.id);
      this.previews.delete(run.id);
      await this.deps.pool
        .query("update writing_sessions set updated_at=now() where id=$1", [
          nativeSessionIdFor(conversation.id, conversation.contextRevision),
        ])
        .catch((error: unknown) => {
          this.deps.log("writing_session_touch_failed", {
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  /** Carry verified handoff evidence into this Run as a fresh artifact. */
  private async loadReferenceEvidence(state: TurnToolState, signal: AbortSignal): Promise<void> {
    const references = state.context.referenceArtifactIds;
    if (!references?.length) return;
    for (const artifactId of references) {
      const artifact = await this.deps.store.findArtifact(state.conversation.tenantId, artifactId);
      if (!artifact || artifact.kind !== "evidence")
        throw new WritingRuntimeError("ACCESS_REVOKED");
      const bundle = artifact.payload as EvidenceBundle;
      const docIds = [
        ...new Set(
          bundle.sources
            .filter((source) => source.sourceKind === "document")
            .map((source) => (source as { documentId: string }).documentId),
        ),
      ];
      if (docIds.length && this.deps.rag) {
        const scope: RetrievalScope = {
          kind: "principal",
          principal: state.principal,
          selection: { kind: "documents", documentIds: docIds },
        };
        if (!(await this.deps.rag.verifyStoredEvidence(scope, bundle.items)))
          throw new WritingRuntimeError("ACCESS_REVOKED");
      }
      await this.registerEvidenceItems(
        state,
        bundle.items,
        bundle.sources,
        `handoff:${artifactId.slice(0, 48)}`,
        signal,
      );
    }
  }

  private turnHost(conversation: ConversationRow, state: TurnToolState): WritingTurnHost {
    const store = this.deps.store;
    return {
      authorize: async () => {
        await this.verifyTurnAccess(state, new AbortController().signal, false);
        const fresh = await store.readRun(state.run.tenantId, state.run.id);
        if (fresh?.cancelRequested) throw new WritingRuntimeError("CANCELLED");
      },
      reserveModelCall: async () => {
        await this.reserveUsage(state, { modelCalls: 1 }, new AbortController().signal);
      },
      onDeliveryPlanned: async (_turn, nativeMessageId) => {
        await this.persistExecution(state, { nativeMessageId, deliveryConfirmed: false });
      },
      onDeliveryConfirmed: async () => {
        await this.persistExecution(state, { deliveryConfirmed: true });
      },
      onApprovalRequested: async (request) => {
        const approval: WritingApproval = {
          id: request.approvalId,
          attempt: request.attempt,
          action: request.action,
          description: request.description,
          status: "pending",
          requestedAt: new Date().toISOString(),
          expiresAt: request.expiresAt,
        };
        await store.recordApproval(state.run, store.instanceId, approval);
      },
      onApprovalResolved: async (request, outcome) => {
        const status =
          outcome === "allowed-once"
            ? "allowed"
            : outcome === "rejected"
              ? "rejected"
              : outcome === "unavailable"
                ? "expired"
                : "cancelled";
        const decision =
          outcome === "allowed-once"
            ? ("allow-once" as const)
            : outcome === "rejected"
              ? ("reject" as const)
              : undefined;
        await store.resolveApproval({
          run: state.run,
          owner: store.instanceId,
          approvalId: request.approvalId,
          outcome: status,
          decision,
        });
      },
      emitPreview: (turn, frame) => {
        const list = this.previews.get(turn.runId) ?? [];
        const preview: PreviewFrame = {
          type: "preview",
          conversationId: conversation.id,
          purpose: "writing",
          runId: turn.runId,
          streamEpoch: frame.streamEpoch,
          attempt: turn.attempt,
          contextRevision: turn.contextRevision,
          revision: frame.revision,
          index: frame.index,
          channel: "text",
          text: frame.text,
        };
        list.push(preview);
        if (list.length > 64) list.splice(0, list.length - 64);
        this.previews.set(turn.runId, list);
        this.deps.bus.wake(conversationKey(conversation));
      },
    };
  }

  private async finishAttempt(
    state: TurnToolState,
    session: NativeWritingSession,
    result: WritingTurnResult,
  ): Promise<void> {
    const store = this.deps.store;
    const text = result.resultText ?? "";
    const parts: MessagePart[] = [];
    if (text) parts.push({ kind: "text", text });
    for (const artifactId of state.proposalArtifactIds) {
      const artifact = await store.findArtifact(state.run.tenantId, artifactId);
      if (artifact && artifact.kind === "proposal")
        parts.push({
          kind: "artifact",
          artifactId,
          artifactKind: "proposal",
          summary: (artifact.payload as WritingProposalPayload).summary,
        });
    }
    void session;
    // A persisted cancel intent from the host wins over a provider-shaped failure: when the
    // model rejects mid-abort the loop records an error stop, but the user cancelled this run.
    let status = result.status;
    let errorCode = result.errorCode;
    if (status === "failed") {
      const fresh = await store.readRun(state.run.tenantId, state.run.id);
      if (fresh?.cancelRequested) {
        status = "cancelled";
        errorCode = undefined;
      }
    }
    await store.commitRunOutput({
      run: state.run,
      owner: state.leaseOwner,
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(parts.length ? { assistantParts: parts } : {}),
      // Settle adapter-reported tokens on top of the per-call reservations.
      ...(result.usage ? { usage: result.usage } : {}),
      execution: this.executionPatch(state, {
        nativeMessageId: result.nativeMessageId,
        deliveryConfirmed: result.deliveryConfirmed,
        turn: result.turn,
        proposalArtifactIds: state.proposalArtifactIds,
      }),
    });
    this.deps.bus.wake(conversationKey(state.conversation));
  }

  private async finishFailure(
    state: TurnToolState,
    error: unknown,
    aborted: boolean,
  ): Promise<void> {
    const store = this.deps.store;
    const code = writingFailureCode(error, aborted);
    if (code === "PERSISTENCE_FAILED") {
      // The lease may be gone; maintain() finalizes as interrupted when this owner is stale.
      const fresh = await store.readRun(state.run.tenantId, state.run.id);
      if (
        !fresh ||
        fresh.leaseOwner !== store.instanceId ||
        fresh.fencingToken !== state.run.fencingToken
      )
        return;
    }
    const status = failureRunStatus(code, "SESSION_UNAVAILABLE");
    await store
      .commitRunOutput({
        run: state.run,
        owner: state.leaseOwner,
        status,
        ...(status === "failed" || status === "interrupted"
          ? { errorCode: code.slice(0, 64) }
          : {}),
      })
      .catch((error: unknown) => {
        // maintain() finalizes stale leases; the fault must still be visible.
        this.deps.log("writing_failure_commit_lost", {
          runId: state.run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.deps.bus.wake(conversationKey(state.conversation));
  }

  // ------------------------------------------------------------- proposal apply

  async reviewProposal(
    principal: Principal,
    artifactId: string,
    body: {
      decisionId: string;
      revision: number;
      action: "accept" | "reject";
      blockIds?: string[];
    },
  ): Promise<{ applicationState: ProposalApplicationState; receipt?: StructureReceipt }> {
    const store = this.deps.store;
    const artifact = await store.findArtifact(principal.tenantId, artifactId);
    if (!artifact || artifact.kind !== "proposal" || artifact.purpose !== "writing")
      throw new DomainError("NOT_FOUND", "提案不存在");
    const conversation = await store.getConversation(principal.tenantId, artifact.conversationId);
    this.requireOwned(conversation, principal);
    if (artifact.state !== "committed") throw new DomainError("CONFLICT", "提案尚未就绪");
    if (artifact.receipt)
      return {
        applicationState: artifact.applicationState ?? "applied",
        receipt: artifact.receipt,
      };
    const payload = artifact.payload as WritingProposalPayload;
    const fingerprint = hashContent({ ...body, artifactId });
    const documentId = payload.document.documentId;
    await this.assertDocumentAccess(principal, documentId, ["write", "ai", "read"]);
    if (body.action === "reject") {
      const review: ProposalReview = {
        revision: (artifact.reviewRevision ?? 0) + 1,
        decisions: payload.operationBatch.operations.map((operation) => ({
          blockId:
            operation.type === "insert-block"
              ? operation.block.attrs.blockId
              : operation.targetBlockId,
          action: "reject" as const,
        })),
        receipts: { ...(artifact.review?.receipts ?? {}), [body.decisionId]: fingerprint },
      };
      await store.recordProposalReview({
        tenantId: principal.tenantId,
        artifactId,
        expectedRevision: body.revision,
        decisionId: body.decisionId,
        fingerprint,
        applicationState: "rejected",
        review,
      });
      return { applicationState: "rejected" };
    }
    const current = await this.deps.owner.snapshot(principal, documentId);
    const batch = this.acceptedBatch(payload, body.blockIds);
    const decorated = await this.decorateCitations(principal.tenantId, payload, batch);
    const operationId = `op_${body.decisionId.replaceAll(/[-_]/g, "").slice(0, 48)}`;
    const finalBatch: OperationBatch = {
      ...decorated,
      operationId,
      documentId,
      generationId: current.snapshot.generationId,
    };
    const rejectedIds = payload.operationBatch.operations
      .map((operation) =>
        operation.type === "insert-block" ? operation.block.attrs.blockId : operation.targetBlockId,
      )
      .filter(
        (id) =>
          !finalBatch.operations.some((operation) =>
            operation.type === "insert-block"
              ? operation.block.attrs.blockId === id
              : operation.targetBlockId === id,
          ),
      );
    const applicationState = rejectedIds.length ? "partial" : "applied";
    const receipt = await this.deps.owner
      .apply({
        principal,
        batch: finalBatch as OperationBatch & { generationId: string },
        expectedDurableSeq: current.snapshot.durableSeq,
        baseStructureRevision: current.structureRevision,
        guard: async (tx) => {
          // Decisions, source distribution and document authority re-checked under document lock.
          const locked = await store.repository.lockArtifact(tx, principal.tenantId, artifactId);
          if (locked?.receipt) throw new DomainError("CONFLICT", "提案已由其他决定落地");
          await this.assertDocumentAccessTx(tx, principal, documentId);
          await this.assertSourcesDistributable(tx, principal, payload);
        },
        record: async (tx, appliedReceipt) => {
          const review: ProposalReview = {
            revision: (artifact.reviewRevision ?? 0) + 1,
            decisions: [
              ...finalBatch.operations.map((operation) => ({
                blockId:
                  operation.type === "insert-block"
                    ? operation.block.attrs.blockId
                    : operation.targetBlockId,
                action: "accept" as const,
              })),
              ...rejectedIds.map((blockId) => ({ blockId, action: "reject" as const })),
            ],
            receipts: { ...(artifact.review?.receipts ?? {}), [body.decisionId]: fingerprint },
          };
          const written = await store.repository.recordArtifactReview(tx, artifact, {
            reviewRevision: review.revision,
            review,
            applicationState,
            receipt: appliedReceipt,
          });
          if (!written) throw new DomainError("CONFLICT", "提案状态已更新，请刷新后重试");
          const conv = await store.repository.lockConversation(
            tx,
            principal.tenantId,
            conversation.id,
          );
          if (conv)
            await store.repository.appendEvent(tx, conv, {
              eventId: randomUUID(),
              type: "artifact.application-updated",
              entityId: artifact.id,
              payload: {
                artifactId: artifact.id,
                applicationState,
                reviewRevision: review.revision,
                receipt: appliedReceipt,
              },
              createdAt: new Date(),
            });
        },
      })
      .catch(async (error: unknown) => {
        if (
          error instanceof DomainError &&
          error.code === "CONFLICT" &&
          !(await store.findArtifact(principal.tenantId, artifactId))?.receipt
        ) {
          await store
            .recordProposalReview({
              tenantId: principal.tenantId,
              artifactId,
              expectedRevision: artifact.reviewRevision ?? 0,
              decisionId: body.decisionId,
              fingerprint,
              applicationState: "conflict",
              review: {
                revision: (artifact.reviewRevision ?? 0) + 1,
                decisions: [],
                receipts: { ...(artifact.review?.receipts ?? {}), [body.decisionId]: fingerprint },
              },
            })
            .catch(() => undefined);
        }
        throw error;
      });
    return { applicationState, receipt };
  }

  /** Rebuild an operation batch containing only the accepted blocks, keeping insertion order. */
  private acceptedBatch(payload: WritingProposalPayload, blockIds?: string[]): OperationBatch {
    const operations = payload.operationBatch.operations;
    if (!blockIds?.length)
      return { ...payload.operationBatch, preconditions: payload.operationBatch.preconditions };
    const selected = new Set(blockIds);
    const kept: OperationBatch["operations"] = [];
    const insertOps = operations.filter((operation) => operation.type === "insert-block");
    const firstAnchor =
      insertOps.length && insertOps[0]?.type === "insert-block"
        ? (insertOps[0].afterBlockId ?? null)
        : null;
    let previousAccepted: string | null = firstAnchor;
    for (const operation of operations) {
      if (operation.type === "insert-block") {
        if (!selected.has(operation.block.attrs.blockId)) continue;
        kept.push({
          type: "insert-block",
          parentBlockId: operation.parentBlockId,
          ...(previousAccepted ? { afterBlockId: previousAccepted } : {}),
          block: operation.block,
        });
        previousAccepted = operation.block.attrs.blockId;
      } else if (selected.has(operation.targetBlockId)) {
        kept.push(operation);
      }
    }
    if (!kept.length) throw new DomainError("VALIDATION_ERROR", "没有可应用的选定段落");
    const anchors = new Set<string>();
    for (const operation of kept) {
      if (operation.type === "replace-block" || operation.type === "delete-block")
        anchors.add(operation.targetBlockId);
      if (operation.type === "insert-block" && operation.afterBlockId)
        anchors.add(operation.afterBlockId);
    }
    const preconditions = (payload.operationBatch.preconditions ?? []).filter((precondition) =>
      anchors.has(precondition.blockId),
    );
    return { ...payload.operationBatch, preconditions, operations: kept };
  }

  /** Verified citations become inline link marks plus one trailing reference paragraph. */
  private async decorateCitations(
    tenantId: string,
    payload: WritingProposalPayload,
    batch: OperationBatch,
  ): Promise<OperationBatch> {
    if (!payload.citations.length) return batch;
    const links = new Map<string, { href: string; title: string }>();
    for (const citation of payload.citations) {
      const artifact = await this.deps.store.findArtifact(tenantId, citation.evidenceArtifactId);
      if (!artifact || artifact.kind !== "evidence") continue;
      const bundle = artifact.payload as EvidenceBundle;
      const item = bundle.items.find((candidate) => candidate.evidenceId === citation.evidenceId);
      const source =
        item &&
        bundle.sources.find(
          (s) => s.sourceId === item.sourceId && s.snapshotId === item.snapshotId,
        );
      if (!source) continue;
      const href =
        source.sourceKind === "document"
          ? `${this.deps.config.APP_PUBLIC_URL.replace(/\/$/, "")}/documents/${source.documentId}?block=${item?.locator.kind === "block" ? item.locator.blockId : ""}`
          : source.canonicalUrl;
      links.set(citation.evidenceId, { href, title: source.title });
    }
    const used: { href: string; title: string }[] = [];
    const operations = batch.operations.map((operation) => {
      if (operation.type !== "insert-block" && operation.type !== "replace-block") return operation;
      const block = operation.block;
      if (block.type !== "paragraph" && block.type !== "heading") return operation;
      const content = block.content;
      if (!content) return operation;
      let changed = false;
      const next: typeof content = [];
      for (const node of content) {
        if (node.type !== "text") {
          next.push(node);
          continue;
        }
        let matched: (typeof content)[number][] | undefined;
        for (const citation of payload.citations) {
          const link = links.get(citation.evidenceId);
          if (!link) continue;
          const index = node.text.indexOf(citation.quote);
          if (index < 0) continue;
          changed = true;
          if (!used.some((entry) => entry.href === link.href)) used.push(link);
          const before = node.text.slice(0, index);
          const hit = node.text.slice(index, index + citation.quote.length);
          const after = node.text.slice(index + citation.quote.length);
          matched = [
            ...(before ? [{ type: "text" as const, text: before }] : []),
            {
              type: "text" as const,
              text: hit,
              marks: [...(node.marks ?? []), { type: "link" as const, attrs: { href: link.href } }],
            },
            ...(after ? [{ type: "text" as const, text: after }] : []),
          ];
          break;
        }
        next.push(...(matched ?? [node]));
      }
      return changed ? { ...operation, block: { ...block, content: next } } : operation;
    });
    if (!used.length) return { ...batch, operations };
    const insertOperations = operations.filter(
      (operation) => operation.type === "insert-block",
    ) as Extract<OperationBatch["operations"][number], { type: "insert-block" }>[];
    const tail = insertOperations.at(-1);
    const fallbackAnchor =
      payload.target.kind === "document-end"
        ? payload.target.afterBlockId
        : payload.target.kind === "blocks"
          ? (payload.target.blocks.at(-1)?.blockId ?? null)
          : null;
    const afterBlockId =
      tail?.block.attrs.blockId ?? insertOperations[0]?.afterBlockId ?? fallbackAnchor ?? null;
    const referenceId = `block_${hashContent([payload.document.documentId, batch.operationId, "refs"]).slice(7, 55)}`;
    const referenceBlock = {
      type: "paragraph" as const,
      attrs: { blockId: referenceId },
      content: [
        { type: "text" as const, text: "参考资料：" },
        ...used.flatMap((link, index) => [
          ...(index ? [{ type: "text" as const, text: "；" }] : []),
          {
            type: "text" as const,
            text: link.title,
            marks: [{ type: "link" as const, attrs: { href: link.href } }],
          },
        ]),
      ],
    };
    return {
      ...batch,
      operations: [
        ...operations,
        {
          type: "insert-block",
          parentBlockId: null,
          ...(afterBlockId ? { afterBlockId } : {}),
          block: referenceBlock,
        },
      ],
    };
  }

  private async assertDocumentAccessTx(
    tx: DocumentWriteTransaction,
    principal: Principal,
    documentId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.id, documentId),
          eq(documents.status, "active"),
          documentActionSql(principal, "write"),
          documentActionSql(principal, "ai"),
        ),
      )
      .limit(1);
    if (!rows.length) throw new DomainError("AI_ACCESS_REVOKED", "目标文档写权限已变化");
  }

  /** Citation sources must remain readable by the adopting principal at write time. */
  private async assertSourcesDistributable(
    tx: DocumentWriteTransaction,
    principal: Principal,
    payload: WritingProposalPayload,
  ): Promise<void> {
    const docIds = new Set<string>();
    for (const citation of payload.citations) {
      const artifact = await this.deps.store.repository.findArtifact(
        tx,
        principal.tenantId,
        citation.evidenceArtifactId,
      );
      const bundle = artifact?.payload as EvidenceBundle | undefined;
      for (const source of bundle?.sources ?? [])
        if (source.sourceKind === "document") docIds.add(source.documentId);
    }
    for (const docId of docIds) {
      if (docId === payload.document.documentId) continue;
      const rows = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.id, docId),
            eq(documents.status, "active"),
            documentActionSql(principal, "read"),
          ),
        )
        .limit(1);
      if (!rows.length)
        throw new DomainError("AI_ACCESS_REVOKED", "引用来源已不可访问，不能写入正文");
    }
  }

  // ------------------------------------------------------------- handoff port

  handoffPort: WritingHandoffPort = {
    createFromHandoff: async (cmd: HandoffCommand) => {
      const store = this.deps.store;
      this.requireEnabled();
      const principal = await this.principalFor(cmd.tenantId, cmd.identityId);
      if (cmd.targetDocumentId)
        await this.assertDocumentAccess(principal, cmd.targetDocumentId, ["ai"]);
      const docScopeIds = await this.handoffScopeSources(cmd);
      // Same capture/request assembly as submitMessage: without them the writing
      // tools have no input baseline and every proposal attempt fails INVALID_OUTPUT.
      let capture: WritingRunContext["capture"];
      let request: WritingRunContext["request"];
      if (cmd.targetDocumentId) {
        const current = await this.deps.owner.snapshot(principal, cmd.targetDocumentId);
        capture = {
          document: {
            documentId: cmd.targetDocumentId,
            generationId: current.snapshot.generationId,
            durableSeq: current.snapshot.durableSeq,
            contentHash: hashContent(current.snapshot.content),
          },
          structureRevision: current.structureRevision,
        };
        request = this.buildRequest(
          { intent: cmd.intent ?? "create", text: cmd.instruction },
          // Handoff intents are additive only; single-block rewrites need an editor selection.
          {
            kind: "document-end",
            afterBlockId: current.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
          },
        );
      }
      const { conversation, created } = await store.createConversation({
        purpose: "writing",
        owner: { kind: "identity", tenantId: cmd.tenantId, identityId: cmd.identityId },
        scope: docScopeIds.length
          ? { kind: "documents", documentIds: docScopeIds }
          : { kind: "all" },
        targetDocumentId: cmd.targetDocumentId ?? null,
        configurationId: this.configurationId(),
        creationKey: cmd.creationKey,
        origin: {
          kind: "qa-handoff",
          sourceConversationId: cmd.sourceConversationId,
          sourceMessageIds: cmd.messageIds,
          sourceArtifactIds: cmd.artifactIds,
        },
      });
      if (!created) {
        const runs = await store.listActiveRuns(conversation.tenantId, conversation.id);
        const first = runs[0];
        if (first) return { conversationId: conversation.id, runId: first.id, replayed: true };
      }
      const admitted = await store.admitMessage(
        {
          conversation: await store.refresh(conversation),
          purpose: "writing",
          expectedContextRevision: conversation.contextRevision,
          clientMessageId: `handoff-${cmd.creationKey}`,
          idempotencyKey: `handoff-${cmd.creationKey}`,
          parts: [{ kind: "text", text: cmd.instruction }],
          identityInput: { ...cmd },
          context: {
            contextRevision: conversation.contextRevision,
            configurationId: this.configurationId(),
            scope: conversation.scopeSelection,
            webSearch: false,
            ...(capture ? { capture } : {}),
            ...(request ? { request } : {}),
            referenceArtifactIds: cmd.artifactIds,
          },
        },
        {
          tenantRunningMax: this.deps.config.AI_MAX_CONCURRENT,
          ownerHourlyMax: DEFAULT_OWNER_HOURLY_MAX,
        },
      );
      this.kick();
      return {
        conversationId: conversation.id,
        runId: admitted.run.id,
        replayed: admitted.replayed,
      };
    },
  };

  private async handoffScopeSources(cmd: HandoffCommand): Promise<string[]> {
    const ids = new Set<string>();
    for (const artifactId of cmd.artifactIds) {
      const artifact = await this.deps.store.findArtifact(cmd.tenantId, artifactId);
      if (!artifact || artifact.kind !== "evidence") continue;
      const bundle = artifact.payload as EvidenceBundle;
      for (const source of bundle.sources)
        if (source.sourceKind === "document") ids.add(source.documentId);
    }
    return [...ids].slice(0, 64);
  }

  private async principalFor(tenantId: string, identityId: string): Promise<Principal> {
    const rows = await this.deps.db
      .select({
        displayName: identityProfiles.displayName,
        email: identityProfiles.email,
        active: identityProfiles.active,
      })
      .from(identityProfiles)
      .where(
        and(eq(identityProfiles.tenantId, tenantId), eq(identityProfiles.identityId, identityId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.active) throw new DomainError("AI_ACCESS_REVOKED", "身份已停用");
    return {
      tenantId,
      identityId,
      username: identityId,
      displayName: row.displayName,
      email: row.email,
      globalRoles: [],
      active: true,
    };
  }
}

const WRITING_DOMAIN_FAILURE: DomainFailureMap = {
  AI_ACCESS_REVOKED: "ACCESS_REVOKED",
};

/** Classify a failed attempt; domain errors take precedence over the abort flag here. */
function writingFailureCode(error: unknown, aborted: boolean): string {
  if (error instanceof WritingRuntimeError) return error.code;
  if (error instanceof DomainError) return WRITING_DOMAIN_FAILURE[error.code] ?? "MODEL_FAILED";
  if (aborted) return "CANCELLED";
  return "MODEL_FAILED";
}
