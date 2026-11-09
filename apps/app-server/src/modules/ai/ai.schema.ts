import { z } from "zod";
import {
  validateAiTaskRequest,
  validateChatRequest,
  validateSchema,
  AuthoringProposalSchema,
  ChatResultSchema,
  type AuthoringRequest,
  type ChatRequest,
  type AuthoringProposal,
  type ChatResult,
  type AuthoringDocumentVersion,
  type ReplacementReview,
} from "@zhishu/ai-contracts";
import { validateDocumentSnapshot, type DocumentSnapshot } from "@zhishu/document-contracts";
import type { StructureReceipt } from "../collaboration/owner.js";
export interface AiTaskView {
  requestId: string;
  status: "running" | "interrupted" | "completed" | "failed" | "cancelled";
  kind: "authoring" | "chat" | "answer";
  review: ReplacementReview | null;
  result: AuthoringProposal | ChatResult | null;
  errorCode: string | null;
  application: {
    state: "none" | "pending" | "partial" | "rejected" | "applied" | "conflict" | "blocked";
    code: string | null;
    receipt: StructureReceipt | null;
  };
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    searchCalls: number;
    sourceReads: number;
  };
  createdAt: string;
  expiresAt: string;
}
export interface AiDocumentContextView {
  snapshot: DocumentSnapshot;
  version: AuthoringDocumentVersion;
  structureRevision: number;
  workspaceId: string;
  title: string;
  aiWritable: boolean;
  reason: string | null;
}
export const aiRequestIdSchema = z.string().min(1).max(160);
export const aiParamsSchema = z.object({ requestId: aiRequestIdSchema }).strict();
export const aiDocumentParamsSchema = z
  .object({ documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/) })
  .strict();
const sources = z
  .array(z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/))
  .max(4)
  .refine((ids) => new Set(ids).size === ids.length)
  .default([]);
export const authoringBodySchema = z
  .object({
    protocolVersion: z.literal(1).default(1),
    request: z.custom<AuthoringRequest>((value) => {
      const result = validateAiTaskRequest(value);
      return result.success && result.data.kind === "authoring";
    }),
    previousRequestIds: z.array(aiRequestIdSchema).max(16).default([]),
    sourceDocumentIds: sources,
  })
  .strict();
export const chatBodySchema = z
  .object({
    protocolVersion: z.literal(2),
    request: z.custom<ChatRequest>((value) => validateChatRequest(value).success),
    sourceDocumentIds: sources,
    sourceWorkspaceId: z
      .string()
      .regex(/^ws_[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict();
export const reviewBodySchema = z
  .object({
    decisionId: z.string().uuid(),
    revision: z.number().int().min(0).max(256),
    action: z.enum(["accept", "reject"]),
    blockIds: z
      .array(z.string().min(1).max(160))
      .min(1)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
  })
  .strict();
export type ReviewAiInput = z.infer<typeof reviewBodySchema>;
const receiptSchema = z
  .object({
    operationId: z.string(),
    generationId: z.string(),
    durableSeq: z.number().int().nonnegative(),
    structureRevision: z.number().int().nonnegative(),
  })
  .strict();
export const aiTaskSchema: z.ZodType<AiTaskView> = z
  .object({
    requestId: aiRequestIdSchema,
    status: z.enum(["running", "interrupted", "completed", "failed", "cancelled"]),
    kind: z.enum(["authoring", "chat", "answer"]),
    review: z
      .object({
        revision: z.number().int().nonnegative(),
        decisions: z.array(
          z.object({ blockId: z.string(), action: z.enum(["accept", "reject"]) }).strict(),
        ),
        version: z
          .object({
            documentId: z.string(),
            generationId: z.string(),
            durableSeq: z.number().int().nonnegative(),
            contentHash: z.string(),
          })
          .strict(),
        structureRevision: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    result: z
      .custom<AuthoringProposal | ChatResult>(
        (value) =>
          validateSchema(AuthoringProposalSchema, value).success ||
          validateSchema(ChatResultSchema, value).success,
      )
      .nullable(),
    errorCode: z.string().nullable(),
    application: z
      .object({
        state: z.enum(["none", "pending", "partial", "rejected", "applied", "conflict", "blocked"]),
        code: z.string().nullable(),
        receipt: receiptSchema.nullable(),
      })
      .strict(),
    usage: z
      .object({
        modelCalls: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        searchCalls: z.number(),
        sourceReads: z.number(),
      })
      .strict(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export const aiCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    protocolVersions: z.array(z.number()),
    reason: z.string().nullable(),
    supportsTokenPreview: z.boolean(),
    chatDelivery: z.literal("complete-result"),
    knowledge: z.object({ enabled: z.boolean(), reason: z.string().nullable() }).strict(),
  })
  .strict();
export const aiDocumentContextSchema: z.ZodType<AiDocumentContextView> = z
  .object({
    snapshot: z.custom<DocumentSnapshot>((value) => validateDocumentSnapshot(value).success),
    version: z.object({
      documentId: z.string(),
      generationId: z.string(),
      durableSeq: z.number().int(),
      contentHash: z.string(),
    }),
    structureRevision: z.number().int(),
    workspaceId: z.string(),
    title: z.string(),
    aiWritable: z.boolean(),
    reason: z.string().nullable(),
  })
  .strict();
