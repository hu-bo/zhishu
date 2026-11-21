import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import {
  createAssistantRuntime,
  type AssistantPorts,
  type AssistantRuntime,
  type AssistantSession,
  type AssistantTurnRequest,
} from "@zhishu/ai-runtime";
import {
  DshRuntimeError,
  type ApprovalRequest,
  type NativeApprovalOutcome,
  type TurnIdentity,
  type TurnResult,
} from "@zhishu/dsh-agent";
import {
  createLaunchEnvironmentSnapshot,
  PiAiProvider,
  type Context,
  type LlmAdapter,
} from "@zhishu/dsh-agent/kernel";
import type { WebSearchPort } from "@zhishu/ai-plugins/contracts";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  type DocumentBlock,
  type DocumentContent,
  type DocumentSnapshot,
  type OperationBatch,
  type StructureReceipt,
} from "@zhishu/document-contracts";
import { documents, identityProfiles } from "../../../database/schema/index.js";

/** Inline content of a paragraph/heading block; shared by proposal and draft citation linking. */
type InlineContent = NonNullable<Extract<DocumentBlock, { type: "paragraph" }>["content"]>;
import {
  DEFAULT_GENERATION_LIMITS,
  validateEvidenceBundle,
  validateWritingRequest,
  type AssistantExecution,
  type AssistantPluginId,
  type AssistantRunContext,
  type Citation,
  type EvidenceBundle,
  type EvidenceItem,
  type EvidenceSource,
  type ProposalApplicationState,
  type ProposalReview,
  type QaAnswer,
  type RunUsage,
  type ScopeSelection,
  type ToolApproval,
  type WritingDraftPayload,
  type WritingProposalPayload,
  type WritingRequest,
} from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-contracts/hash";
import type {
  ConversationSnapshot,
  Message,
  MessagePart,
  PreviewFrame,
  Run,
} from "@zhishu/chat-contracts";
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
  type ConversationOwner,
  type ConversationRow,
  type DomainFailureMap,
  type RunRow,
  type SseHandle,
} from "./index.js";
import type { ArtifactRow } from "./ai.types.js";
import { messageDto } from "./ai.types.js";
import type { CollaborationOwner, DocumentWriteTransaction } from "../collaboration/owner.js";
import { documentActionSql } from "../authorization/document-access.js";
import { requireWorkspaceOrganizer } from "../authorization/permissions.js";
import type { PermissionAction } from "../authorization/policy.js";
import type { RagService, RetrievalScope } from "../rag/rag.service.js";
import type { Principal } from "../identity/identity.types.js";
import { AiImages } from "./images.js";
import {
  nativeSessionIdFor,
  parseNativeSessionId,
  postgresNativeSessionPersistence,
} from "./native.js";
import { createTavilyPort } from "./tavily.js";

/**
 * Transaction port implemented by the documents module and injected by root assembly.
 * The ai module never inserts document rows itself; documents never imports ai.
 */
export interface DraftDocumentPort {
  createDraftInTx(
    tx: DocumentWriteTransaction,
    input: {
      tenantId: string;
      identityId: string;
      title: string;
      workspaceId: string;
      content: DocumentContent;
      schemaVersion: number;
      idempotencyKey: string;
    },
  ): Promise<{ documentId: string; generationId: string; durableSeq: number }>;
}

/** Audiences that drive the same assistant: an internal principal or one public site visitor. */
export type AssistantAudience =
  | { kind: "internal"; principal: Principal }
  | {
      kind: "site";
      tenantId: string;
      siteId: string;
      visitorId: string;
      approved: readonly { documentId: string; workspaceId: string; publicLabel: string }[];
      accessRevision?: number;
      internal?: Principal;
    };

/** Public evidence projection shape, mirrored by the qa-sites route response schema. */
export interface AssistantPublicEvidence {
  sources: { sourceKind: "document"; title: string; label?: string }[];
  items: { evidenceId: string; locator: Record<string, unknown>; text: string }[];
}

export interface AssistantSubmitInput {
  clientMessageId: string;
  idempotencyKey: string;
  text: string;
  expectedContextRevision: number;
  intentHint?: "qa" | "writing";
  scope?: ScopeSelection;
  plugins?: AssistantPluginId[];
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
}

export interface CreateDraftInput {
  idempotencyKey: string;
  instruction: string;
  workspaceId: string;
  title?: string;
  expectedContextRevision: number;
  referenceArtifactIds?: string[];
}

/** Run-scoped state shared by tools installed once per attached session. */
interface TurnToolState {
  conversation: ConversationRow;
  run: RunRow;
  audience: AssistantAudience;
  bundles: EvidenceBundle[];
  artifactIdByEvidence: Map<string, string>;
  webSources: Map<string, Extract<EvidenceSource, { sourceKind: "web" }>>;
  /** Sources surfaced by platform reads in this Run; read items register without their bundle sources. */
  readSources: Map<string, EvidenceSource>;
  proposalArtifactIds: string[];
  draftArtifactId?: string;
  answer?: QaAnswer;
  leaseOwner: string;
  context: AssistantRunContext;
  image: { ports: import("@zhishu/ai-plugins/image").ImagePorts } | undefined;
}

export interface AssistantServiceDeps {
  store: AiService;
  bus: ConversationEventBus;
  db: Database;
  pool: Pool;
  rag: RagService | null;
  owner: CollaborationOwner;
  images: AiImages;
  drafts: DraftDocumentPort;
  config: AppConfig;
  log: (event: string, meta: Record<string, unknown>) => void;
}

const webSearchLimits = {
  resultsPerCall: DEFAULT_GENERATION_LIMITS.webSearchResultsPerCall,
  extractMaxBytes: DEFAULT_GENERATION_LIMITS.webExtractMaxBytes,
  timeoutMs: 30_000,
};
const HISTORY_LIMIT = 16;
const HISTORY_BYTE_LIMIT = 16_000;

/**
 * The unified assistant business assembly. One official DSH execution serves question
 * answering, research and writing through composable plugins; every product state transition
 * goes through the shared AiService. Drafts become real documents only inside the atomic
 * binding transaction; proposals apply only through the collaboration structure channel with
 * a durable receipt recorded in the same transaction as the body change.
 */
export class AssistantService {
  private runtime?: Promise<AssistantRuntime>;
  private sessions = new Map<string, Promise<AssistantSession>>();
  private observers = new Map<string, number>();
  private turnStates = new Map<string, TurnToolState>();
  private previews = new Map<string, PreviewFrame[]>();
  private activeRuns = new Map<string, AbortController>();
  private readonly dispatch: DispatchLoop;
  /** Test seam: hosts may inject a deterministic LLM adapter like the smoke scripts do. */
  adapter?: LlmAdapter;

  constructor(private readonly deps: AssistantServiceDeps) {
    this.dispatch = new DispatchLoop(() => this.drainOnce(), deps.log, "assistant");
  }

  // ------------------------------------------------------------- capabilities

  configurationId(): string {
    const c = this.deps.config;
    return hashContent([
      "assistant-v1",
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

  /** Server-computed allowed plugins for an entry; client choices are only a subset. */
  allowedPlugins(audience: AssistantAudience): AssistantPluginId[] {
    if (audience.kind === "site") return ["scope", "rag"];
    const plugins: AssistantPluginId[] = ["scope", "rag", "research", "writing"];
    if (this.deps.images.capability().available) plugins.push("image");
    return plugins;
  }

  capabilities() {
    const image = this.deps.images.capability();
    const enabled = !!(this.deps.config.AI_MODEL && this.deps.config.AI_API_KEY);
    return {
      enabled,
      engine: "dsh-native-v1" as const,
      reason: enabled ? undefined : "尚未配置助手模型，请设置 AI_MODEL 与 AI_API_KEY",
      plugins: ["scope", "rag", "research", "writing", "image"] as AssistantPluginId[],
      image: { available: image.available, reason: image.reason },
      webSearchAvailable: this.webAvailable(),
      webSearchLimits: this.webAvailable()
        ? {
            searchCallsPerRun: DEFAULT_GENERATION_LIMITS.webSearchCallsPerRun,
            resultsPerSearch: DEFAULT_GENERATION_LIMITS.webSearchResultsPerCall,
            readPagesPerRun: DEFAULT_GENERATION_LIMITS.webReadPagesPerRun,
          }
        : undefined,
      retrieval: {
        contextTokenBudget: 12_000,
        maxEvidenceItems: 32,
        scopeLimits: { maxWorkspaces: 8, maxDocuments: 64, maxAllDocuments: 10_000 },
      },
      configurationId: this.configurationId(),
    };
  }

  private requireEnabled(): void {
    if (!this.capabilities().enabled)
      throw new DomainError("SERVICE_UNAVAILABLE", this.capabilities().reason ?? "助手服务未启用");
  }

  // ------------------------------------------------------------- ownership

  private ownerOf(audience: AssistantAudience): ConversationOwner {
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

  private requireOwned(conversation: ConversationRow, audience: AssistantAudience): void {
    const tenantId = audienceTenant(audience);
    if (conversation.tenantId !== tenantId) throw new DomainError("NOT_FOUND", "会话不存在");
    if (audience.kind === "internal") {
      if (
        conversation.identityId !== audience.principal.identityId ||
        conversation.visitorId ||
        conversation.siteId
      )
        throw new DomainError("NOT_FOUND", "会话不存在");
      return;
    }
    if (conversation.siteId !== audience.siteId) throw new DomainError("NOT_FOUND", "会话不存在");
    if (audience.internal) {
      if (conversation.identityId !== audience.internal.identityId || conversation.visitorId)
        throw new DomainError("NOT_FOUND", "会话不存在");
    } else if (conversation.visitorId !== audience.visitorId)
      throw new DomainError("NOT_FOUND", "会话不存在");
  }

  private retrievalScope(audience: AssistantAudience, selection: ScopeSelection): RetrievalScope {
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

  // ------------------------------------------------------------- conversations

  async createConversation(
    audience: AssistantAudience,
    input: {
      scope?: ScopeSelection;
      creationKey?: string;
      targetDocumentId?: string | null;
    } = {},
  ): Promise<ConversationRow> {
    this.requireEnabled();
    if (input.targetDocumentId) {
      if (audience.kind !== "internal")
        throw new DomainError("FORBIDDEN", "公开会话不能绑定文档目标");
      await this.assertDocumentAccess(audience.principal, input.targetDocumentId, ["ai"]);
    }
    const { conversation } = await this.deps.store.createConversation({
      owner: this.ownerOf(audience),
      scope: input.scope ?? { kind: "all" },
      targetDocumentId: input.targetDocumentId ?? null,
      configurationId: this.configurationId(),
      creationKey: input.creationKey ?? null,
      ttlMs: audience.kind === "site" ? 12 * 3_600_000 : undefined,
    });
    return conversation;
  }

  async listConversations(audience: AssistantAudience): Promise<ConversationRow[]> {
    return this.deps.store.listConversations(this.ownerOf(audience), {
      limit: audience.kind === "site" ? 10 : 20,
    });
  }

  async snapshot(
    audience: AssistantAudience,
    conversationId: string,
    page?: { before?: string; limit?: number },
  ): Promise<ConversationSnapshot> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    return this.projectSnapshot(audience, await this.deps.store.snapshot(conversation, page));
  }

  private async projectSnapshot(
    audience: AssistantAudience,
    snapshot: ConversationSnapshot,
  ): Promise<ConversationSnapshot> {
    if (audience.kind !== "site") return snapshot;
    const approved = new Set(audience.approved.map((source) => source.documentId));
    const runAllowed = new Map<string, boolean>();
    const messages: Message[] = [];
    for (const message of snapshot.messages) {
      if (message.role === "assistant") {
        let allowed = runAllowed.get(message.runId);
        if (allowed === undefined) {
          allowed = await this.publicRunAllowed(audience.tenantId, message.runId, approved);
          runAllowed.set(message.runId, allowed);
        }
        if (!allowed) continue;
      }
      messages.push({
        ...message,
        parts: message.parts.filter((part) => part.kind !== "artifact"),
      });
    }
    return {
      ...snapshot,
      conversation: { ...snapshot.conversation, siteId: audience.siteId },
      messages,
      artifacts: [],
    };
  }

  /** A public answer stays visible only while every evidence source handed to the model is approved. */
  private async publicRunAllowed(
    tenantId: string,
    runId: string,
    approved: ReadonlySet<string>,
    artifactCache?: Map<string, boolean>,
  ): Promise<boolean> {
    const run = await this.deps.store.readRun(tenantId, runId);
    if (!run) return false;
    for (const ref of run.execution?.evidenceRefs ?? []) {
      let sourceAllowed = artifactCache?.get(ref.evidenceArtifactId);
      if (sourceAllowed === undefined) {
        sourceAllowed = await this.evidenceArtifactApproved(
          tenantId,
          ref.evidenceArtifactId,
          approved,
        );
        artifactCache?.set(ref.evidenceArtifactId, sourceAllowed);
      }
      if (!sourceAllowed) return false;
    }
    return true;
  }

  private async evidenceArtifactApproved(
    tenantId: string,
    artifactId: string,
    approved: ReadonlySet<string>,
  ): Promise<boolean> {
    const artifact = await this.deps.store.findArtifact(tenantId, artifactId);
    if (!artifact || artifact.state !== "committed") return false;
    const bundle = artifact.payload as EvidenceBundle;
    return bundle.sources.every(
      (source) => source.sourceKind !== "document" || approved.has(source.documentId),
    );
  }

  // ------------------------------------------------------------- submit

  async submitMessage(
    audience: AssistantAudience,
    conversationId: string,
    body: AssistantSubmitInput,
  ): Promise<{ runId: string }> {
    this.requireEnabled();
    const store = this.deps.store;
    const conversation = await store.getConversation(audienceTenant(audience), conversationId);
    this.requireOwned(conversation, audience);
    if (conversation.configurationId && conversation.configurationId !== this.configurationId())
      throw new DomainError("CONFLICT", "模型配置已更新，请在新上下文继续");
    const scope = body.scope ?? conversation.scopeSelection;
    if (audience.kind === "site") this.retrievalScope(audience, scope);
    const allowed = this.allowedPlugins(audience);
    const requested = body.plugins?.length ? body.plugins : allowed;
    if (requested.some((plugin) => !allowed.includes(plugin)))
      throw new DomainError("FORBIDDEN", "所选能力不在当前入口允许范围内");
    const intentHint = audience.kind === "site" ? "qa" : (body.intentHint ?? "qa");
    const webSearch =
      audience.kind === "internal" && body.webSearch === true && this.webAvailable();
    if (body.webSearch === true && audience.kind === "internal" && !this.webAvailable())
      throw new DomainError("SERVICE_UNAVAILABLE", "联网调研尚未配置，无法按请求检索网页");

    let capture: AssistantRunContext["capture"];
    let request: AssistantRunContext["request"];
    if (audience.kind === "internal") {
      const targetDocumentId = conversation.targetDocumentId;
      if (body.editorContext) {
        const documentId = body.editorContext.documentId;
        if (targetDocumentId && documentId !== targetDocumentId)
          throw new DomainError("CONFLICT", "编辑上下文与目标文档不一致");
        await this.assertDocumentAccess(audience.principal, documentId, ["ai"]);
        const current = await this.deps.owner.snapshot(audience.principal, documentId);
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
        request = this.buildRequest(body.text, target);
      } else if (targetDocumentId) {
        await this.assertDocumentAccess(audience.principal, targetDocumentId, ["ai"]);
        const current = await this.deps.owner.snapshot(audience.principal, targetDocumentId);
        capture = {
          document: {
            documentId: targetDocumentId,
            generationId: current.snapshot.generationId,
            durableSeq: current.snapshot.durableSeq,
            contentHash: hashContent(current.snapshot.content),
          },
          structureRevision: current.structureRevision,
        };
        request = this.buildRequest(body.text, {
          kind: "document-end",
          afterBlockId: current.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
        });
      }
    }
    const context: AssistantRunContext = {
      contextRevision: conversation.contextRevision,
      configurationId: this.configurationId(),
      command: "chat",
      intentHint,
      plugins: requested,
      scope,
      webSearch,
      ...(capture ? { capture } : {}),
      ...(request ? { request } : {}),
      ...(body.referenceArtifactIds?.length
        ? { referenceArtifactIds: body.referenceArtifactIds }
        : {}),
    };
    const admitted = await store.admitMessage(
      {
        conversation,
        expectedContextRevision: body.expectedContextRevision,
        clientMessageId: body.clientMessageId,
        idempotencyKey: body.idempotencyKey,
        parts: [{ kind: "text", text: body.text }],
        identityInput: { ...body },
        context,
      },
      {
        tenantRunningMax: this.deps.config.AI_MAX_CONCURRENT,
        ownerHourlyMax: DEFAULT_OWNER_HOURLY_MAX,
        siteHourlyMax:
          audience.kind === "site"
            ? await this.siteQuota(conversation.tenantId, audience.siteId)
            : undefined,
      },
    );
    this.kick();
    return { runId: admitted.run.id };
  }

  private resolveTarget(
    target: NonNullable<AssistantSubmitInput["editorContext"]>["target"],
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

  private buildRequest(text: string, target: WritingRequest["target"]): WritingRequest {
    const intent = target.kind === "document" ? "rewrite-document" : "auto";
    const request: WritingRequest = { intent, instruction: text, target };
    const checked = validateWritingRequest(request);
    if (!checked.success) throw new DomainError("VALIDATION_ERROR", "写作指令与目标不匹配");
    return request;
  }

  // ------------------------------------------------------------- create draft

  /**
   * Explicit user command: accept a create-draft Run in the SAME conversation. The document
   * is created later, atomically with the target binding, only after the draft compiles.
   */
  async createDraft(
    principal: Principal,
    conversationId: string,
    body: CreateDraftInput,
  ): Promise<{
    runId: string | null;
    documentId?: string;
    replayed: boolean;
    status: "accepted" | "in-progress" | "already-bound";
  }> {
    this.requireEnabled();
    const store = this.deps.store;
    const conversation = await store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, { kind: "internal", principal });
    if (conversation.siteId) throw new DomainError("FORBIDDEN", "公开会话不能创建草稿");
    if (conversation.targetDocumentId)
      return {
        runId: null,
        documentId: conversation.targetDocumentId,
        replayed: true,
        status: "already-bound",
      };
    // In-flight create-draft runs are returned even under a different idempotency key.
    const active = await store.listActiveRuns(conversation.tenantId, conversation.id);
    const inflight = active.find((run) => run.context.command === "create-draft");
    if (inflight) return { runId: inflight.id, replayed: true, status: "in-progress" };
    await requireWorkspaceOrganizer(this.deps.db, principal, body.workspaceId);
    if (body.referenceArtifactIds?.length)
      await this.assertReferencesAccessible(principal, conversation, body.referenceArtifactIds);
    const context: AssistantRunContext = {
      contextRevision: conversation.contextRevision,
      configurationId: this.configurationId(),
      command: "create-draft",
      intentHint: "writing",
      plugins: ["scope", "rag", "writing"],
      scope: conversation.scopeSelection,
      webSearch: false,
      draft: { workspaceId: body.workspaceId, ...(body.title ? { title: body.title } : {}) },
      ...(body.referenceArtifactIds?.length
        ? { referenceArtifactIds: body.referenceArtifactIds }
        : {}),
    };
    try {
      const admitted = await store.admitMessage(
        {
          conversation,
          expectedContextRevision: body.expectedContextRevision,
          clientMessageId: body.idempotencyKey,
          idempotencyKey: body.idempotencyKey,
          parts: [{ kind: "text", text: body.instruction }],
          identityInput: { ...body },
          context,
        },
        {
          tenantRunningMax: this.deps.config.AI_MAX_CONCURRENT,
          ownerHourlyMax: DEFAULT_OWNER_HOURLY_MAX,
        },
      );
      this.kick();
      return { runId: admitted.run.id, replayed: admitted.replayed, status: "accepted" };
    } catch (error) {
      // A concurrent create-draft won the admission race: return it instead of a second draft.
      if (error instanceof DomainError && error.code === "RESOURCE_LIMIT") {
        const racing = (await store.listActiveRuns(conversation.tenantId, conversation.id)).find(
          (run) => run.context.command === "create-draft",
        );
        if (racing) return { runId: racing.id, replayed: true, status: "in-progress" };
      }
      throw error;
    }
  }

  /** Explicit binding of an existing authorized document; never creates a new conversation. */
  async bindTarget(
    principal: Principal,
    conversationId: string,
    body: { targetDocumentId: string; expectedContextRevision: number },
  ): Promise<{ contextRevision: number; targetDocumentId: string; cancelledRunIds: string[] }> {
    const store = this.deps.store;
    const conversation = await store.getConversation(principal.tenantId, conversationId);
    this.requireOwned(conversation, { kind: "internal", principal });
    await this.assertDocumentAccess(principal, body.targetDocumentId, ["ai", "write"]);
    const result = await store.bindTarget(
      conversation,
      body.expectedContextRevision,
      body.targetDocumentId,
    );
    for (const runId of result.cancelledRunIds)
      this.activeRuns.get(runId)?.abort(new Error("CANCELLED"));
    return {
      contextRevision: result.conversation.contextRevision,
      targetDocumentId: body.targetDocumentId,
      cancelledRunIds: result.cancelledRunIds,
    };
  }

  private async assertReferencesAccessible(
    principal: Principal,
    conversation: ConversationRow,
    artifactIds: string[],
  ): Promise<void> {
    for (const artifactId of artifactIds) {
      const artifact = await this.deps.store.findArtifact(conversation.tenantId, artifactId);
      if (!artifact || artifact.conversationId !== conversation.id || artifact.kind !== "evidence")
        throw new DomainError("VALIDATION_ERROR", "所选资料不可用");
      const bundle = artifact.payload as EvidenceBundle;
      const docIds = documentIdsOf(bundle);
      if (docIds.length && this.deps.rag) {
        const scope: RetrievalScope = {
          kind: "principal",
          principal,
          selection: { kind: "documents", documentIds: docIds },
        };
        if (!(await this.deps.rag.verifyStoredEvidence(scope, bundle.items)))
          throw new DomainError("AI_ACCESS_REVOKED", "部分资料权限或版本已变化，请重新检索");
      }
    }
  }

  // ------------------------------------------------------------- scope / cancel / retry

  async setScope(
    audience: AssistantAudience,
    conversationId: string,
    expectedContextRevision: number,
    scope: ScopeSelection,
  ) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
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

  async cancelRun(
    audience: AssistantAudience,
    conversationId: string,
    runId: string,
  ): Promise<Run> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    const run = await this.deps.store.readRun(conversation.tenantId, runId);
    if (!run || run.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "任务不存在");
    const result = await this.deps.store.cancelRun(conversation.tenantId, runId);
    this.activeRuns.get(runId)?.abort(new Error("CANCELLED"));
    return runDto(result);
  }

  async retryRun(audience: AssistantAudience, conversationId: string, runId: string) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    const run = await this.deps.store.readRun(conversation.tenantId, runId);
    if (!run || run.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "任务不存在");
    const result = await this.deps.store.retryRun(conversation.tenantId, runId);
    this.kick();
    return { kind: result.kind, run: runDto(result.run) };
  }

  async decide(
    audience: AssistantAudience,
    conversationId: string,
    approvalId: string,
    body: { decisionId: string; decision: "allow-once" | "reject" },
  ) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    const runs = await this.deps.store.listActiveRuns(conversation.tenantId, conversation.id);
    const run = runs.find((candidate) => candidate.execution?.approval?.id === approvalId);
    const approval = run?.execution?.approval;
    if (!run || !approval || approval.id !== approvalId)
      throw new DomainError("NOT_FOUND", "审批不存在或已处理");
    if (approval.decisionId) {
      if (approval.decisionId !== body.decisionId || approval.decision !== body.decision)
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一审批已收到不同决定");
      return { status: approval.status };
    }
    const session = await this.attachedSession(conversation, run.context.plugins);
    await session.decide(approvalId, body.decision);
    return {
      status: body.decision === "allow-once" ? ("allowed" as const) : ("rejected" as const),
    };
  }

  // ------------------------------------------------------------- images

  async listImages(audience: AssistantAudience, conversationId: string) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    return this.deps.images.list(conversation.tenantId, conversation.id);
  }

  async refreshImage(audience: AssistantAudience, conversationId: string, jobKey: string) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    if (audience.kind !== "internal") throw new DomainError("FORBIDDEN", "公开会话不支持图片");
    return this.deps.images.refresh(audience.principal, conversation.id, jobKey);
  }

  async imageAccess(audience: AssistantAudience, conversationId: string, assetId: string) {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    if (audience.kind !== "internal") throw new DomainError("FORBIDDEN", "公开会话不支持图片");
    return this.deps.images.access(audience.principal, conversation.id, assetId);
  }

  // ------------------------------------------------------------- stream / artifacts

  async streamEvents(
    audience: AssistantAudience,
    conversationId: string,
    cursor: string,
    sse: SseHandle,
    signal: AbortSignal,
  ): Promise<void> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    const take = () => {
      const state = this.turnStates.get(conversation.id);
      if (!state) return [];
      const frames = this.previews.get(state.run.id) ?? [];
      this.previews.set(state.run.id, []);
      return frames;
    };
    this.observers.set(conversation.id, (this.observers.get(conversation.id) ?? 0) + 1);
    try {
      if (audience.kind !== "site") {
        await streamConversation(
          this.deps.store,
          this.deps.bus,
          conversation,
          cursor,
          sse,
          signal,
          take,
        );
        return;
      }
      let approved = new Set(audience.approved.map((source) => source.documentId));
      const artifactCache = new Map<string, boolean>();
      const revalidate = async (): Promise<boolean> => {
        try {
          const state = await this.siteStreamState(conversation);
          if (
            audience.accessRevision !== undefined &&
            state.accessRevision !== audience.accessRevision
          )
            return false;
          approved = new Set(state.approved.map((source) => source.documentId));
          artifactCache.clear();
          return true;
        } catch {
          return false;
        }
      };
      const filterEvent = async (
        event: import("@zhishu/chat-contracts").AiEvent,
      ): Promise<boolean> => {
        if (event.type !== "message.created" || event.payload.message.role !== "assistant")
          return true;
        return this.publicRunAllowed(
          audience.tenantId,
          event.payload.message.runId,
          approved,
          artifactCache,
        );
      };
      await streamConversation(
        this.deps.store,
        this.deps.bus,
        conversation,
        cursor,
        sse,
        signal,
        take,
        filterEvent,
        revalidate,
      );
    } finally {
      const remaining = (this.observers.get(conversation.id) ?? 1) - 1;
      if (remaining > 0) this.observers.set(conversation.id, remaining);
      else this.observers.delete(conversation.id);
    }
  }

  async readArtifact(
    audience: AssistantAudience,
    conversationId: string,
    artifactId: string,
  ): Promise<Record<string, unknown>> {
    if (audience.kind !== "internal") throw new DomainError("FORBIDDEN", "公开读取请使用证据投影");
    const artifact = await this.loadOwnedArtifact(audience, conversationId, artifactId);
    return (artifact.payload ?? {}) as Record<string, unknown>;
  }

  async readPublicEvidence(
    audience: AssistantAudience,
    conversationId: string,
    artifactId: string,
  ): Promise<AssistantPublicEvidence> {
    if (audience.kind !== "site") throw new DomainError("FORBIDDEN", "证据投影仅面向站点访客");
    const artifact = await this.loadOwnedArtifact(audience, conversationId, artifactId);
    if (artifact.kind !== "evidence") throw new DomainError("NOT_FOUND", "产物不存在");
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
    audience: AssistantAudience,
    conversationId: string,
    artifactId: string,
  ): Promise<ArtifactRow> {
    const conversation = await this.deps.store.getConversation(
      audienceTenant(audience),
      conversationId,
    );
    this.requireOwned(conversation, audience);
    const artifact = await this.deps.store.findArtifact(conversation.tenantId, artifactId);
    if (!artifact || artifact.conversationId !== conversation.id)
      throw new DomainError("NOT_FOUND", "产物不存在");
    return artifact;
  }

  // ------------------------------------------------------------- runtime assembly

  private initRuntime(): Promise<AssistantRuntime> {
    this.runtime ??= createAssistantRuntime({
      persistence: "required",
      agentOptions: {
        provider: "assistant",
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
      ports: (conversationId) => this.portsFor(conversationId),
    }).catch((error: unknown) => {
      this.runtime = undefined;
      throw error;
    });
    return this.runtime;
  }

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
        this.deps.log("assistant_native_append_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
    if (this.adapter) {
      ctx.llm.registerAdapter(["assistant"], this.adapter);
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
        assistant: {
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

  private tavilyPort(): WebSearchPort | null {
    if (!this.webAvailable()) return null;
    return createTavilyPort(this.deps.config, {
      resultsPerCall: webSearchLimits.resultsPerCall,
      extractMaxBytes: webSearchLimits.extractMaxBytes,
      timeoutMs: webSearchLimits.timeoutMs,
    });
  }

  /** Host ports resolved per conversation; every effect re-checks the active run and authority. */
  private portsFor(conversationId: string): AssistantPorts {
    const state = () => this.turnStates.get(conversationId);
    const require = () => {
      const current = state();
      if (!current) throw new DshRuntimeError("NO_ACTIVE_RUN");
      return current;
    };
    const web = this.tavilyPort();
    return {
      scope: {
        current: () => require().conversation.scopeSelection,
        update: async (selection, signal) => {
          const current = require();
          signal.throwIfAborted();
          if (current.audience.kind === "site") this.retrievalScope(current.audience, selection);
          const result = await this.deps.store.setScope(
            current.conversation,
            current.run.context.contextRevision,
            selection,
          );
          return { contextRevision: result.conversation.contextRevision };
        },
      },
      platform: {
        search: async (query, signal) => {
          const current = require();
          const bundle = await this.retrievePlatformEvidence(current, query, signal);
          return bundle.sources;
        },
        read: async (sourceId, signal) => {
          const current = require();
          const bundle = await this.retrievePlatformEvidence(current, sourceId, signal, [sourceId]);
          // The plugin only carries items back to register; keep this read's sources so the
          // bundle can be rebuilt even when the Run preloaded nothing (create-draft).
          for (const source of bundle.sources)
            current.readSources.set(`${source.sourceId}\u0000${source.snapshotId}`, source);
          return bundle.items;
        },
        register: async (items, toolCallId, signal) => {
          const current = require();
          await this.registerEvidenceItems(current, items, [], `tool:${toolCallId}`, signal);
        },
        reserve: async (kind, signal) => {
          const current = require();
          await this.reserveUsage(
            current,
            kind === "search" ? { searchCalls: 1 } : { sourceReads: 1 },
            signal,
          );
        },
      },
      answer: {
        evidence: () => mergeEvidenceBundles(state()?.bundles ?? []),
        artifactOf: (evidenceId) => state()?.artifactIdByEvidence.get(evidenceId),
        verify: async (signal) => {
          const current = require();
          await this.verifyTurnAccess(current, signal);
          const bundle = mergeEvidenceBundles(current.bundles);
          if (bundle.items.length && this.deps.rag) {
            const scope = this.retrievalScope(current.audience, current.context.scope);
            if (!(await this.deps.rag.verifyStoredEvidence(scope, bundle.items)))
              throw new DomainError("AI_ACCESS_REVOKED", "证据授权已变化");
          }
        },
        save: async (answer, _callId, signal) => {
          const current = require();
          signal.throwIfAborted();
          current.answer = answer;
          await this.deps.store.stageAssistantMessage(
            current.run,
            current.leaseOwner,
            answerParts(answer),
          );
        },
      },
      ...(web
        ? {
            web: {
              search: web,
              ports: {
                enabled: () => state()?.context.webSearch === true,
                reserve: async (kind, signal) => {
                  const current = require();
                  await this.reserveUsage(
                    current,
                    kind === "search" ? { webSearchCalls: 1 } : { webReadCalls: 1 },
                    signal,
                  );
                },
                register: async (partial, toolCallId, signal) => {
                  const current = require();
                  for (const source of partial.sources)
                    if (source.sourceKind === "web")
                      current.webSources.set(source.sourceId, source);
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
              },
            },
          }
        : {}),
      writing: {
        buildInput: async () => this.buildWritingInput(conversationId),
        buildDraftInput: () => {
          const current = require();
          return {
            threadId: current.conversation.id,
            runId: current.run.id,
            ...(current.context.draft?.title ? { title: current.context.draft.title } : {}),
            prompt: { id: "writing", version: "2", systemInstruction: "" },
          };
        },
        verify: async (signal) => {
          const current = require();
          await this.verifyTurnAccess(current, signal);
        },
        save: async (proposal, callId, signal) => {
          const current = require();
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
        saveDraft: async (draft, callId, signal) => {
          const current = require();
          signal.throwIfAborted();
          if (current.context.command !== "create-draft")
            throw new DomainError("FORBIDDEN", "本草稿未获创建受理");
          const registered = await this.deps.store.registerArtifact({
            run: current.run,
            owner: current.leaseOwner,
            producerCallId: `tool:${callId}`,
            resultIndex: 0,
            kind: "draft",
            schemaVersion: 1,
            payload: draft,
            evidenceIds: [...new Set(draft.citations.map((citation) => citation.evidenceId))],
          });
          current.draftArtifactId = registered.artifact.id;
          current.run = registered.run;
          await this.persistExecution(current, { draftArtifactId: registered.artifact.id });
        },
        schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
        systemInstruction: "",
      },
      ...(this.deps.images.capability().available
        ? {
            image: {
              load: async (key) => state()?.image?.ports.load(key),
              save: async (key, job) => {
                const current = require();
                if (!current.image) throw new DshRuntimeError("NO_ACTIVE_RUN");
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
                    payload: {
                      jobId: key,
                      assetId: job.assets[0]?.assetId ?? null,
                      status: job.status,
                    },
                    evidenceIds: [],
                  });
                  current.run = registered.run;
                }
              },
              reserve: async (key, signal) => state()?.image?.ports.reserve(key, signal),
              provider: {
                create: async (input, signal) => {
                  const ports = state()?.image?.ports;
                  if (!ports?.provider)
                    throw new DomainError("SERVICE_UNAVAILABLE", "图片服务尚未配置");
                  return ports.provider.create(input, signal);
                },
                poll: async (jobId, signal) => {
                  const ports = state()?.image?.ports;
                  if (!ports?.provider)
                    throw new DomainError("SERVICE_UNAVAILABLE", "图片服务尚未配置");
                  return ports.provider.poll(jobId, signal);
                },
              },
              store: async (key, image, signal) => {
                const ports = state()?.image?.ports;
                if (!ports) throw new DshRuntimeError("NO_ACTIVE_RUN");
                return ports.store(key, image, signal);
              },
            },
          }
        : {}),
      retrieve: async (query, signal) => {
        const current = require();
        const bundle = await this.retrievePlatformEvidence(current, query, signal);
        return bundle;
      },
      registerEvidence: async (bundle, stepId, signal) => {
        const current = require();
        await this.registerEvidenceItems(
          current,
          bundle.items,
          bundle.sources,
          `step:${stepId}:${current.run.attempt}`,
          signal,
        );
      },
    };
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
      : state.context.scope;
    const scope = this.retrievalScope(state.audience, selection);
    const { evidence } = await this.deps.rag.retrieve(scope, query, 12_000, signal);
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
    let resolvedSources: readonly EvidenceSource[] = sources;
    if (!resolvedSources.length) {
      // Item-only registration (platform read): rebuild the source set from what this Run
      // retrieved or already registered, never from another Run's or conversation's data.
      const known = new Map(state.readSources);
      for (const source of mergeEvidenceBundles(state.bundles).sources)
        known.set(`${source.sourceId}\u0000${source.snapshotId}`, source);
      resolvedSources = [...known.values()].filter((source) =>
        items.some(
          (item) => item.sourceId === source.sourceId && item.snapshotId === source.snapshotId,
        ),
      );
    }
    const bundle: EvidenceBundle = {
      sources: [...resolvedSources],
      items: [...items],
      freshness: "current",
    };
    if (!validateEvidenceBundle(bundle).success) throw new DshRuntimeError("INVALID_CITATION");
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
    state.run = registered.run;
    for (const item of items)
      state.artifactIdByEvidence.set(item.evidenceId, registered.artifact.id);
    state.bundles.push(bundle);
  }

  private async reserveUsage(
    state: TurnToolState,
    delta: Partial<RunUsage>,
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
    if (!written) throw new DshRuntimeError("PERSISTENCE_FAILED");
    state.run = written;
  }

  private async verifyTurnAccess(state: TurnToolState, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const conversation = await this.deps.store.getConversation(
      state.conversation.tenantId,
      state.conversation.id,
    );
    if (conversation.contextRevision !== state.run.context.contextRevision)
      throw new DshRuntimeError("CONTEXT_CHANGED");
    if (conversation.status !== "active")
      throw new DomainError("AI_ACCESS_REVOKED", "会话不可继续");
    const documentId = state.context.capture?.document.documentId;
    if (documentId && state.audience.kind === "internal")
      await this.assertDocumentAccess(state.audience.principal, documentId, ["ai"]);
  }

  /** Live editor snapshot at generation time; the proposal binds the version it saw. */
  private async buildWritingInput(conversationId: string) {
    const state = this.turnStates.get(conversationId);
    if (!state || state.audience.kind !== "internal") return;
    const context = state.context;
    if (!context.capture || !context.request) return;
    const documentId = context.capture.document.documentId;
    const current = await this.deps.owner.snapshot(state.audience.principal, documentId);
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
              return block ? [{ blockId: entry.blockId, contentHash: hashContent(block) }] : [];
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
    const claimed = await this.deps.store.claimNext(this.deps.config.AI_TIMEOUT_MS + 30_000);
    if (!claimed) return false;
    void this.executeAttempt(claimed.conversation, claimed.run);
    return true;
  }

  private async attachedSession(
    conversation: ConversationRow,
    plugins: readonly AssistantPluginId[],
  ): Promise<AssistantSession> {
    const revision = conversation.contextRevision;
    const nativeSessionId = nativeSessionIdFor(conversation.id, revision);
    const existing = this.sessions.get(nativeSessionId);
    if (existing) return existing;
    const runtime = await this.initRuntime();
    const persisted = await this.deps.pool.query("select 1 from ai_sessions where id=$1", [
      nativeSessionId,
    ]);
    const pending = runtime
      .attach({
        conversationId: conversation.id,
        contextRevision: revision,
        nativeSessionId,
        restore: !!persisted.rowCount,
        plugins,
      })
      .catch((error: unknown) => {
        this.sessions.delete(nativeSessionId);
        throw error;
      });
    this.sessions.set(nativeSessionId, pending);
    return pending;
  }

  private executionPatch(
    state: TurnToolState,
    patch: Partial<AssistantExecution>,
  ): AssistantExecution {
    const base = state.run.execution ?? {
      evidenceRefs: [],
      evidenceArtifactIds: [],
      proposalArtifactIds: [],
      steps: [],
    };
    return { ...base, ...patch };
  }

  private async persistExecution(
    state: TurnToolState,
    patch: Partial<AssistantExecution>,
    emit = false,
  ): Promise<void> {
    const written = await this.deps.store.writeExecution({
      run: state.run,
      owner: state.leaseOwner,
      execution: this.executionPatch(state, patch),
      emitEvent: emit,
      renewLeaseMs: this.deps.config.AI_TIMEOUT_MS + 30_000,
    });
    if (!written) throw new DshRuntimeError("PERSISTENCE_FAILED");
    state.run = written;
  }

  private async executeAttempt(conversation: ConversationRow, run: RunRow): Promise<void> {
    const store = this.deps.store;
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("DEADLINE")),
      this.deps.config.AI_TIMEOUT_MS,
    );
    let state: TurnToolState | undefined;
    try {
      const audience = await this.audienceFor(conversation);
      const context = run.context;
      state = {
        conversation,
        run,
        audience,
        bundles: [],
        artifactIdByEvidence: new Map(),
        webSources: new Map(),
        readSources: new Map(),
        proposalArtifactIds: [],
        leaseOwner: store.instanceId,
        context,
        image:
          audience.kind === "internal" && context.plugins.includes("image")
            ? this.deps.images.ports({
                principal: audience.principal,
                conversationId: conversation.id,
                runId: run.id,
              })
            : undefined,
      };
      this.turnStates.set(conversation.id, state);
      const userMessage = await store.userMessageForRun(run.tenantId, run.id, run.conversationId);
      const inputText = userMessage?.parts.find((part) => part.kind === "text");
      if (!inputText || inputText.kind !== "text") throw new DshRuntimeError("INVALID_INPUT");
      await this.loadReferenceEvidence(state, controller.signal);

      // A create-draft retry reuses the immutable compiled draft; no second generation.
      if (context.command === "create-draft" && run.execution?.draftArtifactId) {
        const draft = await store.findArtifact(run.tenantId, run.execution.draftArtifactId);
        if (draft && draft.kind === "draft" && draft.state === "committed") {
          state.draftArtifactId = draft.id;
          await this.bindDraftDocument(state, draft.payload as WritingDraftPayload);
          return;
        }
      }

      let session = await this.attachedSession(conversation, context.plugins);
      const execution = run.execution;
      const history = execution?.nativeMessageId
        ? undefined
        : await this.buildAllowedHistory(audience, conversation, run);
      const request: AssistantTurnRequest = {
        conversationId: conversation.id,
        runId: run.id,
        attempt: run.attempt,
        contextRevision: run.context.contextRevision,
        inputText: inputText.text,
        nativeSessionId: nativeSessionIdFor(conversation.id, conversation.contextRevision),
        ...(execution?.nativeMessageId
          ? {
              plannedNativeMessageId: execution.nativeMessageId,
              ...(execution.deliveryConfirmed ? { deliveryConfirmed: true } : {}),
            }
          : {}),
        ...(execution?.turn !== undefined ? { knownTurn: execution.turn } : {}),
        ...(history?.length ? { history } : {}),
        ...(execution?.evidenceArtifactIds.length ? { retrievalDone: true } : {}),
        deadlineAtMs: Date.now() + this.deps.config.AI_TIMEOUT_MS,
        context,
      };
      const host = this.turnHost(conversation, state);
      const recordsBefore = session.pluginRecords().length;
      const deliver = (target: AssistantSession) =>
        execution?.nativeMessageId
          ? target.settle(request, host, controller.signal)
          : target.execute(request, host, controller.signal);
      let result: TurnResult;
      try {
        result = await deliver(session);
      } catch (error) {
        if (!(error instanceof DshRuntimeError) || error.code !== "SESSION_UNAVAILABLE")
          throw error;
        this.sessions.delete(request.nativeSessionId);
        session = await this.attachedSession(conversation, context.plugins);
        result = await deliver(session);
      }
      await this.finishAttempt(state, result, recordsBefore);
    } catch (error) {
      if (state) await this.finishFailure(state, error, controller.signal.aborted);
    } finally {
      clearTimeout(deadline);
      this.activeRuns.delete(run.id);
      this.turnStates.delete(conversation.id);
      this.previews.delete(run.id);
      await this.deps.pool
        .query("update ai_sessions set updated_at=now() where id=$1", [
          nativeSessionIdFor(conversation.id, conversation.contextRevision),
        ])
        .catch((error: unknown) => {
          this.deps.log("assistant_session_touch_failed", {
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  /** Carry verified reference evidence into this Run as a fresh artifact. */
  private async loadReferenceEvidence(state: TurnToolState, signal: AbortSignal): Promise<void> {
    const references = state.context.referenceArtifactIds;
    if (!references?.length) return;
    for (const artifactId of references) {
      const artifact = await this.deps.store.findArtifact(state.conversation.tenantId, artifactId);
      if (!artifact || artifact.kind !== "evidence") throw new DshRuntimeError("ACCESS_REVOKED");
      const bundle = artifact.payload as EvidenceBundle;
      const docIds = documentIdsOf(bundle);
      if (docIds.length && this.deps.rag) {
        const scope = this.retrievalScope(state.audience, {
          kind: "documents",
          documentIds: docIds,
        });
        if (!(await this.deps.rag.verifyStoredEvidence(scope, bundle.items)))
          throw new DshRuntimeError("ACCESS_REVOKED");
      }
      await this.registerEvidenceItems(
        state,
        bundle.items,
        bundle.sources,
        `reference:${artifactId.slice(0, 48)}`,
        signal,
      );
    }
  }

  private turnHost(conversation: ConversationRow, state: TurnToolState) {
    const store = this.deps.store;
    return {
      authorize: async () => {
        await this.verifyTurnAccess(state, new AbortController().signal);
        const fresh = await store.readRun(state.run.tenantId, state.run.id);
        if (fresh?.cancelRequested) throw new DshRuntimeError("CANCELLED");
      },
      reserveModelCall: async () => {
        await this.reserveUsage(state, { modelCalls: 1 }, new AbortController().signal);
      },
      onDeliveryPlanned: async (_turn: unknown, nativeMessageId: string) => {
        await this.persistExecution(state, { nativeMessageId, deliveryConfirmed: false });
      },
      onDeliveryConfirmed: async () => {
        await this.persistExecution(state, { deliveryConfirmed: true });
      },
      onApprovalRequested: async (request: ApprovalRequest) => {
        const approval: ToolApproval = {
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
      onApprovalResolved: async (request: ApprovalRequest, outcome: NativeApprovalOutcome) => {
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
      emitPreview: (
        turn: TurnIdentity,
        frame: {
          streamEpoch: string;
          revision: number;
          index: number;
          text: string;
          channel: "text" | "thinking" | "tool" | "tool-args";
          tool?: { id: string; name: string; status: "running" | "completed" | "failed" };
        },
      ) => {
        // Raw tool arguments are decoded into the text channel by the assistant runtime
        // before reaching this host; anything still unmarked here is not a public fact.
        if (frame.channel === "tool-args") return;
        const list = this.previews.get(turn.runId) ?? [];
        const preview: PreviewFrame = {
          type: "preview",
          conversationId: conversation.id,
          runId: turn.runId,
          streamEpoch: frame.streamEpoch,
          attempt: turn.attempt,
          contextRevision: turn.contextRevision,
          revision: frame.revision,
          index: frame.index,
          channel: frame.channel,
          ...(frame.channel === "tool" ? {} : { text: frame.text }),
          ...(frame.tool ? { tool: frame.tool } : {}),
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
    result: TurnResult,
    recordsBefore: number,
  ): Promise<void> {
    const store = this.deps.store;
    // Only this turn's plugin records speak for it.
    const turnRecords = result.pluginRecords.slice(recordsBefore);
    const answerRecord = [...turnRecords]
      .reverse()
      .find((record) => record.type === "plugin:zhishu/answer");
    const answer = answerRecord ? (answerRecord.data as QaAnswer) : state.answer;

    // create-draft: the document is created only here, atomically with the target binding.
    if (state.context.command === "create-draft") {
      if (result.status === "completed" && state.draftArtifactId) {
        const draft = await store.findArtifact(state.run.tenantId, state.draftArtifactId);
        if (draft && draft.kind === "draft") {
          await this.bindDraftDocument(state, draft.payload as WritingDraftPayload);
          return;
        }
      }
      await this.commitFailureResult(state, result);
      return;
    }

    const parts: MessagePart[] = [];
    if (answer) parts.push(...answerParts(answer));
    else if (result.resultText) parts.push({ kind: "text", text: result.resultText });
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
      ...(result.usage ? { usage: result.usage } : {}),
      execution: this.executionPatch(state, {
        nativeMessageId: result.nativeMessageId,
        deliveryConfirmed: result.deliveryConfirmed,
        turn: result.turn,
        proposalArtifactIds: state.proposalArtifactIds,
        stagedMessageId: undefined,
      }),
    });
    this.deps.bus.wake(conversationKey(state.conversation));
  }

  private async commitFailureResult(state: TurnToolState, result: TurnResult): Promise<void> {
    let status = result.status === "completed" ? "failed" : result.status;
    let errorCode =
      result.errorCode ?? (result.status === "completed" ? "OUTPUT_REQUIRED" : undefined);
    if (status === "failed") {
      const fresh = await this.deps.store.readRun(state.run.tenantId, state.run.id);
      if (fresh?.cancelRequested) {
        status = "cancelled";
        errorCode = undefined;
      }
    }
    await this.deps.store.commitRunOutput({
      run: state.run,
      owner: state.leaseOwner,
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      execution: this.executionPatch(state, {
        nativeMessageId: result.nativeMessageId,
        deliveryConfirmed: result.deliveryConfirmed,
        turn: result.turn,
      }),
    });
    this.deps.bus.wake(conversationKey(state.conversation));
  }

  /**
   * Atomic draft binding: document initialization, initial collaboration body, conversation
   * target/contextRevision and the terminal Run commit land in ONE database transaction.
   * Authorization, sources, revision and lease fencing are re-checked under the locks.
   */
  private async bindDraftDocument(state: TurnToolState, draft: WritingDraftPayload): Promise<void> {
    const store = this.deps.store;
    const audience = state.audience;
    if (audience.kind !== "internal") throw new DomainError("FORBIDDEN", "公开会话不能创建草稿");
    const principal = audience.principal;
    const draftInput = state.context.draft;
    if (!draftInput) throw new DomainError("CONFLICT", "草稿命令缺少目标空间");
    const repo = store.repository;
    // Source links persist into the body (deterministic); distributability is re-checked under lock.
    const content = await this.decorateDraftContent(
      principal.tenantId,
      draft,
      `${state.conversation.id}:${state.run.id}`,
    );
    await this.deps.db.transaction(async (tx) => {
      // Fixed lock order: admission key, conversation row, then document creation locks.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai-admit:${state.conversation.tenantId}:${state.conversation.id}`},719202))`,
      );
      const conversation = await repo.lockConversation(
        tx,
        state.conversation.tenantId,
        state.conversation.id,
      );
      if (!conversation) throw new DomainError("NOT_FOUND", "会话不存在");
      if (conversation.targetDocumentId)
        throw new DomainError("CONFLICT", "会话已绑定文档，不能重复创建");
      if (conversation.contextRevision !== state.run.context.contextRevision)
        throw new DomainError("CONFLICT", "上下文已更新，草稿不能绑定");
      if (conversation.status !== "active")
        throw new DomainError("AI_ACCESS_REVOKED", "会话不可继续");
      const run = await repo.lockRun(tx, state.run.tenantId, state.run.id);
      if (
        !run ||
        run.leaseOwner !== state.leaseOwner ||
        run.fencingToken !== state.run.fencingToken ||
        run.attempt !== state.run.attempt ||
        run.status !== "running"
      )
        throw new DomainError("CONFLICT", "执行所有权已丢失");
      await requireWorkspaceOrganizer(tx, principal, draftInput.workspaceId);
      await this.assertDraftSourcesDistributable(tx, principal, draft);
      const created = await this.deps.drafts.createDraftInTx(tx, {
        tenantId: principal.tenantId,
        identityId: principal.identityId,
        title: draft.title,
        workspaceId: draftInput.workspaceId,
        content,
        schemaVersion: draft.schemaVersion,
        idempotencyKey: state.run.id,
      });
      const nextRevision = conversation.contextRevision + 1;
      await repo.updateConversation(tx, conversation, {
        targetDocumentId: created.documentId,
        contextRevision: nextRevision,
      });
      const bound = {
        ...conversation,
        targetDocumentId: created.documentId,
        contextRevision: nextRevision,
      };
      const parts: MessagePart[] = [
        { kind: "text", text: draft.summary || "草稿已创建。" },
        {
          kind: "artifact",
          artifactId: state.draftArtifactId!,
          artifactKind: "draft",
          summary: draft.summary,
        },
      ];
      const staged = await repo.upsertStagedAssistant(tx, {
        id: `amsg_${run.id}`,
        tenantId: run.tenantId,
        conversationId: run.conversationId,
        runId: run.id,
        parts,
        generationAttempt: run.attempt,
      });
      const committed = await repo.commitMessage(tx, run.tenantId, staged.id);
      const settled = await repo.patchRunFenced(tx, run, state.leaseOwner, {
        status: "completed",
        execution: this.executionPatch(state, {
          draftArtifactId: state.draftArtifactId,
          stagedMessageId: undefined,
        }),
        clearLease: true,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      });
      if (!settled) throw new DomainError("CONFLICT", "执行所有权已丢失");
      const now = new Date();
      if (committed)
        await repo.appendEvent(tx, bound, {
          eventId: randomUUID(),
          type: "message.created",
          entityId: committed.id,
          payload: { message: messageDto(committed) },
          createdAt: now,
        });
      await repo.appendEvent(tx, bound, {
        eventId: randomUUID(),
        type: "run.updated",
        entityId: settled.id,
        payload: { run: runDto(settled) },
        createdAt: now,
      });
      await repo.appendEvent(tx, bound, {
        eventId: randomUUID(),
        type: "conversation.updated",
        entityId: bound.id,
        payload: {
          contextRevision: nextRevision,
          status: bound.status,
          targetDocumentId: created.documentId,
        },
        createdAt: now,
      });
    });
    this.deps.bus.wake(conversationKey(state.conversation));
  }

  /** Every cited document source must remain readable by the adopting principal at bind time. */
  private async assertDraftSourcesDistributable(
    tx: DocumentWriteTransaction,
    principal: Principal,
    draft: WritingDraftPayload,
  ): Promise<void> {
    const docIds = new Set<string>();
    for (const citation of draft.citations) {
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
        throw new DomainError("AI_ACCESS_REVOKED", "引用来源已不可访问，不能创建草稿");
    }
  }

  private async finishFailure(
    state: TurnToolState,
    error: unknown,
    aborted: boolean,
  ): Promise<void> {
    const store = this.deps.store;
    const code = assistantFailureCode(error, aborted);
    if (code === "PERSISTENCE_FAILED") {
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
        this.deps.log("assistant_failure_commit_lost", {
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
    if (!artifact || artifact.kind !== "proposal") throw new DomainError("NOT_FOUND", "提案不存在");
    const conversation = await store.getConversation(principal.tenantId, artifact.conversationId);
    this.requireOwned(conversation, { kind: "internal", principal });
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

  /** Resolve citations to trusted source links (document deep links or canonical web URLs). */
  private async buildCitationLinks(
    tenantId: string,
    citations: readonly Citation[],
  ): Promise<Map<string, { href: string; title: string }>> {
    const links = new Map<string, { href: string; title: string }>();
    for (const citation of citations) {
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
    return links;
  }

  /** Split text nodes on verbatim citation quotes and attach link marks; collect used sources. */
  private linkTextNodes(
    content: InlineContent,
    citations: readonly Citation[],
    links: Map<string, { href: string; title: string }>,
    used: { href: string; title: string }[],
  ): { content: InlineContent; changed: boolean } {
    let changed = false;
    const next: InlineContent = [];
    for (const node of content) {
      if (node.type !== "text") {
        next.push(node);
        continue;
      }
      let matched: InlineContent | undefined;
      for (const citation of citations) {
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
    return { content: next, changed };
  }

  private referenceParagraph(
    referenceId: string,
    used: { href: string; title: string }[],
  ): DocumentBlock {
    return {
      type: "paragraph",
      attrs: { blockId: referenceId },
      content: [
        { type: "text", text: "参考资料：" },
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
  }

  private async decorateCitations(
    tenantId: string,
    payload: WritingProposalPayload,
    batch: OperationBatch,
  ): Promise<OperationBatch> {
    if (!payload.citations.length) return batch;
    const links = await this.buildCitationLinks(tenantId, payload.citations);
    const used: { href: string; title: string }[] = [];
    const operations = batch.operations.map((operation) => {
      if (operation.type !== "insert-block" && operation.type !== "replace-block") return operation;
      const block = operation.block;
      if (block.type !== "paragraph" && block.type !== "heading") return operation;
      if (!block.content) return operation;
      const linked = this.linkTextNodes(block.content, payload.citations, links, used);
      return linked.changed
        ? { ...operation, block: { ...block, content: linked.content } }
        : operation;
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
    return {
      ...batch,
      operations: [
        ...operations,
        {
          type: "insert-block",
          parentBlockId: null,
          ...(afterBlockId ? { afterBlockId } : {}),
          block: this.referenceParagraph(referenceId, used),
        },
      ],
    };
  }

  /**
   * Draft source links persist into the created document body just like proposal adoption:
   * inline link marks on quoted text plus one trailing reference paragraph. The draft artifact
   * itself stays immutable; decoration is deterministic so a retry binds identical content.
   */
  private async decorateDraftContent(
    tenantId: string,
    draft: WritingDraftPayload,
    referenceSeed: string,
  ): Promise<DocumentContent> {
    if (!draft.citations.length) return draft.content;
    const links = await this.buildCitationLinks(tenantId, draft.citations);
    const used: { href: string; title: string }[] = [];
    const blocks = draft.content.content.map((block): DocumentBlock => {
      if (block.type !== "paragraph" && block.type !== "heading") return block;
      if (!block.content) return block;
      const linked = this.linkTextNodes(block.content, draft.citations, links, used);
      return linked.changed ? { ...block, content: linked.content } : block;
    });
    if (!used.length) return { ...draft.content, content: blocks };
    const referenceId = `block_${hashContent([referenceSeed, "refs"]).slice(7, 55)}`;
    return {
      ...draft.content,
      content: [...blocks, this.referenceParagraph(referenceId, used)],
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

  // ------------------------------------------------------------- authority helpers

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

  private async audienceFor(conversation: ConversationRow): Promise<AssistantAudience> {
    if (conversation.identityId && !conversation.siteId) {
      const principal = await this.principalFor(conversation.tenantId, conversation.identityId);
      return { kind: "internal", principal };
    }
    if (!conversation.siteId || !conversation.visitorId)
      throw new DomainError("AI_ACCESS_REVOKED", "访客会话缺少站点上下文");
    const approved = await this.siteApproved(conversation);
    return {
      kind: "site",
      tenantId: conversation.tenantId,
      siteId: conversation.siteId,
      visitorId: conversation.visitorId,
      approved,
    };
  }

  /** Allowed history rebuild: revocation-aware so old evidence cannot leak into context. */
  private async buildAllowedHistory(
    audience: AssistantAudience,
    conversation: ConversationRow,
    run: RunRow,
  ): Promise<{ role: "user" | "assistant"; content: string }[]> {
    const store = this.deps.store;
    const messages = await store.listCommittedMessages(conversation.tenantId, conversation.id, 40);
    const beforeRun = messages.filter((m) => m.createdAt < run.createdAt && m.runId !== run.id);
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    let bytes = 0;
    for (const message of beforeRun.toReversed()) {
      if (turns.length >= HISTORY_LIMIT) break;
      const text = message.parts
        .filter((p) => p.kind === "text")
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");
      if (message.role === "assistant" && this.deps.rag) {
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
          const scope = this.retrievalScope(audience, {
            kind: "documents",
            documentIds: documentIdsOf(bundle),
          });
          if (!(await this.deps.rag.verifyStoredEvidence(scope, citedItems))) {
            allowed = false;
            break;
          }
        }
        if (!allowed) continue;
      }
      bytes += Buffer.byteLength(text);
      if (bytes > HISTORY_BYTE_LIMIT) break;
      turns.unshift({ role: message.role, content: text });
    }
    return turns;
  }

  /** qa-sites installs the per-site quota lookup; default keeps public traffic bounded. */
  siteQuota: (tenantId: string, siteId: string) => Promise<number> = async () => 120;

  siteApproved: (
    conversation: ConversationRow,
  ) => Promise<readonly { documentId: string; workspaceId: string; publicLabel: string }[]> =
    async () => {
      throw new DomainError("AI_ACCESS_REVOKED", "公开问答站点未注册");
    };

  siteStreamState: (conversation: ConversationRow) => Promise<{
    accessRevision: number;
    approved: readonly { documentId: string; workspaceId: string; publicLabel: string }[];
  }> = async () => {
    throw new DomainError("AI_ACCESS_REVOKED", "公开问答站点未注册");
  };
}

const ASSISTANT_DOMAIN_FAILURE: DomainFailureMap = {
  AI_ACCESS_REVOKED: "ACCESS_REVOKED",
  SERVICE_UNAVAILABLE: "KNOWLEDGE_NOT_READY",
};

function assistantFailureCode(error: unknown, aborted: boolean): string {
  if (error instanceof DshRuntimeError) return error.code;
  if (error instanceof DomainError) return ASSISTANT_DOMAIN_FAILURE[error.code] ?? "MODEL_FAILED";
  if (aborted) return "CANCELLED";
  return "MODEL_FAILED";
}

function audienceTenant(audience: AssistantAudience): string {
  return audience.kind === "internal" ? audience.principal.tenantId : audience.tenantId;
}

function documentIdsOf(bundle: EvidenceBundle): string[] {
  return [...new Set(bundle.items.map((i) => i.sourceId))];
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
