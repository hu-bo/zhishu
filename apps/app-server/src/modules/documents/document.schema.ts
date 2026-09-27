import { z } from "zod";
import { documentPermissionActions } from "./document.permissions.js";

const extensionSchema = z
  .object({
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    required: z.boolean(),
  })
  .strict();

const identityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:@-]+$/);

export const createDocumentBodySchema = z
  .object({ title: z.string().trim().min(1).max(200).default("未命名文档") })
  .strict();

export const updateDocumentBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    metadataRevision: z.number().int().positive(),
  })
  .strict();

export const documentListQuerySchema = z
  .object({
    view: z.enum(["all", "mine", "recent", "favorites", "archived", "trash"]).default("recent"),
    q: z.string().trim().max(200).optional(),
    sort: z.enum(["recent", "updated", "created", "title"]).default("recent"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .strict();

export const documentSchema = z
  .object({
    id: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    tenantId: z.string(),
    title: z.string(),
    generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    schemaVersion: z.number().int().positive(),
    extensions: z.array(extensionSchema),
    durableSeq: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    metadataRevision: z.number().int().positive(),
  })
  .strict();

export const documentListItemSchema = documentSchema.extend({
  isFavorite: z.boolean(),
  canManage: z.boolean(),
  deletedAt: z.string().datetime().nullable(),
});
export const documentListSchema = z
  .object({ items: z.array(documentListItemSchema), hasMore: z.boolean() })
  .strict();

export const documentParamsSchema = z
  .object({ documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/) })
  .strict();

export const copyDocumentBodySchema = createDocumentBodySchema;

const versionIdSchema = z.string().regex(/^ver_[A-Za-z0-9_-]{1,64}$/);

export const documentVersionParamsSchema = documentParamsSchema.extend({
  versionId: versionIdSchema,
});

export const createDocumentVersionBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    expectedGenerationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    expectedDurableSeq: z.number().int().nonnegative(),
  })
  .strict();

export const restoreDocumentVersionBodySchema = z
  .object({
    expectedGenerationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    expectedDurableSeq: z.number().int().nonnegative(),
  })
  .strict();

export const documentVersionSchema = z
  .object({
    id: versionIdSchema,
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    name: z.string(),
    kind: z.enum(["named", "automatic"]),
    durableSeq: z.number().int().nonnegative(),
    createdBy: identityIdSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const documentVersionsSchema = z.array(documentVersionSchema);

export const documentVersionContentSchema = z
  .object({
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    schemaVersion: z.number().int().positive(),
    durableSeq: z.number().int().nonnegative(),
    content: z.unknown(),
  })
  .strict();

export const documentAclParamsSchema = documentParamsSchema.extend({
  identityId: identityIdSchema,
});

export const setDocumentAclBodySchema = z
  .object({
    actions: z
      .array(z.enum(documentPermissionActions))
      .min(1)
      .max(documentPermissionActions.length),
  })
  .strict()
  .refine((value) => new Set(value.actions).size === value.actions.length);

export const documentAclSchema = z
  .object({
    documentId: z.string(),
    identityId: identityIdSchema,
    actions: z.array(z.enum(documentPermissionActions)),
  })
  .strict();

export const collaborationSessionBodySchema = z
  .object({
    schemaVersion: z.number().int().positive().default(1),
    extensions: z.array(extensionSchema).max(128).default([]),
  })
  .strict();

export const collaborationSessionSchema = z
  .object({
    documentId: z.string(),
    generationId: z.string(),
    schemaVersion: z.number().int().positive(),
    extensions: z.array(extensionSchema),
    compatibility: z.object({ readable: z.literal(true), writable: z.boolean() }).strict(),
    durableSeq: z.number().int().nonnegative(),
    documentName: z.string(),
    providerUrl: z.string().url(),
    token: z.string(),
    expiresAt: z.string().datetime(),
    readOnly: z.boolean(),
    capabilities: z.object({ durableAck: z.literal(true), readOnly: z.literal(true) }).strict(),
  })
  .strict();

export const errorResponseSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
});

export type CreateDocumentInput = z.infer<typeof createDocumentBodySchema>;
export type CreateDocumentVersionInput = z.infer<typeof createDocumentVersionBodySchema>;
export type RestoreDocumentVersionInput = z.infer<typeof restoreDocumentVersionBodySchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentBodySchema>;
export type CollaborationSessionInput = z.infer<typeof collaborationSessionBodySchema>;
