import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "../identity/identity.types.js";
import { AssetRepository } from "./asset.repository.js";
import type { AssetRecord } from "./asset.repository.js";
import type { CreateAssetReferenceInput, CreateAssetUploadInput } from "./asset.schema.js";
import { supportedAssetMediaTypes } from "./asset.schema.js";
import { AssetObjectStorage, type StoredObject } from "./asset-storage.js";

const imageMagicChecks: Record<
  (typeof supportedAssetMediaTypes)[number],
  (bytes: Buffer) => boolean
> = {
  "image/jpeg": (bytes) =>
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (bytes) =>
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP",
  "application/pdf": (bytes) => bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-",
};

function sanitizeFileName(fileName: string): string {
  return (
    fileName
      .replaceAll("\\", "_")
      .replaceAll("/", "_")
      .replace(/\p{Cc}/gu, "_")
      .trim()
      .slice(0, 255) || "upload.bin"
  );
}

function presentAsset(asset: AssetRecord) {
  if (!asset.actualSize || !asset.sha256 || !asset.completedAt) {
    throw new Error("A ready asset is missing validated upload metadata");
  }
  return {
    assetId: asset.id,
    documentId: asset.documentId,
    fileName: asset.fileName,
    mediaType: asset.mediaType as (typeof supportedAssetMediaTypes)[number],
    size: asset.actualSize,
    sha256: asset.sha256,
    createdAt: asset.createdAt.toISOString(),
  };
}

export class AssetService {
  constructor(
    private readonly repository: AssetRepository,
    private readonly storage: AssetObjectStorage | null,
    private readonly options: {
      maxBytes: number;
      maxTenantBytes: number;
      uploadTtlSeconds: number;
      accessUrlTtlSeconds: number;
      orphanRetentionSeconds: number;
    },
  ) {}

  private requireStorage(): AssetObjectStorage {
    if (!this.storage) {
      throw new DomainError("SERVICE_UNAVAILABLE", "Private asset storage is not configured");
    }
    return this.storage;
  }

  async createUpload(
    principal: Principal,
    documentId: string,
    input: CreateAssetUploadInput,
    idempotencyKey?: string,
  ) {
    const storage = this.requireStorage();
    if (input.size > this.options.maxBytes) {
      throw new DomainError("VALIDATION_ERROR", "Asset exceeds the configured upload limit");
    }
    const expiresAt = new Date(Date.now() + this.options.uploadTtlSeconds * 1_000);
    const file = { ...input, fileName: sanitizeFileName(input.fileName) };
    const asset = await this.repository.createUpload({
      principal,
      documentId,
      file,
      objectKey: `tenants/${principal.tenantId}/documents/${documentId}/${randomUUID()}`,
      maxBytes: this.options.maxBytes,
      maxTenantBytes: this.options.maxTenantBytes,
      expiresAt,
      ...(idempotencyKey
        ? {
            idempotency: {
              key: idempotencyKey,
              requestHash: createHash("sha256")
                .update(JSON.stringify({ documentId, file }))
                .digest("hex"),
            },
          }
        : {}),
    });
    if (!asset) throw new DomainError("NOT_FOUND", "Document not found or write access denied");
    return {
      assetId: asset.id,
      documentId: asset.documentId,
      fileName: asset.fileName,
      mediaType: asset.mediaType as (typeof supportedAssetMediaTypes)[number],
      size: asset.declaredSize,
      uploadExpiresAt: asset.uploadExpiresAt.toISOString(),
      // The bytes go straight from the browser to the bucket; only completion comes back here.
      uploadUrl: await storage.createUploadUrl({
        objectKey: asset.objectKey,
        expiresIn: this.options.uploadTtlSeconds,
      }),
      completePath: `/api/asset-uploads/${asset.id}/complete`,
    };
  }

  /**
   * Verifies an object the browser uploaded itself. The signature cannot constrain the request, so
   * everything is re-read from storage: the size must match what the session reserved, the stored
   * media type and magic number must match each other, and the digest claimed here must be the one
   * written into the object metadata. A mismatch leaves the session open, and the oversized or
   * broken object is removed by the orphan cleanup once the session expires.
   */
  async completeUpload(principal: Principal, assetId: string, sha256: string) {
    const storage = this.requireStorage();
    if (!/^[A-Fa-f0-9]{64}$/.test(sha256)) {
      throw new DomainError("VALIDATION_ERROR", "Asset digest is not a sha256 hex string");
    }
    const current = await this.repository.getForAction(principal, assetId, "write");
    if (!current) throw new DomainError("NOT_FOUND", "Asset upload not found");
    if (current.status === "ready") {
      if (current.sha256 !== sha256) {
        throw new DomainError("CONFLICT", "Asset upload already contains different content");
      }
      return presentAsset(current);
    }
    if (current.status !== "uploading") {
      throw new DomainError("CONFLICT", "Asset upload is not open");
    }
    if (current.uploadExpiresAt.getTime() <= Date.now()) {
      throw new DomainError("CONFLICT", "Asset upload session has expired");
    }
    let object: StoredObject;
    let prefix: Buffer;
    try {
      object = await storage.head(current.objectKey);
      prefix = await storage.readPrefix(current.objectKey, 16);
    } catch (error) {
      throw new DomainError("SERVICE_UNAVAILABLE", "Asset storage is unavailable", undefined, {
        cause: error,
      });
    }
    if (object.size !== current.declaredSize || object.sha256 !== sha256) {
      throw new DomainError("VALIDATION_ERROR", "Stored object does not match the upload session");
    }
    const mediaType = current.mediaType as (typeof supportedAssetMediaTypes)[number];
    if (object.mediaType !== mediaType || !imageMagicChecks[mediaType]?.(prefix)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Uploaded file content does not match its media type",
      );
    }
    const asset = await this.repository.finalizeUpload({
      principal,
      assetId,
      actualSize: object.size,
      sha256,
    });
    if (!asset) throw new DomainError("CONFLICT", "Asset upload changed before completion");
    return presentAsset(asset);
  }

  async cancelUpload(principal: Principal, assetId: string) {
    const storage = this.requireStorage();
    const asset = await this.repository.cancelUpload(principal, assetId);
    if (!asset) throw new DomainError("NOT_FOUND", "Cancellable upload not found");
    await storage.delete(asset.objectKey);
    return { status: "cancelled" as const };
  }

  async createAccess(principal: Principal, assetId: string) {
    const storage = this.requireStorage();
    const asset = await this.repository.getForAction(principal, assetId, "read");
    if (!asset || asset.status !== "ready") throw new DomainError("NOT_FOUND", "Asset not found");
    return storage.createReadUrl({
      objectKey: asset.objectKey,
      fileName: asset.fileName,
      mediaType: asset.mediaType,
      expiresIn: this.options.accessUrlTtlSeconds,
    });
  }

  async addReference(
    principal: Principal,
    documentId: string,
    assetId: string,
    input: CreateAssetReferenceInput,
  ) {
    const added = await this.repository.addReference({
      principal,
      documentId,
      assetId,
      reference: input,
    });
    if (!added)
      throw new DomainError("CONFLICT", "Asset reference does not match saved document state");
    return {
      assetId,
      blockId: input.blockId,
      generationId: input.generationId,
      referencedAt: new Date().toISOString(),
    };
  }

  async cleanOrphans() {
    const storage = this.requireStorage();
    const now = new Date();
    const candidates = await this.repository.listOrphaned({
      before: new Date(now.getTime() - this.options.orphanRetentionSeconds * 1_000),
      expiredBefore: now,
      limit: 100,
    });
    const deletedIds: string[] = [];
    for (const candidate of candidates) {
      try {
        await storage.delete(candidate.objectKey);
        deletedIds.push(candidate.id);
      } catch {
        // Keep the row so a later cleanup run can retry the object deletion.
      }
    }
    await this.repository.deleteRows(deletedIds);
    return { deleted: deletedIds.length };
  }
}
