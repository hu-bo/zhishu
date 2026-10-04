import { z } from "zod";
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from "@zhishu/document-contracts";
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

export const documentIconSchema = z
  .string()
  .trim()
  .max(32)
  .refine((value) => {
    const graphemes = [...new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(value)];
    return (
      graphemes.length === 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
    );
  }, "请选择一个 Emoji 图标")
  .nullable();
const documentTagsSchema = z
  .array(
    z
      .object({
        label: z.string().trim().min(1).max(24),
        color: z.enum(["slate", "indigo", "violet", "green", "amber", "rose"]),
      })
      .strict(),
  )
  .max(12)
  .refine((tags) => new Set(tags.map((tag) => tag.label)).size === tags.length, "标签名称不能重复");
export type DocumentTag = z.infer<typeof documentTagsSchema>[number];

export const catalogIdSchema = z.string().regex(/^cat_[A-Za-z0-9_-]{1,64}$/);

export const createDocumentBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).default("未命名文档"),
    mode: z.enum(["standard", "collaborative"]).default("collaborative"),
    workspaceId: z
      .string()
      .regex(/^ws_[A-Za-z0-9_-]{1,64}$/)
      .default("ws_default"),
    catalogId: catalogIdSchema.nullable().default(null),
  })
  .strict();

export const updateDocumentBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    icon: documentIconSchema.optional(),
    tags: documentTagsSchema.optional(),
    metadataRevision: z.number().int().positive(),
  })
  .strict()
  .refine(
    (input) => input.title !== undefined || input.icon !== undefined || input.tags !== undefined,
    "请提供需要更新的文档信息",
  );

export const documentListQuerySchema = z
  .object({
    view: z.enum(["all", "mine", "recent", "favorites", "archived", "trash"]).default("recent"),
    q: z.string().trim().max(200).optional(),
    workspaceId: z
      .string()
      .regex(/^ws_[A-Za-z0-9_-]{1,64}$/)
      .optional(),
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
    workspaceId: z.string(),
    catalogId: catalogIdSchema,
    position: z.number().int().nonnegative(),
    icon: documentIconSchema,
    tags: documentTagsSchema,
    createdBy: z.string(),
    mode: z.enum(["standard", "collaborative"]),
    generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    schemaVersion: z.number().int().positive(),
    extensions: z.array(extensionSchema),
    durableSeq: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    metadataRevision: z.number().int().positive(),
    canManage: z.boolean(),
  })
  .strict();

export const documentContentSchema = z
  .object({
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    mode: z.enum(["standard", "collaborative"]),
    readOnly: z.boolean(),
    schemaVersion: z.number().int().positive(),
    extensions: z.array(extensionSchema),
    generationId: z
      .string()
      .regex(/^gen_[A-Za-z0-9_-]{1,64}$/)
      .nullable(),
    durableSeq: z.number().int().nonnegative().nullable(),
    snapshotRevision: z.number().int().positive(),
    content: z.unknown(),
  })
  .strict();

export const putDocumentContentBodySchema = z
  .object({
    expectedSnapshotRevision: z.number().int().positive(),
    content: z.unknown(),
  })
  .strict();

export const documentListItemSchema = documentSchema.extend({
  isFavorite: z.boolean(),
  canManage: z.boolean(),
  deletedAt: z.string().datetime().nullable(),
  snapshotRevision: z.number().int().positive().nullable(),
  workspaceName: z.string(),
  excerpt: z.string(),
});
export const documentListSchema = z
  .object({ items: z.array(documentListItemSchema), hasMore: z.boolean() })
  .strict();

export const documentParamsSchema = z
  .object({ documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/) })
  .strict();

export const copyDocumentBodySchema = z
  .object({ title: z.string().trim().min(1).max(200).default("未命名文档") })
  .strict();

const versionIdSchema = z.string().regex(/^ver_[A-Za-z0-9_-]{1,64}$/);

export const documentVersionParamsSchema = documentParamsSchema.extend({
  versionId: versionIdSchema,
});

export const createDocumentVersionBodySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("collaborative"),
      name: z.string().trim().min(1).max(200),
      expectedGenerationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
      expectedDurableSeq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("standard"),
      name: z.string().trim().min(1).max(200),
      expectedSnapshotRevision: z.number().int().positive(),
    })
    .strict(),
]);

export const restoreDocumentVersionBodySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("collaborative"),
      expectedGenerationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
      expectedDurableSeq: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("standard"),
      expectedSnapshotRevision: z.number().int().positive(),
    })
    .strict(),
]);

export const documentVersionSchema = z
  .object({
    id: versionIdSchema,
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
    sourceMode: z.enum(["standard", "collaborative"]),
    snapshotRevision: z.number().int().positive().nullable(),
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
    sourceMode: z.enum(["standard", "collaborative"]),
    schemaVersion: z.number().int().positive(),
    durableSeq: z.number().int().nonnegative(),
    snapshotRevision: z.number().int().positive().nullable(),
    content: z.unknown(),
  })
  .strict();

const portableDocumentContentSchema = z
  .object({ type: z.literal("doc"), content: z.array(z.unknown()) })
  .passthrough();

export const exportDocumentSchema = z
  .object({
    format: z.literal("zhishu.document"),
    formatVersion: z.literal(1),
    title: z.string(),
    schemaVersion: z.number().int().positive(),
    extensions: z.array(extensionSchema),
    content: portableDocumentContentSchema,
  })
  .strict();

export const importDocumentBodySchema = z
  .object({
    format: z.literal("zhishu.document"),
    formatVersion: z.literal(1),
    title: z.string().trim().min(1).max(200).default("Imported document"),
    schemaVersion: z.number().int().positive(),
    extensions: z.array(extensionSchema).max(128).default([]),
    content: z.unknown(),
  })
  .strict();

const importReportIssueSchema = z
  .object({
    code: z.string(),
    path: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  })
  .strict();

const importReportSchema = z
  .object({
    formatVersion: z.literal(1),
    issues: z.array(importReportIssueSchema),
    blockCount: z.number().int().nonnegative(),
    assetCount: z.number().int().nonnegative(),
  })
  .strict();

export const importDocumentResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      document: documentSchema,
      report: importReportSchema,
    })
    .strict(),
  z.object({ status: z.literal("rejected"), report: importReportSchema }).strict(),
]);

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

export const documentAclListSchema = z.array(documentAclSchema);

export const collaborationSessionBodySchema = z
  .object({
    schemaVersion: z.number().int().positive().default(CURRENT_DOCUMENT_SCHEMA_VERSION),
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
export type CopyDocumentInput = z.infer<typeof copyDocumentBodySchema>;
export type ImportDocumentInput = z.infer<typeof importDocumentBodySchema>;
export type PutDocumentContentInput = z.infer<typeof putDocumentContentBodySchema>;
export type CreateDocumentVersionInput = z.infer<typeof createDocumentVersionBodySchema>;
export type RestoreDocumentVersionInput = z.infer<typeof restoreDocumentVersionBodySchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentBodySchema>;
export type CollaborationSessionInput = z.infer<typeof collaborationSessionBodySchema>;
