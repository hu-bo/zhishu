import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "../identity/identity.types.js";
import { AssetRepository } from "./asset.repository.js";
import type { AssetRecord } from "./asset.repository.js";
import type { CreateAssetReferenceInput, CreateAssetUploadInput } from "./asset.schema.js";
import { supportedAssetMediaTypes } from "./asset.schema.js";
import { AssetObjectStorage } from "./asset-storage.js";

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

function decodeBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new DomainError("VALIDATION_ERROR", "Upload body is not valid base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new DomainError("VALIDATION_ERROR", "Upload body is not canonical base64");
  }
  return bytes;
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
    this.requireStorage();
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
      uploadPath: `/api/asset-uploads/${asset.id}/content`,
      completePath: `/api/asset-uploads/${asset.id}/complete`,
    };
  }

  async uploadContent(principal: Principal, assetId: string, dataBase64: string): Promise<void> {
    const storage = this.requireStorage();
    const current = await this.repository.getForAction(principal, assetId, "write");
    if (!current) throw new DomainError("NOT_FOUND", "Asset upload not found");
    const bytes = decodeBase64(dataBase64);
    if (bytes.byteLength !== current.declaredSize || bytes.byteLength > this.options.maxBytes) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Uploaded file size does not match the upload session",
      );
    }
    const mediaType = current.mediaType as (typeof supportedAssetMediaTypes)[number];
    if (!imageMagicChecks[mediaType]?.(bytes)) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Uploaded file content does not match its media type",
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (current.status === "uploaded" || current.status === "ready") {
      if (current.actualSize === bytes.byteLength && current.sha256 === sha256) return;
      throw new DomainError("CONFLICT", "Asset upload already contains different content");
    }
    if (current.status !== "uploading" && current.status !== "failed") {
      throw new DomainError("CONFLICT", "Asset upload is not open");
    }
    if (current.uploadExpiresAt.getTime() <= Date.now()) {
      throw new DomainError("CONFLICT", "Asset upload session has expired");
    }
    const receiving = await this.repository.beginUpload(principal, assetId);
    if (!receiving)
      throw new DomainError("CONFLICT", "Asset upload is already in progress or closed");
    try {
      await storage.put({
        objectKey: receiving.objectKey,
        bytes,
        mediaType,
        sha256,
      });
    } catch (error) {
      await this.repository.markFailed(principal.tenantId, assetId);
      throw new DomainError("SERVICE_UNAVAILABLE", "Asset storage is unavailable", undefined, {
        cause: error,
      });
    }
    if (
      !(await this.repository.markUploaded({
        tenantId: principal.tenantId,
        assetId,
        actualSize: bytes.byteLength,
        sha256,
      }))
    ) {
      throw new DomainError("CONFLICT", "Asset upload changed before its object was recorded");
    }
  }

  async completeUpload(principal: Principal, assetId: string) {
    const storage = this.requireStorage();
    const current = await this.repository.getForAction(principal, assetId, "write");
    if (!current) throw new DomainError("NOT_FOUND", "Asset upload not found");
    if (current.status === "ready") return presentAsset(current);
    if (current.status !== "uploaded" || current.actualSize === null || current.sha256 === null) {
      throw new DomainError("CONFLICT", "Asset content has not been uploaded");
    }
    let object: Awaited<ReturnType<AssetObjectStorage["head"]>>;
    try {
      object = await storage.head(current.objectKey);
    } catch (error) {
      throw new DomainError("SERVICE_UNAVAILABLE", "Asset storage is unavailable", undefined, {
        cause: error,
      });
    }
    if (
      object.ContentLength !== current.actualSize ||
      object.ContentType !== current.mediaType ||
      object.Metadata?.sha256 !== current.sha256
    ) {
      throw new DomainError(
        "VALIDATION_ERROR",
        "Stored object metadata does not match the upload session",
      );
    }
    const asset = await this.repository.completeUpload(principal, assetId);
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
    const url = await storage.createReadUrl({
      objectKey: asset.objectKey,
      fileName: asset.fileName,
      mediaType: asset.mediaType,
      expiresIn: this.options.accessUrlTtlSeconds,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + this.options.accessUrlTtlSeconds * 1_000).toISOString(),
    };
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
