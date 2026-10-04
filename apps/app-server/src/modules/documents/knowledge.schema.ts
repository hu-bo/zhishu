import { z } from "zod";
import { catalogIdSchema, documentIconSchema } from "./document.schema.js";

export const workspaceIdSchema = z.string().regex(/^ws_[A-Za-z0-9_-]{1,64}$/);
const documentIdSchema = z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/);
export const workspaceParamsSchema = z.object({ workspaceId: workspaceIdSchema }).strict();
export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    name: z.string(),
    icon: z.string().nullable(),
    description: z.string(),
    createdBy: z.string(),
    rootCatalogId: catalogIdSchema,
    documentCount: z.number().int().nonnegative(),
  })
  .strict();
export const workspaceListSchema = z.array(workspaceSchema);
export const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1, "请输入空间名称").max(80, "空间名称不能超过 80 个字符"),
    icon: documentIconSchema.optional(),
    description: z.string().trim().max(200, "空间描述不能超过 200 个字符").default(""),
  })
  .strict();
export const knowledgeMoveSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    catalogId: catalogIdSchema,
    beforeId: documentIdSchema.nullable().default(null),
    metadataRevision: z.number().int().positive(),
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
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type KnowledgeMoveInput = z.infer<typeof knowledgeMoveSchema>;
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchQuerySchema>;
