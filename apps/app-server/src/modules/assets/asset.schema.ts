import { z } from "zod";

export const supportedAssetMediaTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

const assetIdSchema = z.string().regex(/^asset_[A-Za-z0-9_-]{1,64}$/);
const generationIdSchema = z.string().regex(/^gen_[A-Za-z0-9_-]{1,64}$/);
export const assetDocumentParamsSchema = z
  .object({ documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/) })
  .strict();

export const createAssetUploadBodySchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mediaType: z.enum(supportedAssetMediaTypes),
    size: z.number().int().min(1).max(104_857_600),
  })
  .strict();

export const assetUploadParamsSchema = z.object({ assetId: assetIdSchema }).strict();
export const documentAssetParamsSchema = assetDocumentParamsSchema.extend({
  assetId: assetIdSchema,
});

export const completeAssetUploadBodySchema = z
  .object({ sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/) })
  .strict();

export const assetUploadSchema = z
  .object({
    assetId: assetIdSchema,
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    fileName: z.string(),
    mediaType: z.enum(supportedAssetMediaTypes),
    size: z.number().int().positive(),
    uploadExpiresAt: z.string().datetime(),
    // Presigned PUT straight to the bucket: the bytes never pass through this API. The uploader
    // must send `x-amz-meta-sha256` with the digest it later reports to `/complete`.
    uploadUrl: z.string().url(),
    completePath: z.string(),
  })
  .strict();

export const assetSchema = z
  .object({
    assetId: assetIdSchema,
    documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/),
    fileName: z.string(),
    mediaType: z.enum(supportedAssetMediaTypes),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/),
    createdAt: z.string().datetime(),
  })
  .strict();

// `expiresAt: null` is the non-expiring mode: an unsigned object URL served straight from the
// bucket, available once the bucket policy allows anonymous reads.
export const assetAccessSchema = z
  .object({ url: z.string().url(), expiresAt: z.string().datetime().nullable() })
  .strict();

export const createAssetReferenceBodySchema = z
  .object({
    generationId: generationIdSchema,
    durableSeq: z.number().int().nonnegative(),
    blockId: z.string().regex(/^block_[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

export const assetReferenceSchema = z
  .object({
    assetId: assetIdSchema,
    blockId: z.string().regex(/^block_[A-Za-z0-9_-]{1,64}$/),
    generationId: generationIdSchema,
    referencedAt: z.string().datetime(),
  })
  .strict();

export const cancelAssetUploadSchema = z.object({ status: z.literal("cancelled") }).strict();

export type CreateAssetUploadInput = z.infer<typeof createAssetUploadBodySchema>;
export type CreateAssetReferenceInput = z.infer<typeof createAssetReferenceBodySchema>;
