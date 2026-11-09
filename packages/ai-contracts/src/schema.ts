import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { AnchorSchema, OperationBatchSchema } from "@zhishu/document-contracts";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
export const AuthoringDocumentVersionSchema = Type.Object(
  {
    documentId: id,
    generationId: id,
    durableSeq: integer,
    contentHash: hash,
  },
  objectOptions,
);
export const AuthoringTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("document") }, objectOptions),
  Type.Object(
    { kind: Type.Literal("selection"), anchor: AnchorSchema, selectedTextHash: hash },
    objectOptions,
  ),
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
export const AuthoringRequestSchema = Type.Object(
  {
    kind: Type.Literal("authoring"),
    requestId: id,
    intent: Type.Union(
      (
        [
          "auto",
          "create",
          "continue",
          "rewrite",
          "rewrite-document",
          "summarize",
          "translate",
          "research",
        ] as const
      ).map((value) => Type.Literal(value)),
    ),
    document: AuthoringDocumentVersionSchema,
    baseStructureRevision: integer,
    target: AuthoringTargetSchema,
    instruction: Type.String({ minLength: 1, maxLength: 8_000 }),
    contextRef: Type.Optional(id),
    constraints: Type.Optional(
      Type.Object(
        {
          language: Type.Optional(Type.String({ maxLength: 80 })),
          maxBlocks: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
          maxCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
        },
        objectOptions,
      ),
    ),
  },
  { ...objectOptions, $id: "AuthoringRequest" },
);
export const AnswerRequestSchema = Type.Object(
  {
    kind: Type.Literal("answer"),
    requestId: id,
    question: Type.String({ minLength: 1, maxLength: 8_000 }),
    contextRef: id,
  },
  objectOptions,
);
export const AiTaskRequestSchema = Type.Union([AuthoringRequestSchema, AnswerRequestSchema]);
export const ChatRequestSchema = Type.Object(
  {
    kind: Type.Literal("chat"),
    requestId: id,
    message: Type.String({ minLength: 1, maxLength: 8_000 }),
    responseMode: Type.Union([Type.Literal("discussion"), Type.Literal("grounded")]),
    contextRef: Type.Optional(id),
    previousRequestIds: Type.Optional(Type.Array(id, { maxItems: 16, uniqueItems: true })),
  },
  { ...objectOptions, $id: "ChatRequest" },
);
// Keep v1 closed: callers must explicitly negotiate v2 before accepting Chat.
export const AiTaskRequestV2Schema = Type.Union([
  AuthoringRequestSchema,
  AnswerRequestSchema,
  ChatRequestSchema,
]);
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
export const SourceReferenceSchema = Type.Object(
  { sourceId: id, snapshotId: id, locator: SourceLocatorSchema },
  objectOptions,
);
export const EvidenceItemSchema = Type.Object(
  {
    evidenceId: id,
    source: SourceReferenceSchema,
    title: Type.String({ maxLength: 512 }),
    text: Type.String({ maxLength: 100_000 }),
  },
  objectOptions,
);
export const EvidenceBundleSchema = Type.Object(
  { items: Type.Array(EvidenceItemSchema, { maxItems: 256 }), freshness: Type.Literal("current") },
  objectOptions,
);
export const SourceCitationSchema = Type.Object(
  {
    citationId: id,
    source: SourceReferenceSchema,
    quote: Type.String({ minLength: 1, maxLength: 8_000 }),
  },
  objectOptions,
);
export const AuthoringProposalSchema = Type.Object(
  {
    proposalId: id,
    requestId: id,
    document: AuthoringDocumentVersionSchema,
    baseStructureRevision: integer,
    target: AuthoringTargetSchema,
    operationBatch: OperationBatchSchema,
    summary: Type.String({ maxLength: 2_000 }),
    citations: Type.Array(SourceCitationSchema, { maxItems: 32 }),
  },
  { ...objectOptions, $id: "AuthoringProposal" },
);
export const AnswerResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("answered"), Type.Literal("insufficient-evidence")]),
    text: Type.String({ maxLength: 64_000 }),
    citations: Type.Array(SourceCitationSchema, { maxItems: 32 }),
  },
  objectOptions,
);
export const ChatResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("replied"), Type.Literal("insufficient-evidence")]),
    text: Type.String({ minLength: 1, maxLength: 64_000 }),
    citations: Type.Array(SourceCitationSchema, { maxItems: 32 }),
  },
  { ...objectOptions, $id: "ChatResult" },
);
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
  "CHECKPOINT_UNAVAILABLE",
  "THREAD_EXISTS",
  "INCOMPATIBLE_CHECKPOINT",
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];
const event = <V extends 1 | 2, T extends string, P extends import("@sinclair/typebox").TSchema>(
  protocolVersion: V,
  type: T,
  payload: P,
) =>
  Type.Object(
    {
      protocolVersion: Type.Literal(protocolVersion),
      requestId: id,
      seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      type: Type.Literal(type),
      payload,
    },
    objectOptions,
  );
const eventSchemas = <V extends 1 | 2, K extends TSchema, R extends TSchema>(
  version: V,
  kinds: K,
  resultKinds: R,
) => [
  event(version, "started", Type.Object({ kind: kinds }, objectOptions)),
  event(
    version,
    "progress",
    Type.Object(
      {
        stage: Type.Union(
          (["planning", "searching", "reading", "generating"] as const).map((value) =>
            Type.Literal(value),
          ),
        ),
      },
      objectOptions,
    ),
  ),
  event(
    version,
    "text-delta",
    Type.Object({ text: Type.String({ maxLength: 16_000 }) }, objectOptions),
  ),
  event(version, "proposal", AuthoringProposalSchema),
  event(version, "answer", AnswerResultSchema),
  event(
    version,
    "completed",
    Type.Object(
      {
        resultKind: resultKinds,
        usage: Type.Optional(
          Type.Object(
            {
              inputTokens: integer,
              outputTokens: integer,
              modelCalls: integer,
              searchCalls: integer,
              sourceReads: integer,
            },
            objectOptions,
          ),
        ),
      },
      objectOptions,
    ),
  ),
  event(
    version,
    "failed",
    Type.Object(
      {
        code: Type.Union(AI_ERROR_CODES.map((value) => Type.Literal(value))),
        retryable: Type.Boolean(),
      },
      objectOptions,
    ),
  ),
];
// Separate v1 declarations preserve its derived TypeScript union as well as its wire shape.
export const AiTaskEventSchema = Type.Union(
  eventSchemas(
    1,
    Type.Union([Type.Literal("authoring"), Type.Literal("answer")]),
    Type.Union([Type.Literal("proposal"), Type.Literal("answer")]),
  ),
  { $id: "AiTaskEvent" },
);
export const AiTaskEventV2Schema = Type.Union(
  [
    ...eventSchemas(
      2,
      Type.Union([Type.Literal("authoring"), Type.Literal("answer"), Type.Literal("chat")]),
      Type.Union([Type.Literal("proposal"), Type.Literal("answer"), Type.Literal("chat")]),
    ),
    event(2, "chat", ChatResultSchema),
  ],
  { $id: "AiTaskEventV2" },
);
export type AuthoringDocumentVersion = Static<typeof AuthoringDocumentVersionSchema>;
export type AuthoringTarget = Static<typeof AuthoringTargetSchema>;
export type AuthoringRequest = Static<typeof AuthoringRequestSchema>;
export const isReplacementIntent = (intent: AuthoringRequest["intent"]): boolean =>
  intent === "rewrite" || intent === "translate" || intent === "rewrite-document";
export type AnswerRequest = Static<typeof AnswerRequestSchema>;
export type AiTaskRequest = Static<typeof AiTaskRequestSchema>;
export type ChatRequest = Static<typeof ChatRequestSchema>;
export type AiTaskRequestV2 = Static<typeof AiTaskRequestV2Schema>;
export type SourceLocator = Static<typeof SourceLocatorSchema>;
export type SourceReference = Static<typeof SourceReferenceSchema>;
export type SourceCitation = Static<typeof SourceCitationSchema>;
export type EvidenceItem = Static<typeof EvidenceItemSchema>;
export type EvidenceBundle = Static<typeof EvidenceBundleSchema>;
export type AuthoringProposal = Static<typeof AuthoringProposalSchema>;
export const isReplacementProposal = (request: AuthoringRequest, proposal: AuthoringProposal) =>
  request.intent === "auto"
    ? proposal.target.kind === "document" || proposal.target.kind === "blocks"
    : isReplacementIntent(request.intent);
export type AnswerResult = Static<typeof AnswerResultSchema>;
export type AiTaskEvent = Static<typeof AiTaskEventSchema>;
export type ChatResult = Static<typeof ChatResultSchema>;
export type AiTaskEventV2 = Static<typeof AiTaskEventV2Schema>;
