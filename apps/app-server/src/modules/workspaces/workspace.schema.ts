import { z } from "zod";
import {
  workspaceParamsSchema,
  catalogIdSchema,
  workspaceIdSchema,
  emojiIconSchema as documentIconSchema,
} from "../../shared/resource.schema.js";
export { workspaceParamsSchema } from "../../shared/resource.schema.js";
export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    name: z.string(),
    kind: z.enum(["personal", "team", "unclassified"]),
    personalOwnerId: z.string().nullable(),
    ownerIdentityId: z.string().nullable(),
    authorizationRevision: z.number().int().positive(),
    offlineCacheAllowed: z.boolean(),
    icon: z.string().nullable(),
    description: z.string(),
    createdBy: z.string(),
    rootCatalogId: catalogIdSchema,
    documentCount: z.number().int().nonnegative(),
    memberCount: z.number().int().nonnegative(),
    role: z.enum(["owner", "admin", "editor", "viewer"]),
    canManage: z.boolean(),
    canOrganize: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const workspaceListSchema = z.array(workspaceSchema);
export const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1, "请输入空间名称").max(80, "空间名称不能超过 80 个字符"),
    icon: documentIconSchema.optional(),
    description: z.string().trim().max(200, "空间描述不能超过 200 个字符").default(""),
  })
  .strict();
export const createWorkspaceSchema = updateWorkspaceSchema
  .extend({ kind: z.enum(["personal", "team"]).default("team") })
  .strict();
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export const workspaceMemberParamsSchema = workspaceParamsSchema
  .extend({
    identityId: z.string().trim().min(1).max(200),
  })
  .strict();
export const setWorkspaceMemberSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    role: z.enum(["admin", "editor", "viewer"]),
  })
  .strict();
export const workspaceMemberSchema = z
  .object({
    identityId: z.string(),
    displayName: z.string(),
    email: z.string(),
    role: z.enum(["owner", "admin", "editor", "viewer"]),
    createdAt: z.string().datetime(),
  })
  .strict();
export const workspaceMemberListSchema = z.array(workspaceMemberSchema);
export type SetWorkspaceMemberInput = z.infer<typeof setWorkspaceMemberSchema>;
