import { Type, type Static } from "@sinclair/typebox";
import {
  AssistantIntentSchema,
  AssistantPluginIdSchema,
  ScopeSelectionSchema,
} from "@zhishu/ai-contracts";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });

/**
 * One acceptance command for every assistant turn. Intent is a per-round hint, never an
 * engine or session selector; identity, revision checks, site caps, the effective plugin
 * subset and model configuration are resolved server-side.
 */
export const SubmitMessageSchema = Type.Object(
  {
    clientMessageId: id,
    idempotencyKey: id,
    text: Type.String({ minLength: 1, maxLength: 32_000 }),
    expectedContextRevision: Type.Integer({ minimum: 1 }),
    /** How the user wants help this round; defaults to question answering. */
    intentHint: Type.Optional(AssistantIntentSchema),
    /** Explicit per-message scope override; otherwise the stored selection applies. */
    scope: Type.Optional(ScopeSelectionSchema),
    /** Requested plugin subset; the server intersects it with the currently allowed set. */
    plugins: Type.Optional(
      Type.Array(AssistantPluginIdSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
    ),
    /**
     * Client-declared editing context. The server re-derives the authoritative capture
     * (generationId, durableSeq, contentHash, structureRevision) inside the accept transaction.
     */
    editorContext: Type.Optional(
      Type.Object(
        {
          documentId: id,
          target: Type.Union([
            Type.Object({ kind: Type.Literal("document") }, objectOptions),
            Type.Object(
              {
                kind: Type.Literal("selection"),
                blockIds: Type.Array(Type.String(), { minItems: 1, maxItems: 256 }),
              },
              objectOptions,
            ),
            Type.Object(
              {
                kind: Type.Literal("blocks"),
                blockIds: Type.Array(id, { minItems: 1, maxItems: 256, uniqueItems: true }),
              },
              objectOptions,
            ),
            Type.Object(
              { kind: Type.Literal("document-end"), afterBlockId: Type.Union([id, Type.Null()]) },
              objectOptions,
            ),
          ]),
        },
        objectOptions,
      ),
    ),
    /** Per-round intent to browse the web; the server combines this with key/config policy. */
    webSearch: Type.Optional(Type.Boolean()),
    referenceArtifactIds: Type.Optional(Type.Array(id, { maxItems: 8 })),
  },
  { ...objectOptions, $id: "SubmitMessage" },
);
export type SubmitMessage = Static<typeof SubmitMessageSchema>;

/**
 * Explicit user command to create a draft document from this conversation. The server accepts
 * a create-draft Run in the same session; the document is only created after the user accepted.
 */
export const CreateDraftSchema = Type.Object(
  {
    idempotencyKey: id,
    instruction: Type.String({ minLength: 1, maxLength: 8_000 }),
    /** Save location, chosen separately from the retrieval scope. */
    workspaceId: id,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    expectedContextRevision: Type.Integer({ minimum: 1 }),
    /** Evidence artifacts the draft may rely on; each is re-validated for access and distribution. */
    referenceArtifactIds: Type.Optional(Type.Array(id, { maxItems: 32, uniqueItems: true })),
  },
  { ...objectOptions, $id: "CreateDraft" },
);
export type CreateDraft = Static<typeof CreateDraftSchema>;

/** Explicit binding of an existing authorized document as the conversation target. */
export const BindTargetSchema = Type.Object(
  {
    targetDocumentId: id,
    expectedContextRevision: Type.Integer({ minimum: 1 }),
  },
  objectOptions,
);
export type BindTarget = Static<typeof BindTargetSchema>;

export const UpdateScopeSchema = Type.Object(
  {
    scope: ScopeSelectionSchema,
    /** The UI control must confirm the revision it replaced. */
    expectedContextRevision: Type.Integer({ minimum: 1 }),
  },
  objectOptions,
);
export type UpdateScope = Static<typeof UpdateScopeSchema>;

export const ApprovalDecisionSchema = Type.Object(
  {
    approvalId: id,
    decisionId: id,
    decision: Type.Union([Type.Literal("allow-once"), Type.Literal("reject")]),
  },
  objectOptions,
);
export type ApprovalDecision = Static<typeof ApprovalDecisionSchema>;

/** Final proposal review command; distinct from in-run tool approvals. */
export const ReviewProposalSchema = Type.Object(
  {
    decisionId: id,
    revision: Type.Integer({ minimum: 0, maximum: 256 }),
    action: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
    /** Omitted for a whole-proposal decision; names proposal block ids for partial accepts. */
    blockIds: Type.Optional(Type.Array(id, { maxItems: 256, uniqueItems: true })),
  },
  objectOptions,
);
export type ReviewProposal = Static<typeof ReviewProposalSchema>;

export const RetryRunCommandSchema = Type.Object(
  { expectedContextRevision: Type.Optional(Type.Integer({ minimum: 1 })) },
  objectOptions,
);
export type RetryRunCommand = Static<typeof RetryRunCommandSchema>;

export const ConversationPageSchema = Type.Object(
  {
    before: Type.Optional(Type.String({ maxLength: 160 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  objectOptions,
);
export type ConversationPage = Static<typeof ConversationPageSchema>;
