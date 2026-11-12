import { Type, type Static } from "@sinclair/typebox";
import { AnchorSchema } from "@zhishu/document-contracts";
import { ScopeSelectionSchema, WritingIntentSchema } from "@zhishu/ai-contracts";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 160 });

/**
 * Message acceptance command shared by both purposes; the URL selects the purpose, and the
 * discriminated member carries the purpose-specific extras. Identity, revision checks,
 * site caps and model configuration are resolved server-side.
 */
const base = {
  clientMessageId: id,
  idempotencyKey: id,
  text: Type.String({ minLength: 1, maxLength: 32_000 }),
  expectedContextRevision: Type.Integer({ minimum: 1 }),
};
export const QaSubmitMessageSchema = Type.Object(
  {
    purpose: Type.Literal("qa"),
    ...base,
    /** Explicit per-message scope override; otherwise the stored selection applies. */
    scope: Type.Optional(ScopeSelectionSchema),
    /** Preferences only affect presentation; retrieval budgets stay server-side. */
    detail: Type.Optional(Type.Union([Type.Literal("brief"), Type.Literal("detailed")])),
  },
  objectOptions,
);
export const WritingSubmitMessageSchema = Type.Object(
  {
    purpose: Type.Literal("writing"),
    ...base,
    intent: Type.Optional(WritingIntentSchema),
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
                anchor: AnchorSchema,
                selectedText: Type.String({ maxLength: 8_000 }),
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
  objectOptions,
);
export const SubmitMessageSchema = Type.Union([QaSubmitMessageSchema, WritingSubmitMessageSchema], {
  $id: "SubmitMessage",
});
export type QaSubmitMessage = Static<typeof QaSubmitMessageSchema>;
export type WritingSubmitMessage = Static<typeof WritingSubmitMessageSchema>;
export type SubmitMessage = Static<typeof SubmitMessageSchema>;

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

/** QA → writing handoff: chosen answers/artifacts plus the writing ask. */
export const CreateWritingSessionSchema = Type.Object(
  {
    /** Chosen assistant messages whose evidence may carry over after re-validation. */
    messageIds: Type.Array(id, { minItems: 1, maxItems: 16, uniqueItems: true }),
    artifactIds: Type.Optional(Type.Array(id, { maxItems: 16, uniqueItems: true })),
    instruction: Type.String({ minLength: 1, maxLength: 8_000 }),
    intent: Type.Optional(WritingIntentSchema),
    targetDocumentId: Type.Optional(Type.Union([id, Type.Null()])),
    /** Duplicate clicks resolve to the same session instead of creating new ones. */
    creationKey: id,
  },
  objectOptions,
);
export type CreateWritingSession = Static<typeof CreateWritingSessionSchema>;
