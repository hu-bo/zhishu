import { documentActionSql, hasDocumentPermission } from "../authorization/permissions.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents, documentGenerations, workspaces } from "../../../database/schema/index.js";
import type { AiRunInput } from "../../../database/schema/ai.table.js";
import { prepareDocumentChunks } from "@zhishu/rag";
import type { EvidenceBundle } from "@zhishu/ai-contracts";
import type { CollaborationOwner } from "../collaboration/owner.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { PermissionAction } from "../authorization/policy.js";

type Executor = Pick<Database, "select">;
export class AiDocumentAccess {
  constructor(
    private readonly db: Database,
    private readonly owner: CollaborationOwner,
  ) {}
  /** Source discovery and late reads share the document access policy. */
  async readableHeads(principal: Principal, workspaceId?: string, ids?: readonly string[]) {
    if (ids?.length === 0) return [];
    return this.db
      .select({
        documentId: documents.id,
        workspaceId: documents.workspaceId,
        title: documents.title,
        metadataRevision: documents.metadataRevision,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
      })
      .from(documents)
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.status, "active"),
          workspaceId ? eq(documents.workspaceId, workspaceId) : undefined,
          ids ? inArray(documents.id, [...ids]) : undefined,
          documentActionSql(principal, "ai"),
        ),
      )
      .limit(10001);
  }
  private async authorized(
    db: Executor,
    principal: Principal,
    id: string,
    actions: PermissionAction[],
    lock = false,
  ) {
    let query = db
      .select({
        id: documents.id,
        createdBy: documents.createdBy,
        workspaceId: documents.workspaceId,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
        metadataRevision: documents.metadataRevision,
        kind: workspaces.kind,
        personalOwnerId: workspaces.personalOwnerId,
      })
      .from(documents)
      .innerJoin(
        workspaces,
        and(eq(workspaces.tenantId, documents.tenantId), eq(workspaces.id, documents.workspaceId)),
      )
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.id, id),
          eq(documents.status, "active"),
        ),
      )
      .limit(1)
      .$dynamic();
    if (lock) query = query.for("share", { of: documents });
    const [row] = await query;
    if (!row) throw new DomainError("AI_ACCESS_REVOKED", "文档或资料已不可访问");
    for (const action of actions) {
      if (!(await hasDocumentPermission(db, principal, id, action)))
        throw new DomainError("AI_ACCESS_REVOKED", "文档或资料授权已变化");
    }
    return row;
  }
  async context(principal: Principal, id: string) {
    const row = await this.authorized(this.db, principal, id, ["read", "ai"]);
    let writable = false;
    if (row.kind === "personal" && row.personalOwnerId === principal.identityId) {
      try {
        await this.authorized(this.db, principal, id, ["write", "ai"]);
        writable = true;
      } catch {
        /* Readable sources remain available. */
      }
    }
    return {
      ...(await this.owner.snapshot(principal, id)),
      aiWritable: writable,
      reason: writable
        ? null
        : row.kind === "personal"
          ? "仅空间所有者可将此文档用于 AI 写入"
          : "AI 正文写入仅支持本人的个人空间",
    };
  }
  async target(principal: Principal, id: string, db: Executor = this.db) {
    const row = await this.authorized(db, principal, id, ["write", "ai"]);
    if (row.kind !== "personal" || row.personalOwnerId !== principal.identityId)
      throw new DomainError("AI_WRITE_PERSONAL_ONLY", "AI 正文写入仅支持本人的个人空间");
    return row;
  }
  async sources(principal: Principal, ids: string[], targetWorkspaceId?: string) {
    const versions: AiRunInput["sourceVersions"] = [],
      items: EvidenceBundle["items"] = [];
    for (const id of ids) {
      const row = await this.authorized(this.db, principal, id, ["read", "ai"]);
      if (targetWorkspaceId && row.workspaceId !== targetWorkspaceId)
        await this.authorized(this.db, principal, id, ["export"]);
      const { snapshot, title } = await this.owner.snapshot(principal, id);
      versions.push({
        documentId: id,
        generationId: snapshot.generationId,
        durableSeq: snapshot.durableSeq,
      });
      const chunks = await prepareDocumentChunks(snapshot, {
        collectionName: "selected-documents",
        embeddingFingerprint: "none",
        dimensions: 1,
        metric: "cosine",
        normalizerVersion: "rag-v2",
        chunkerVersion: "selected-v1",
        targetTokens: 800,
        maxTokens: 1200,
        overlapTokens: 80,
      });
      const selected = chunks.slice(0, 8).map((item) => ({
        ...item,
        title: `${title}${item.title ? ` / ${item.title}` : ""}`.slice(0, 512),
      }));
      items.push(...selected);
    }
    if (Buffer.byteLength(JSON.stringify(items)) > 32000)
      throw new DomainError("VALIDATION_ERROR", "所选资料过多，请缩小资料范围");
    return { sourceVersions: versions, evidence: { freshness: "current" as const, items } };
  }
  async verify(
    principal: Principal,
    input: AiRunInput,
    db: Executor = this.db,
    forWrite = false,
    checkVersions = true,
  ) {
    const targetId = input.request.kind === "authoring" ? input.request.document.documentId : null;
    const target = targetId
      ? forWrite
        ? await this.target(principal, targetId, db)
        : await this.authorized(db, principal, targetId, ["read", "ai"])
      : null;
    for (const version of [...input.sourceVersions].sort((a, b) =>
      a.documentId.localeCompare(b.documentId),
    )) {
      const row = await this.authorized(
        db,
        principal,
        version.documentId,
        ["read", "ai"],
        forWrite,
      );
      if (
        checkVersions &&
        (row.generationId !== version.generationId ||
          row.durableSeq !== version.durableSeq ||
          (version.metadataRevision !== undefined &&
            row.metadataRevision !== version.metadataRevision))
      )
        throw new DomainError("AI_ACCESS_REVOKED", "资料已更新，请基于最新资料重新生成");
      if (forWrite && target && row.workspaceId !== target.workspaceId)
        await this.authorized(db, principal, row.id, ["export"]);
    }
  }
  async verifySourceVersions(principal: Principal, versions: AiRunInput["sourceVersions"]) {
    for (const version of versions) {
      const row = await this.authorized(this.db, principal, version.documentId, ["read", "ai"]);
      if (
        row.generationId !== version.generationId ||
        row.durableSeq !== version.durableSeq ||
        (version.metadataRevision !== undefined &&
          row.metadataRevision !== version.metadataRevision)
      )
        throw new DomainError("AI_ACCESS_REVOKED", "资料已更新，请重新选择资料");
    }
  }
}
