import { z } from "zod";
import { documentIconSchema } from "./document.schema.js";
import { documentLocateSchema } from "./catalog.schema.js";

const documentIdSchema = z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/);
const extensionSchema = z
  .object({
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    required: z.boolean(),
  })
  .strict();

export const shareIdSchema = z.string().regex(/^shr_[A-Za-z0-9_-]{1,64}$/);
export const sharePermissionSchema = z.enum(["read", "edit"]);

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1_000;

export const createShareBodySchema = z
  .object({
    permission: sharePermissionSchema,
    expiresAt: z.string().datetime("请选择有效的过期时间"),
  })
  .strict()
  .superRefine((input, ctx) => {
    const expires = Date.parse(input.expiresAt);
    if (Number.isNaN(expires)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "请选择有效的过期时间" });
      return;
    }
    const now = Date.now();
    if (expires <= now)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "过期时间必须晚于当前时间" });
    else if (expires - now > ONE_YEAR_MS)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "有效期需在未来一年之内" });
  });

export const documentSharesParamsSchema = z.object({ documentId: documentIdSchema }).strict();
export const documentShareParamsSchema = z
  .object({ documentId: documentIdSchema, shareId: shareIdSchema })
  .strict();
export const shareParamsSchema = z.object({ shareId: shareIdSchema }).strict();
export const shareAssetParamsSchema = z
  .object({ shareId: shareIdSchema, assetId: z.string().regex(/^asset_[A-Za-z0-9_-]{1,64}$/) })
  .strict();

export const shareSchema = z
  .object({
    id: shareIdSchema,
    documentId: documentIdSchema,
    permission: sharePermissionSchema,
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    createdBy: z.string(),
    joinCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const shareListSchema = z.array(shareSchema).max(50);

export const publicShareDetailSchema = z
  .object({
    shareId: shareIdSchema,
    state: z.enum(["active", "expired", "revoked", "unknown"]),
    permission: sharePermissionSchema.nullable(),
    expiresAt: z.string().datetime().nullable(),
    document: z
      .object({
        id: documentIdSchema,
        title: z.string(),
        icon: documentIconSchema,
        updatedAt: z.string().datetime(),
        schemaVersion: z.number().int().positive(),
        extensions: z.array(extensionSchema),
        generationId: z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const shareJoinResultSchema = documentLocateSchema.extend({ joined: z.boolean() }).strict();

export type CreateShareInput = z.infer<typeof createShareBodySchema>;
