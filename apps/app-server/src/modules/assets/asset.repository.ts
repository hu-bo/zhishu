import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { DomainError } from "../../shared/domain-error.js";
import {
  assetReferences,
  assets,
  apiIdempotencyRecords,
  documentAcl,
  documentGenerations,
  documents,
} from "../../../database/schema/index.js";
import { hasDocumentAction } from "../documents/document.repository.js";
import type { Principal } from "../identity/identity.types.js";
import type { CreateAssetReferenceInput, CreateAssetUploadInput } from "./asset.schema.js";

export type AssetRecord = typeof assets.$inferSelect;
type DatabaseReader = Pick<Database, "select">;

export class AssetRepository {
  constructor(private readonly db: Database) {}

  async createUpload(input: {
    principal: Principal;
    documentId: string;
    objectKey: string;
    file: CreateAssetUploadInput;
    maxBytes: number;
    maxTenantBytes: number;
    expiresAt: Date;
    idempotency?: { key: string; requestHash: string };
  }): Promise<AssetRecord | null> {
    if (input.file.size > input.maxBytes) return null;
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.tenantId, input.principal.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return null;
      if (
        document.createdBy !== input.principal.identityId &&
        !(await this.hasAction(
          tx,
          input.principal.tenantId,
          input.documentId,
          input.principal.identityId,
          "write",
        ))
      ) {
        return null;
      }
      const keyHash = input.idempotency
        ? createHash("sha256").update(input.idempotency.key).digest("hex")
        : null;
      if (input.idempotency && keyHash) {
        const lockKey = [
          input.principal.tenantId,
          input.principal.identityId,
          "assets.upload.create",
          keyHash,
        ].join(":");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 718269))`);
        const [record] = await tx
          .select()
          .from(apiIdempotencyRecords)
          .where(
            and(
              eq(apiIdempotencyRecords.tenantId, input.principal.tenantId),
              eq(apiIdempotencyRecords.subjectId, input.principal.identityId),
              eq(apiIdempotencyRecords.operationId, "assets.upload.create"),
              eq(apiIdempotencyRecords.keyHash, keyHash),
            ),
          )
          .for("update")
          .limit(1);
        if (record && record.expiresAt.getTime() <= Date.now()) {
          await tx
            .delete(apiIdempotencyRecords)
            .where(
              and(
                eq(apiIdempotencyRecords.tenantId, input.principal.tenantId),
                eq(apiIdempotencyRecords.subjectId, input.principal.identityId),
                eq(apiIdempotencyRecords.operationId, "assets.upload.create"),
                eq(apiIdempotencyRecords.keyHash, keyHash),
              ),
            );
        } else if (record) {
          if (record.requestHash !== input.idempotency.requestHash) {
            throw new DomainError(
              "IDEMPOTENCY_KEY_REUSED",
              "Idempotency-Key was reused with a different request",
            );
          }
          const assetId = record.responseBody.assetId;
          if (typeof assetId !== "string") {
            throw new Error("Stored asset upload idempotency response is invalid");
          }
          const [existingAsset] = await tx
            .select()
            .from(assets)
            .where(
              and(
                eq(assets.id, assetId),
                eq(assets.tenantId, input.principal.tenantId),
                eq(assets.documentId, input.documentId),
                eq(assets.createdBy, input.principal.identityId),
              ),
            )
            .limit(1);
          if (existingAsset) return existingAsset;
          throw new Error("Idempotent asset upload session no longer exists");
        }
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-assets:${input.principal.tenantId}`}, 718268))`,
      );
      const [tenantAssetUsage] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${assets.declaredSize}), 0)::text` })
        .from(assets)
        .where(
          and(
            eq(assets.tenantId, input.principal.tenantId),
            inArray(assets.status, ["uploading", "receiving", "uploaded", "ready", "failed"]),
          ),
        );
      const usedBytes = Number(tenantAssetUsage?.bytes ?? 0);
      if (usedBytes + input.file.size > input.maxTenantBytes) {
        throw new DomainError("RESOURCE_LIMIT", "The tenant asset storage limit has been reached", {
          limitBytes: input.maxTenantBytes,
          usedBytes,
          requestedBytes: input.file.size,
        });
      }
      const [asset] = await tx
        .insert(assets)
        .values({
          id: `asset_${randomUUID()}`,
          tenantId: input.principal.tenantId,
          documentId: input.documentId,
          objectKey: input.objectKey,
          fileName: input.file.fileName,
          mediaType: input.file.mediaType,
          declaredSize: input.file.size,
          createdBy: input.principal.identityId,
          uploadExpiresAt: input.expiresAt,
        })
        .returning();
      if (asset && input.idempotency && keyHash) {
        await tx.insert(apiIdempotencyRecords).values({
          tenantId: input.principal.tenantId,
          subjectId: input.principal.identityId,
          operationId: "assets.upload.create",
          keyHash,
          requestHash: input.idempotency.requestHash,
          responseStatus: 201,
          responseBody: { assetId: asset.id },
        });
      }
      return asset ?? null;
    });
  }

  async beginUpload(principal: Principal, assetId: string): Promise<AssetRecord | null> {
    return this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.tenantId, principal.tenantId)))
        .for("update")
        .limit(1);
      if (!asset || !["uploading", "failed"].includes(asset.status)) return null;
      if (!(await this.documentActionAllowed(tx, asset, principal, "write"))) return null;
      const [receiving] = await tx
        .update(assets)
        .set({
          status: "receiving",
          actualSize: null,
          sha256: null,
          uploadedAt: null,
          completedAt: null,
        })
        .where(and(eq(assets.id, asset.id), inArray(assets.status, ["uploading", "failed"])))
        .returning();
      return receiving ?? null;
    });
  }

  async markUploaded(input: {
    tenantId: string;
    assetId: string;
    actualSize: number;
    sha256: string;
  }): Promise<boolean> {
    const [asset] = await this.db
      .update(assets)
      .set({
        status: "uploaded",
        actualSize: input.actualSize,
        sha256: input.sha256,
        uploadedAt: new Date(),
      })
      .where(
        and(
          eq(assets.id, input.assetId),
          eq(assets.tenantId, input.tenantId),
          eq(assets.status, "receiving"),
        ),
      )
      .returning({ id: assets.id });
    return Boolean(asset);
  }

  async markFailed(tenantId: string, assetId: string): Promise<void> {
    await this.db
      .update(assets)
      .set({ status: "failed" })
      .where(
        and(eq(assets.id, assetId), eq(assets.tenantId, tenantId), eq(assets.status, "receiving")),
      );
  }

  async getForAction(
    principal: Principal,
    assetId: string,
    action: "read" | "write",
  ): Promise<AssetRecord | null> {
    const [asset] = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.tenantId, principal.tenantId)))
      .limit(1);
    if (!asset || !(await this.documentActionAllowed(this.db, asset, principal, action)))
      return null;
    return asset;
  }

  async completeUpload(principal: Principal, assetId: string): Promise<AssetRecord | null> {
    return this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.tenantId, principal.tenantId)))
        .for("update")
        .limit(1);
      if (!asset || !(await this.documentActionAllowed(tx, asset, principal, "write"))) return null;
      if (asset.status === "ready") return asset;
      if (asset.status !== "uploaded" || asset.actualSize === null || !asset.sha256) return null;
      const [ready] = await tx
        .update(assets)
        .set({ status: "ready", completedAt: new Date() })
        .where(and(eq(assets.id, asset.id), eq(assets.status, "uploaded")))
        .returning();
      return ready ?? null;
    });
  }

  async cancelUpload(principal: Principal, assetId: string): Promise<AssetRecord | null> {
    return this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select()
        .from(assets)
        .where(and(eq(assets.id, assetId), eq(assets.tenantId, principal.tenantId)))
        .for("update")
        .limit(1);
      if (!asset || !(await this.documentActionAllowed(tx, asset, principal, "write"))) return null;
      if (asset.status === "cancelled") return asset;
      if (!new Set(["uploading", "uploaded", "failed"]).has(asset.status)) return null;
      const [cancelled] = await tx
        .update(assets)
        .set({ status: "cancelled" })
        .where(
          and(eq(assets.id, asset.id), inArray(assets.status, ["uploading", "uploaded", "failed"])),
        )
        .returning();
      return cancelled ?? null;
    });
  }

  async addReference(input: {
    principal: Principal;
    documentId: string;
    assetId: string;
    reference: CreateAssetReferenceInput;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.tenantId, input.principal.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return false;
      if (
        document.createdBy !== input.principal.identityId &&
        !(await this.hasAction(
          tx,
          input.principal.tenantId,
          input.documentId,
          input.principal.identityId,
          "write",
        ))
      ) {
        return false;
      }
      const [generation] = await tx
        .select({ id: documentGenerations.id, durableSeq: documentGenerations.durableSeq })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.id, input.reference.generationId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !generation ||
        generation.durableSeq !== input.reference.durableSeq ||
        generation.durableSeq === 0
      ) {
        return false;
      }
      const [asset] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.tenantId, input.principal.tenantId),
            eq(assets.documentId, input.documentId),
            eq(assets.id, input.assetId),
            eq(assets.status, "ready"),
          ),
        )
        .limit(1);
      if (!asset) return false;
      await tx
        .insert(assetReferences)
        .values({
          tenantId: input.principal.tenantId,
          documentId: input.documentId,
          generationId: generation.id,
          durableSeq: input.reference.durableSeq,
          assetId: asset.id,
          blockId: input.reference.blockId,
        })
        .onConflictDoNothing();
      return true;
    });
  }

  async listOrphaned(input: { before: Date; expiredBefore: Date; limit: number }) {
    return this.db
      .select({ id: assets.id, objectKey: assets.objectKey })
      .from(assets)
      .leftJoin(
        assetReferences,
        and(
          eq(assetReferences.tenantId, assets.tenantId),
          eq(assetReferences.documentId, assets.documentId),
          eq(assetReferences.assetId, assets.id),
        ),
      )
      .leftJoin(
        documents,
        and(eq(documents.tenantId, assets.tenantId), eq(documents.id, assets.documentId)),
      )
      .where(
        or(
          and(
            inArray(assets.status, ["uploading", "receiving", "uploaded", "failed", "cancelled"]),
            lt(assets.uploadExpiresAt, input.expiredBefore),
          ),
          and(
            eq(assets.status, "ready"),
            lt(assets.createdAt, input.before),
            isNull(assetReferences.assetId),
          ),
          isNull(documents.id),
        ),
      )
      .limit(input.limit);
  }

  async deleteRows(assetIds: readonly string[]): Promise<void> {
    if (assetIds.length === 0) return;
    await this.db.delete(assets).where(inArray(assets.id, [...assetIds]));
  }

  private async documentActionAllowed(
    db: DatabaseReader,
    asset: Pick<AssetRecord, "tenantId" | "documentId">,
    principal: Principal,
    action: "read" | "write",
  ): Promise<boolean> {
    const [document] = await db
      .select({ createdBy: documents.createdBy })
      .from(documents)
      .where(
        and(
          eq(documents.id, asset.documentId),
          eq(documents.tenantId, asset.tenantId),
          eq(documents.status, "active"),
        ),
      )
      .limit(1);
    if (!document) return false;
    if (document.createdBy === principal.identityId) return true;
    return this.hasAction(db, asset.tenantId, asset.documentId, principal.identityId, action);
  }

  private async hasAction(
    db: DatabaseReader,
    tenantId: string,
    documentId: string,
    identityId: string,
    action: "read" | "write",
  ): Promise<boolean> {
    const grants = await db
      .select({ action: documentAcl.action })
      .from(documentAcl)
      .where(
        and(
          eq(documentAcl.tenantId, tenantId),
          eq(documentAcl.documentId, documentId),
          eq(documentAcl.identityId, identityId),
        ),
      );
    return hasDocumentAction(new Set(grants.map((grant) => grant.action)), action);
  }
}
