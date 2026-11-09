import { z } from "zod";
import {
  catalogIdSchema,
  documentIdSchema,
  workspaceIdSchema,
} from "../../shared/resource.schema.js";

export const knowledgeMoveSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    catalogId: catalogIdSchema,
    beforeId: documentIdSchema.nullable().default(null),
    metadataRevision: z.number().int().positive(),
    authorizationPreview: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export const knowledgeSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    workspaceId: workspaceIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(30).default(20),
  })
  .strict();
export const knowledgeSearchResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: documentIdSchema,
          title: z.string(),
          icon: z.string().nullable(),
          workspaceId: workspaceIdSchema,
          workspaceName: z.string(),
          path: z.array(z.string()),
          excerpt: z.string(),
          match: z.enum(["title", "content"]),
        })
        .strict(),
    ),
    hasMore: z.boolean(),
  })
  .strict();
export const presetInitializationSchema = z
  .object({
    items: z.array(
      z
        .object({
          presetId: z.string(),
          documentId: documentIdSchema,
          status: z.enum(["created", "existing", "removed"]),
        })
        .strict(),
    ),
  })
  .strict();
export type KnowledgeMoveInput = z.infer<typeof knowledgeMoveSchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchQuerySchema>;
