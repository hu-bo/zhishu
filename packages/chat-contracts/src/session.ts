import { Type, type Static } from "@sinclair/typebox";
import {
  CitationSchema,
  ProposalApplicationStateSchema,
  ProposalReviewSchema,
  RunUsageSchema,
  ScopeSelectionSchema,
  ToolApprovalSchema,
} from "@zhishu/ai-contracts";
import { StructureReceiptSchema } from "@zhishu/document-contracts";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });
const decimal = Type.String({ pattern: "^(0|[1-9][0-9]*)$" });
const timestamp = Type.String({ minLength: 1, maxLength: 40 });

export const ConversationStatusSchema = Type.Union(
  (["active", "target-unavailable", "closed"] as const).map((value) => Type.Literal(value)),
);
export type ConversationStatus = Static<typeof ConversationStatusSchema>;

export const ConversationSchema = Type.Object(
  {
    id,
    title: Type.String({ maxLength: 200 }),
    scope: ScopeSelectionSchema,
    contextRevision: Type.Integer({ minimum: 1 }),
    status: ConversationStatusSchema,
    targetDocumentId: Type.Optional(Type.Union([id, Type.Null()])),
    siteId: Type.Optional(id),
    eventSequence: decimal,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  objectOptions,
);
export type Conversation = Static<typeof ConversationSchema>;

/**
 * Message parts: text plus typed references. Display copy of evidence never lives here;
 * parts reference artifact/citation identities only.
 */
export const MessagePartSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("text"), text: Type.String({ maxLength: 128_000 }) },
    objectOptions,
  ),
  Type.Object({ kind: Type.Literal("citation"), citation: CitationSchema }, objectOptions),
  Type.Object(
    {
      kind: Type.Literal("artifact"),
      artifactId: id,
      artifactKind: Type.Union(
        (["evidence", "draft", "proposal", "image"] as const).map((value) => Type.Literal(value)),
      ),
      summary: Type.Optional(Type.String({ maxLength: 2_000 })),
    },
    objectOptions,
  ),
]);
export type MessagePart = Static<typeof MessagePartSchema>;

export const RunStatusSchema = Type.Union(
  (
    [
      "queued",
      "running",
      "waiting-approval",
      "completed",
      "interrupted",
      "failed",
      "cancelled",
    ] as const
  ).map((value) => Type.Literal(value)),
);
export type RunStatus = Static<typeof RunStatusSchema>;

/**
 * Run reference direction is conversation → Run → message. The Run DTO never carries a
 * back-pointer to its input message and never copies message bodies.
 */
export const RunSchema = Type.Object(
  {
    id,
    conversationId: id,
    status: RunStatusSchema,
    attempt: Type.Integer({ minimum: 1 }),
    contextRevision: Type.Integer({ minimum: 1 }),
    inputHash: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    errorCode: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" })),
    usage: Type.Optional(RunUsageSchema),
    cancelRequested: Type.Optional(Type.Boolean()),
    /** Active tool approval for runs in waiting-approval state. */
    approval: Type.Optional(ToolApprovalSchema),
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  objectOptions,
);
export type Run = Static<typeof RunSchema>;

export const MessageSchema = Type.Object(
  {
    id,
    conversationId: id,
    runId: id,
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    parts: Type.Array(MessagePartSchema, { maxItems: 512 }),
    clientMessageId: Type.Optional(id),
    createdAt: timestamp,
    committedAt: Type.Optional(timestamp),
  },
  objectOptions,
);
export type Message = Static<typeof MessageSchema>;

export const ArtifactSchema = Type.Object(
  {
    id,
    conversationId: id,
    runId: id,
    kind: Type.Union(
      (["evidence", "draft", "proposal", "image"] as const).map((value) => Type.Literal(value)),
    ),
    schemaVersion: Type.Integer({ minimum: 1 }),
    /** Bounded display summary; full payload is fetched per artifact under current permissions. */
    summary: Type.Optional(Type.String({ maxLength: 2_000 })),
    evidenceRefs: Type.Optional(Type.Array(id, { maxItems: 256 })),
    reviewRevision: Type.Optional(Type.Integer({ minimum: 0 })),
    review: Type.Optional(ProposalReviewSchema),
    applicationState: Type.Optional(ProposalApplicationStateSchema),
    receipt: Type.Optional(StructureReceiptSchema),
  },
  objectOptions,
);
export type Artifact = Static<typeof ArtifactSchema>;

export const ConversationSnapshotSchema = Type.Object(
  {
    conversation: ConversationSchema,
    messages: Type.Array(MessageSchema, { maxItems: 200 }),
    runs: Type.Array(RunSchema, { maxItems: 200 }),
    artifacts: Type.Array(ArtifactSchema, { maxItems: 200 }),
    cursor: decimal,
    hasMoreMessages: Type.Optional(Type.Boolean()),
  },
  objectOptions,
);
export type ConversationSnapshot = Static<typeof ConversationSnapshotSchema>;

const eventEnvelope = <T extends string, P extends import("@sinclair/typebox").TSchema>(
  type: T,
  payload: P,
) =>
  Type.Object(
    {
      eventId: id,
      conversationId: id,
      sequence: Type.String({ pattern: "^[1-9][0-9]*$" }),
      type: Type.Literal(type),
      entityId: id,
      createdAt: timestamp,
      payload,
    },
    objectOptions,
  );

/** Ordered product events. Entities travel in the payload; snapshots are rebuilt from tables. */
export const AiEventSchemas = {
  "message.created": eventEnvelope(
    "message.created",
    Type.Object({ message: MessageSchema }, objectOptions),
  ),
  "run.updated": eventEnvelope(
    "run.updated",
    Type.Object({ run: RunSchema, approval: Type.Optional(ToolApprovalSchema) }, objectOptions),
  ),
  "artifact.created": eventEnvelope(
    "artifact.created",
    Type.Object({ artifact: ArtifactSchema }, objectOptions),
  ),
  "artifact.application-updated": eventEnvelope(
    "artifact.application-updated",
    Type.Object(
      {
        artifactId: id,
        applicationState: ProposalApplicationStateSchema,
        reviewRevision: Type.Optional(Type.Integer({ minimum: 0 })),
        receipt: Type.Optional(StructureReceiptSchema),
        code: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" })),
      },
      objectOptions,
    ),
  ),
  "scope.changed": eventEnvelope(
    "scope.changed",
    Type.Object(
      {
        contextRevision: Type.Integer({ minimum: 1 }),
        scope: ScopeSelectionSchema,
        coverage: Type.Optional(
          Type.Object(
            {
              totalDocuments: Type.Integer({ minimum: 0 }),
              readyDocuments: Type.Integer({ minimum: 0 }),
            },
            objectOptions,
          ),
        ),
        cancelledRunIds: Type.Optional(Type.Array(id, { maxItems: 32 })),
      },
      objectOptions,
    ),
  ),
  /** Conversation-level binding/status changes, e.g. a draft document became the target. */
  "conversation.updated": eventEnvelope(
    "conversation.updated",
    Type.Object(
      {
        contextRevision: Type.Integer({ minimum: 1 }),
        status: ConversationStatusSchema,
        targetDocumentId: Type.Union([id, Type.Null()]),
      },
      objectOptions,
    ),
  ),
} as const;

export const AiEventSchema = Type.Union(Object.values(AiEventSchemas), { $id: "AiEvent" });
export type AiEvent = Static<typeof AiEventSchema>;
export type AiEventType = keyof typeof AiEventSchemas;

/** One live tool-call fact inside a preview stream; the process itself is never durable. */
export const PreviewToolSchema = Type.Object(
  {
    id: id,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    status: Type.Union(
      (["running", "completed", "failed"] as const).map((value) => Type.Literal(value)),
    ),
  },
  objectOptions,
);
export type PreviewTool = Static<typeof PreviewToolSchema>;

/**
 * Live preview frames only promise a preview. Formal answers require the durable
 * message.created event; formal body writes require a durable ack.
 */
export const PreviewFrameSchema = Type.Object(
  {
    type: Type.Literal("preview"),
    conversationId: id,
    runId: id,
    /** Identifies one continuous live stream; a new epoch resets the accumulated preview. */
    streamEpoch: id,
    attempt: Type.Integer({ minimum: 1 }),
    contextRevision: Type.Integer({ minimum: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    /** Dense position among public deltas, independent of private SDK chunks. */
    index: Type.Integer({ minimum: 0 }),
    /**
     * "text"/"thinking" carry dense delta streams; "tool" upserts one call by id;
     * "stage" is a coarse progress label.
     */
    channel: Type.Union(
      (["text", "stage", "thinking", "tool"] as const).map((value) => Type.Literal(value)),
    ),
    stage: Type.Optional(
      Type.Union(
        (["scope", "searching", "reading", "generating", "validating"] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
    ),
    tool: Type.Optional(PreviewToolSchema),
    text: Type.Optional(Type.String({ maxLength: 128_000 })),
  },
  { ...objectOptions, $id: "AiPreviewFrame" },
);
export type PreviewFrame = Static<typeof PreviewFrameSchema>;

export const ResyncFrameSchema = Type.Object(
  {
    type: Type.Literal("resync-required"),
    conversationId: id,
  },
  objectOptions,
);
export type ResyncFrame = Static<typeof ResyncFrameSchema>;

export const StreamFrameSchema = Type.Union([AiEventSchema, PreviewFrameSchema, ResyncFrameSchema]);
export type StreamFrame = Static<typeof StreamFrameSchema>;
