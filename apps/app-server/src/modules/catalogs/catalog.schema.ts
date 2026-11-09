import { z } from "zod";
import {
  catalogIdSchema,
  emojiIconSchema as documentIconSchema,
} from "../../shared/resource.schema.js";
import { documentIdSchema, workspaceIdSchema } from "../../shared/resource.schema.js";

export const catalogParamsSchema = z.object({ catalogId: catalogIdSchema }).strict();

export const catalogWorkspaceParamsSchema = z
  .object({ workspaceId: workspaceIdSchema, catalogId: catalogIdSchema })
  .strict();

export const catalogSchema = z
  .object({
    id: catalogIdSchema,
    name: z.string(),
    icon: z.string().nullable(),
    parentId: catalogIdSchema.nullable(),
    workspaceId: workspaceIdSchema,
    position: z.number().int().nonnegative(),
    canManage: z.boolean(),
    canWrite: z.boolean(),
    canMove: z.boolean(),
  })
  .strict();

export const createCatalogBodySchema = z
  .object({
    name: z.string().trim().min(1, "请输入目录名称").max(40, "目录名称不能超过 40 个字符"),
    icon: documentIconSchema.optional(),
    parentId: catalogIdSchema.nullable().default(null),
    beforeId: catalogIdSchema.nullable().default(null),
  })
  .strict();

export const updateCatalogBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "请输入目录名称")
      .max(40, "目录名称不能超过 40 个字符")
      .optional(),
    icon: documentIconSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.icon !== undefined,
    "请提供需要更新的目录信息",
  );

export const moveCatalogBodySchema = z
  .object({
    parentId: catalogIdSchema,
    beforeId: catalogIdSchema.nullable().default(null),
    authorizationPreview: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const catalogChildrenSchema = z
  .object({
    catalog: z
      .object({
        id: catalogIdSchema,
        name: z.string(),
        icon: z.string().nullable(),
        parentId: catalogIdSchema.nullable(),
        isRoot: z.boolean(),
        canManage: z.boolean(),
        canWrite: z.boolean(),
        canMove: z.boolean(),
      })
      .strict(),
    catalogs: z.array(
      z
        .object({
          id: catalogIdSchema,
          name: z.string(),
          icon: z.string().nullable(),
          position: z.number().int().nonnegative(),
          hasChildren: z.boolean(),
          canManage: z.boolean(),
          canWrite: z.boolean(),
          canMove: z.boolean(),
        })
        .strict(),
    ),
    documents: z.array(
      z
        .object({
          id: documentIdSchema,
          title: z.string(),
          icon: z.string().nullable(),
          position: z.number().int().nonnegative(),
          updatedAt: z.string().datetime(),
          createdBy: z.string(),
          metadataRevision: z.number().int().positive(),
          canWrite: z.boolean(),
          canMove: z.boolean(),
          canManage: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const catalogDeletionImpactSchema = z
  .object({
    catalogCount: z.number().int().nonnegative(),
    documentCount: z.number().int().nonnegative(),
  })
  .strict();

export const documentLocateSchema = z
  .object({
    documentId: documentIdSchema,
    workspaceId: workspaceIdSchema,
    workspaceName: z.string(),
    workspaceIcon: z.string().nullable(),
    catalogId: catalogIdSchema.nullable(),
    catalogPath: z.array(z.object({ id: catalogIdSchema, name: z.string() }).strict()),
  })
  .strict();

export type CreateCatalogInput = z.infer<typeof createCatalogBodySchema>;
export type UpdateCatalogInput = z.infer<typeof updateCatalogBodySchema>;
export type MoveCatalogInput = z.infer<typeof moveCatalogBodySchema>;
