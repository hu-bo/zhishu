import { z } from "zod";

/**
 * Zod route views mirroring the shared chat-contracts DTOs. Response serialization stays
 * explicit at the protocol boundary; the generated OpenAPI types drive the Orval client.
 */

export const scopeSelectionSchema = z.union([
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    kind: z.literal("workspaces"),
    workspaceIds: z.array(z.string()).min(1).max(8),
  }),
  z.strictObject({ kind: z.literal("documents"), documentIds: z.array(z.string()).min(1).max(64) }),
]);

export const assistantPluginIdSchema = z.enum(["scope", "rag", "research", "writing", "image"]);

export const conversationViewSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  scope: scopeSelectionSchema,
  contextRevision: z.number().int(),
  status: z.enum(["active", "target-unavailable", "closed"]),
  targetDocumentId: z.string().nullable().optional(),
  siteId: z.string().optional(),
  eventSequence: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const citationViewSchema = z.strictObject({
  citationId: z.string(),
  evidenceArtifactId: z.string(),
  evidenceId: z.string(),
  locator: z.union([
    z.strictObject({
      kind: z.literal("block"),
      blockId: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }),
    z.strictObject({ kind: z.literal("page"), page: z.number().int(), segmentId: z.string() }),
    z.strictObject({
      kind: z.literal("section"),
      sectionId: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }),
  ]),
  quote: z.string(),
});

export const messagePartViewSchema = z.union([
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("citation"), citation: citationViewSchema }),
  z.strictObject({
    kind: z.literal("artifact"),
    artifactId: z.string(),
    artifactKind: z.enum(["evidence", "draft", "proposal", "image"]),
    summary: z.string().optional(),
  }),
]);

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting-approval",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export const approvalViewSchema = z.strictObject({
  id: z.string(),
  attempt: z.number().int(),
  action: z.string(),
  description: z.string().optional(),
  status: z.enum(["pending", "allowed", "rejected", "cancelled", "expired", "unavailable"]),
  decisionId: z.string().optional(),
  decision: z.enum(["allow-once", "reject"]).optional(),
  requestedAt: z.string(),
  expiresAt: z.string(),
});

export const runViewSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  status: runStatusSchema,
  attempt: z.number().int(),
  contextRevision: z.number().int(),
  inputHash: z.string(),
  errorCode: z.string().optional(),
  usage: z
    .strictObject({
      modelCalls: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      searchCalls: z.number().int(),
      sourceReads: z.number().int(),
      webSearchCalls: z.number().int(),
      webReadCalls: z.number().int(),
      providerCredits: z.number().optional(),
      unknownCalls: z.number().int(),
    })
    .optional(),
  cancelRequested: z.boolean().optional(),
  approval: approvalViewSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const messageViewSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  runId: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(messagePartViewSchema),
  clientMessageId: z.string().optional(),
  createdAt: z.string(),
  committedAt: z.string().optional(),
});

export const artifactViewSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  runId: z.string(),
  kind: z.enum(["evidence", "draft", "proposal", "image"]),
  schemaVersion: z.number().int(),
  summary: z.string().optional(),
  evidenceRefs: z.array(z.string()).optional(),
  reviewRevision: z.number().int().optional(),
  review: z
    .strictObject({
      revision: z.number().int(),
      decisions: z.array(
        z.strictObject({ blockId: z.string(), action: z.enum(["accept", "reject"]) }),
      ),
      payloadHash: z.string().optional(),
      receipts: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  applicationState: z
    .enum(["pending", "partial", "applied", "rejected", "conflict", "unknown"])
    .optional(),
  receipt: z
    .strictObject({
      operationId: z.string(),
      generationId: z.string(),
      durableSeq: z.number().int(),
      structureRevision: z.number().int(),
    })
    .optional(),
});

export const snapshotViewSchema = z.strictObject({
  conversation: conversationViewSchema,
  messages: z.array(messageViewSchema),
  runs: z.array(runViewSchema),
  artifacts: z.array(artifactViewSchema),
  cursor: z.string(),
  hasMoreMessages: z.boolean().optional(),
});

export const aiEventViewSchema = z.strictObject({
  eventId: z.string(),
  conversationId: z.string(),
  sequence: z.string(),
  type: z.enum([
    "message.created",
    "run.updated",
    "artifact.created",
    "artifact.application-updated",
    "scope.changed",
    "conversation.updated",
  ]),
  entityId: z.string(),
  createdAt: z.string(),
  // Payloads vary by type; the client narrows through the shared chat-contracts guards.
  payload: z.record(z.string(), z.unknown()),
});

export const previewFrameViewSchema = z.strictObject({
  type: z.literal("preview"),
  conversationId: z.string(),
  runId: z.string(),
  streamEpoch: z.string(),
  attempt: z.number().int(),
  contextRevision: z.number().int(),
  revision: z.number().int(),
  index: z.number().int(),
  channel: z.enum(["text", "stage", "thinking", "tool"]),
  stage: z.enum(["scope", "searching", "reading", "generating", "validating"]).optional(),
  tool: z
    .object({
      id: z.string(),
      name: z.string(),
      status: z.enum(["running", "completed", "failed"]),
    })
    .strict()
    .optional(),
  text: z.string().optional(),
});

/** One acceptance command for every assistant turn; intent is a hint, never an engine fork. */
export const submitMessageBodySchema = z.strictObject({
  clientMessageId: z.string().min(1).max(160),
  idempotencyKey: z.string().min(1).max(160),
  text: z.string().min(1).max(32_000),
  expectedContextRevision: z.number().int().min(1),
  intentHint: z.enum(["qa", "writing"]).optional(),
  scope: scopeSelectionSchema.optional(),
  plugins: z.array(assistantPluginIdSchema).min(1).max(5).optional(),
  editorContext: z
    .strictObject({
      documentId: z.string().min(1).max(160),
      target: z.union([
        z.strictObject({ kind: z.literal("document") }),
        z.strictObject({
          kind: z.literal("selection"),
          blockIds: z.array(z.string()).min(1).max(256),
        }),
        z.strictObject({
          kind: z.literal("blocks"),
          blockIds: z.array(z.string()).min(1).max(256),
        }),
        z.strictObject({
          kind: z.literal("document-end"),
          afterBlockId: z.string().max(160).nullable(),
        }),
      ]),
    })
    .optional(),
  webSearch: z.boolean().optional(),
  referenceArtifactIds: z.array(z.string()).max(8).optional(),
});

/** Public visitors may only ask questions over approved material; no writing/web/plugin fields. */
export const publicSubmitBodySchema = z.strictObject({
  clientMessageId: z.string().min(1).max(160),
  idempotencyKey: z.string().min(1).max(160),
  text: z.string().min(1).max(32_000),
  expectedContextRevision: z.number().int().min(1),
  scope: scopeSelectionSchema.optional(),
});

/** Explicit user command creating a draft document from this conversation. */
export const createDraftBodySchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(160),
  instruction: z.string().min(1).max(8_000),
  workspaceId: z.string().min(1).max(160),
  title: z.string().min(1).max(200).optional(),
  expectedContextRevision: z.number().int().min(1),
  referenceArtifactIds: z.array(z.string()).max(32).optional(),
});

/** Explicit binding of an existing authorized document as the conversation target. */
export const bindTargetBodySchema = z.strictObject({
  targetDocumentId: z.string().min(1).max(160),
  expectedContextRevision: z.number().int().min(1),
});

export const scopeBodySchema = z.strictObject({
  scope: scopeSelectionSchema,
  expectedContextRevision: z.number().int().min(1),
});

export const conversationIdParamsSchema = z.strictObject({
  id: z.string().regex(/^ai_[a-f0-9]{32}$/),
});
export const runParamsSchema = z.strictObject({
  id: z.string().regex(/^ai_[a-f0-9]{32}$/),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/),
});
export const messageIdParamsSchema = z.strictObject({
  id: z.string().regex(/^ai_[a-f0-9]{32}$/),
  messageId: z.string().min(1).max(160),
});
export const artifactIdParamsSchema = z.strictObject({
  artifactId: z.string().regex(/^art_[a-f0-9]{32}$/),
});
