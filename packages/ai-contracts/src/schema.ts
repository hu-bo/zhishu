import { Type, type Static } from "@sinclair/typebox";
import { DocumentContentSchema, OperationBatchSchema } from "@zhishu/document-contracts";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });

/** Persistent document identity used by target capture, proposals and evidence versioning. */
export const DocumentVersionSchema = Type.Object(
  {
    documentId: id,
    generationId: id,
    durableSeq: integer,
    contentHash: hash,
  },
  objectOptions,
);
export type DocumentVersion = Static<typeof DocumentVersionSchema>;

/**
 * Proposal target. Selection is resolved to `blocks` at the request boundary by the
 * application, so persisted targets always name durable block identities.
 */
export const WritingTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("document") }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("blocks"),
      blocks: Type.Array(Type.Object({ blockId: id, contentHash: hash }, objectOptions), {
        minItems: 1,
        maxItems: 256,
      }),
    },
    objectOptions,
  ),
  Type.Object(
    { kind: Type.Literal("document-end"), afterBlockId: Type.Union([id, Type.Null()]) },
    objectOptions,
  ),
]);
export type WritingTarget = Static<typeof WritingTargetSchema>;

export const WRITING_INTENTS = [
  "auto",
  "create",
  "continue",
  "rewrite",
  "rewrite-document",
  "summarize",
  "translate",
  "research",
] as const;
export const WritingIntentSchema = Type.Union(WRITING_INTENTS.map((value) => Type.Literal(value)));
export type WritingIntent = Static<typeof WritingIntentSchema>;

/** One user-selected knowledge scope. Server re-evaluates the authorized set every round. */
export const ScopeSelectionSchema = Type.Union([
  Type.Object({ kind: Type.Literal("all") }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("workspaces"),
      workspaceIds: Type.Array(id, { minItems: 1, maxItems: 8, uniqueItems: true }),
    },
    objectOptions,
  ),
  Type.Object(
    {
      kind: Type.Literal("documents"),
      documentIds: Type.Array(id, { minItems: 1, maxItems: 64, uniqueItems: true }),
    },
    objectOptions,
  ),
]);
export type ScopeSelection = Static<typeof ScopeSelectionSchema>;

export const SourceLocatorSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("block"), blockId: id, start: integer, end: integer },
    objectOptions,
  ),
  Type.Object(
    { kind: Type.Literal("page"), page: Type.Integer({ minimum: 1 }), segmentId: id },
    objectOptions,
  ),
  Type.Object(
    { kind: Type.Literal("section"), sectionId: id, start: integer, end: integer },
    objectOptions,
  ),
]);
export type SourceLocator = Static<typeof SourceLocatorSchema>;

/**
 * Source metadata lives only inside evidence artifacts. Each source is unique by
 * (sourceId, snapshotId); derived products reference evidence identities instead.
 */
export const DocumentEvidenceSourceSchema = Type.Object(
  {
    sourceKind: Type.Literal("document"),
    sourceId: id,
    snapshotId: id,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    workspaceId: id,
    documentId: id,
    generationId: id,
    durableSeq: id,
    metadataRevision: id,
    indexVersion: id,
    /** Workspace label the current principal may see; null hides the space entirely. */
    workspaceLabel: Type.Optional(
      Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    ),
  },
  objectOptions,
);
export const WebContentKindSchema = Type.Union([
  Type.Literal("search-snippet"),
  Type.Literal("extracted"),
]);
export const WebEvidenceSourceSchema = Type.Object(
  {
    sourceKind: Type.Literal("web"),
    sourceId: id,
    snapshotId: id,
    title: Type.String({ minLength: 1, maxLength: 512 }),
    canonicalUrl: Type.String({ minLength: 1, maxLength: 2_048 }),
    siteName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    retrievedAt: Type.String({ minLength: 1, maxLength: 40 }),
    publishedAt: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
    contentHash: hash,
    contentKind: WebContentKindSchema,
  },
  objectOptions,
);
export const EvidenceSourceSchema = Type.Union([
  DocumentEvidenceSourceSchema,
  WebEvidenceSourceSchema,
]);
export type EvidenceSource = Static<typeof EvidenceSourceSchema>;
export type DocumentEvidenceSource = Static<typeof DocumentEvidenceSourceSchema>;
export type WebEvidenceSource = Static<typeof WebEvidenceSourceSchema>;

/** A text slice of one registered source. Metadata is never copied per slice. */
export const EvidenceItemSchema = Type.Object(
  {
    evidenceId: id,
    sourceId: id,
    snapshotId: id,
    locator: SourceLocatorSchema,
    text: Type.String({ minLength: 1, maxLength: 100_000 }),
  },
  objectOptions,
);
export type EvidenceItem = Static<typeof EvidenceItemSchema>;

/**
 * Evidence payload persisted in `ai_artifacts.payload` for kind = evidence.
 * `freshness` "current" vouches only for document sources at delivery time;
 * web entries describe the snapshot captured at `retrievedAt`.
 */
export const EvidenceBundleSchema = Type.Object(
  {
    sources: Type.Array(EvidenceSourceSchema, { maxItems: 256 }),
    items: Type.Array(EvidenceItemSchema, { maxItems: 256 }),
    freshness: Type.Literal("current"),
  },
  objectOptions,
);
export type EvidenceBundle = Static<typeof EvidenceBundleSchema>;

/** Final citation produced by the server from registered evidence, never model-authored links. */
export const CitationSchema = Type.Object(
  {
    citationId: id,
    evidenceArtifactId: id,
    evidenceId: id,
    locator: SourceLocatorSchema,
    quote: Type.String({ minLength: 1, maxLength: 8_000 }),
  },
  objectOptions,
);
export type Citation = Static<typeof CitationSchema>;

/** What the model may emit: identifiers of evidence already registered for this Run. */
export const ModelCitationSchema = Type.Object(
  { evidenceId: id, quote: Type.String({ minLength: 1, maxLength: 8_000 }) },
  objectOptions,
);
export type ModelCitation = Static<typeof ModelCitationSchema>;

export const WritingConstraintsSchema = Type.Optional(
  Type.Object(
    {
      language: Type.Optional(Type.String({ maxLength: 80 })),
      maxBlocks: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
      maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
    },
    objectOptions,
  ),
);

/** The writing instruction accepted for one Run. Identity lives on the Run, not here. */
export const WritingRequestSchema = Type.Object(
  {
    intent: WritingIntentSchema,
    instruction: Type.String({ minLength: 1, maxLength: 8_000 }),
    target: WritingTargetSchema,
    constraints: WritingConstraintsSchema,
  },
  { ...objectOptions, $id: "WritingRequest" },
);
export type WritingRequest = Static<typeof WritingRequestSchema>;

/**
 * The only proposal payload. Identity is artifact.id / runId externally; no proposalId
 * or requestId is stored inside.
 */
export const WritingProposalPayloadSchema = Type.Object(
  {
    document: DocumentVersionSchema,
    baseStructureRevision: integer,
    target: WritingTargetSchema,
    operationBatch: OperationBatchSchema,
    summary: Type.String({ maxLength: 2_000 }),
    citations: Type.Array(CitationSchema, { maxItems: 32 }),
  },
  { ...objectOptions, $id: "WritingProposalPayload" },
);
export type WritingProposalPayload = Static<typeof WritingProposalPayloadSchema>;

/** Bounded model output for one answer generation step. */
export const QaAnswerOutputSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("answered"), Type.Literal("insufficient-evidence")]),
    text: Type.String({ minLength: 1, maxLength: 32_000 }),
    citations: Type.Array(ModelCitationSchema, { maxItems: 32 }),
  },
  objectOptions,
);
export type QaAnswerOutput = Static<typeof QaAnswerOutputSchema>;

/** Final QA result committed as one assistant message. */
export const QaAnswerSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("answered"), Type.Literal("insufficient-evidence")]),
    text: Type.String({ minLength: 1, maxLength: 64_000 }),
    citations: Type.Array(CitationSchema, { maxItems: 32 }),
    evidenceArtifactId: Type.Optional(id),
  },
  objectOptions,
);
export type QaAnswer = Static<typeof QaAnswerSchema>;

/**
 * The immutable draft artifact produced by a user-accepted create-draft Run. Content carries
 * deterministic block identities compiled once; retries reuse it instead of regenerating.
 * The document body itself is created from this payload and then lives only in collaboration.
 */
export const WritingDraftPayloadSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    content: DocumentContentSchema,
    summary: Type.String({ maxLength: 2_000 }),
    citations: Type.Array(CitationSchema, { maxItems: 32 }),
  },
  { ...objectOptions, $id: "WritingDraftPayload" },
);
export type WritingDraftPayload = Static<typeof WritingDraftPayloadSchema>;

/** The action actually accepted for one Run; never an engine selector. */
export const AssistantCommandSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("create-draft"),
]);
export type AssistantCommand = Static<typeof AssistantCommandSchema>;

/** Per-turn user intent: how the assistant should help this round, not a session purpose. */
export const AssistantIntentSchema = Type.Union([Type.Literal("qa"), Type.Literal("writing")]);
export type AssistantIntent = Static<typeof AssistantIntentSchema>;

export const ASSISTANT_PLUGIN_IDS = ["scope", "rag", "research", "writing", "image"] as const;
export const AssistantPluginIdSchema = Type.Union(
  ASSISTANT_PLUGIN_IDS.map((value) => Type.Literal(value)),
);
export type AssistantPluginId = Static<typeof AssistantPluginIdSchema>;

/** `ai_runs.context`: everything accepted at admission; never a body or history copy. */
export const AssistantRunContextSchema = Type.Object(
  {
    contextRevision: Type.Integer({ minimum: 1 }),
    configurationId: Type.Optional(id),
    command: AssistantCommandSchema,
    intentHint: AssistantIntentSchema,
    /** Server-validated plugin subset effective for this Run; re-checked at every tool call. */
    plugins: Type.Array(AssistantPluginIdSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    scope: ScopeSelectionSchema,
    webSearch: Type.Boolean(),
    /** Target document capture taken at admission; concurrent baseline lives here on purpose. */
    capture: Type.Optional(
      Type.Object(
        {
          document: DocumentVersionSchema,
          structureRevision: integer,
          selectedTextHash: Type.Optional(hash),
        },
        objectOptions,
      ),
    ),
    request: Type.Optional(WritingRequestSchema),
    /** Reference material selected explicitly for this message. */
    referenceArtifactIds: Type.Optional(Type.Array(id, { maxItems: 32 })),
    /** Accepted create-draft command inputs; absent for chat Runs. */
    draft: Type.Optional(
      Type.Object(
        {
          workspaceId: id,
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        },
        objectOptions,
      ),
    ),
  },
  objectOptions,
);
export type AssistantRunContext = Static<typeof AssistantRunContextSchema>;

/** Step ledger written into `ai_runs.execution` by the flow; ids are stable across attempts. */
export const ExecutionStepSchema = Type.Object(
  {
    stepId: Type.String({ minLength: 1, maxLength: 160 }),
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
    ]),
    evidenceArtifactId: Type.Optional(id),
    updatedAt: Type.String({ minLength: 1, maxLength: 40 }),
  },
  objectOptions,
);
export type ExecutionStep = Static<typeof ExecutionStepSchema>;

/**
 * Evidence handed to the model, including sources that only back history context.
 * Revocation rebuilds allowed context from this ledger, not from displayed citations.
 */
export const EvidenceRefSchema = Type.Object(
  { evidenceArtifactId: id, evidenceId: id },
  objectOptions,
);
export type EvidenceRef = Static<typeof EvidenceRefSchema>;

export const ToolApprovalSchema = Type.Object(
  {
    id: id,
    attempt: Type.Integer({ minimum: 1 }),
    action: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ maxLength: 1_000 })),
    status: Type.Union(
      (["pending", "allowed", "rejected", "cancelled", "expired", "unavailable"] as const).map(
        (value) => Type.Literal(value),
      ),
    ),
    decisionId: Type.Optional(id),
    decision: Type.Optional(Type.Union([Type.Literal("allow-once"), Type.Literal("reject")])),
    requestedAt: Type.String({ minLength: 1, maxLength: 40 }),
    expiresAt: Type.String({ minLength: 1, maxLength: 40 }),
  },
  objectOptions,
);
export type ToolApproval = Static<typeof ToolApprovalSchema>;

/**
 * Unified native execution ledger for every Run. Evidence refs record everything actually
 * handed to the model, including history backing sources, not only displayed citations.
 */
export const AssistantExecutionSchema = Type.Object(
  {
    nativeSessionId: Type.Optional(id),
    nativeMessageId: Type.Optional(id),
    /** Durable-before-deliver flag: the native user message identity was persisted first. */
    deliveryConfirmed: Type.Optional(Type.Boolean()),
    turn: Type.Optional(Type.Integer({ minimum: 0 })),
    approval: Type.Optional(ToolApprovalSchema),
    evidenceRefs: Type.Array(EvidenceRefSchema, { maxItems: 256 }),
    evidenceArtifactIds: Type.Array(id, { maxItems: 64 }),
    proposalArtifactIds: Type.Array(id, { maxItems: 32 }),
    /** Immutable draft produced by a create-draft Run; binding reuses it on retry. */
    draftArtifactId: Type.Optional(id),
    /** Result committed as staged assistant message; recovery re-delivers it without regenerating. */
    stagedMessageId: Type.Optional(id),
    steps: Type.Array(ExecutionStepSchema, { maxItems: 64 }),
  },
  objectOptions,
);
export type AssistantExecution = Static<typeof AssistantExecutionSchema>;

/** Single product metering source: reservations and settled usage for one Run. */
export const RunUsageSchema = Type.Object(
  {
    modelCalls: integer,
    inputTokens: integer,
    outputTokens: integer,
    searchCalls: integer,
    sourceReads: integer,
    webSearchCalls: integer,
    webReadCalls: integer,
    /** Provider-reported credits when the vendor returns them; never a guessed price. */
    providerCredits: Type.Optional(Type.Number({ minimum: 0 })),
    /** Billable side effects whose outcome is not yet reconciled keep the reservation. */
    unknownCalls: integer,
  },
  objectOptions,
);
export type RunUsage = Static<typeof RunUsageSchema>;

export const DEFAULT_RUN_USAGE: RunUsage = Object.freeze({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  searchCalls: 0,
  sourceReads: 0,
  webSearchCalls: 0,
  webReadCalls: 0,
  unknownCalls: 0,
});

/** Execution limits shared by both flows; injected configuration may lower them. */
export const GenerationLimitsSchema = Type.Object(
  {
    timeoutMs: Type.Integer({ minimum: 1_000, maximum: 2_147_483_647 }),
    maxInputTokens: Type.Integer({ minimum: 1 }),
    maxOutputTokens: Type.Integer({ minimum: 1 }),
    maxOutputBytes: Type.Integer({ minimum: 1 }),
    maxModelCalls: Type.Integer({ minimum: 1, maximum: 100 }),
    maxSearchCalls: Type.Integer({ minimum: 0, maximum: 100 }),
    maxSourceReads: Type.Integer({ minimum: 0, maximum: 100 }),
    webSearchCallsPerRun: Type.Integer({ minimum: 0, maximum: 20 }),
    webSearchResultsPerCall: Type.Integer({ minimum: 1, maximum: 20 }),
    webReadPagesPerRun: Type.Integer({ minimum: 0, maximum: 20 }),
    webExtractMaxBytes: Type.Integer({ minimum: 1_024 }),
  },
  objectOptions,
);
export type GenerationLimits = Static<typeof GenerationLimitsSchema>;
export const DEFAULT_GENERATION_LIMITS: GenerationLimits = Object.freeze({
  timeoutMs: 120_000,
  maxInputTokens: 32_768,
  maxOutputTokens: 4_096,
  maxOutputBytes: 128_000,
  maxModelCalls: 12,
  maxSearchCalls: 6,
  maxSourceReads: 6,
  webSearchCallsPerRun: 3,
  webSearchResultsPerCall: 5,
  webReadPagesPerRun: 5,
  webExtractMaxBytes: 64_000,
});

/** Distinct web failure semantics: an empty result is data, a provider fault is never "no facts". */
export const WEB_FAILURE_CODES = [
  "NOT_CONFIGURED",
  "AUTH_FAILED",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "EMPTY_RESULTS",
  "EXTRACT_FAILED",
  "BUDGET_EXCEEDED",
] as const;
export type WebFailureCode = (typeof WEB_FAILURE_CODES)[number];

export const AI_ERROR_CODES = [
  "CANCELLED",
  "TIMEOUT",
  "RATE_LIMITED",
  "MODEL_FAILED",
  "INVALID_OUTPUT",
  "INVALID_CITATION",
  "INSUFFICIENT_EVIDENCE",
  "TARGET_CONFLICT",
  "ACCESS_REVOKED",
  "UNSUPPORTED_TARGET",
  "PROTOCOL_ERROR",
  "BUDGET_EXCEEDED",
  "OUTPUT_UNKNOWN",
  "KNOWLEDGE_NOT_READY",
  "RETRIEVAL_FAILED",
  "WEB_PROVIDER_FAILED",
  "SIDE_EFFECT_REVIEW_REQUIRED",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];
export const RUN_ERROR_CODE_PATTERN = "^[A-Z][A-Z0-9_]{0,63}$";

/** Proposal review lives on the artifact row, never inside the generated payload. */
export const ProposalDecisionSchema = Type.Object(
  {
    blockId: id,
    action: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
  },
  objectOptions,
);
export type ProposalDecision = Static<typeof ProposalDecisionSchema>;
export const ProposalReviewSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0, maximum: 256 }),
    decisions: Type.Array(ProposalDecisionSchema, { maxItems: 512 }),
    /** Fingerprint of the accepted body so a stale decision page cannot confirm the wrong text. */
    payloadHash: Type.Optional(hash),
    /** decisionId → request fingerprint: duplicate decisions return the original receipt. */
    receipts: Type.Optional(Type.Record(id, hash, { maxProperties: 512 })),
  },
  objectOptions,
);
export type ProposalReview = Static<typeof ProposalReviewSchema>;

export const ProposalApplicationStateSchema = Type.Union(
  (["pending", "partial", "applied", "rejected", "conflict", "unknown"] as const).map((value) =>
    Type.Literal(value),
  ),
);
export type ProposalApplicationState = Static<typeof ProposalApplicationStateSchema>;
