import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { insertNotifications } from "../notifications/index.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  assets,
  resourceAcl,
  documentAuditEvents,
  documentGenerations,
  documentShares,
  documents,
} from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { DocumentRepository } from "./document.repository.js";
import type { CreateShareInput } from "./share.schema.js";
import { documentActionSql, hasDocumentPermission } from "../authorization/permissions.js";
import type { PermissionAction } from "../authorization/policy.js";

const SHARE_INVALID_MESSAGE = "分享链接已失效或已被撤销";

export type SharePermission = "read" | "edit";

type ShareRow = {
  tenantId: string;
  id: string;
  documentId: string;
  permission: string;
  kind: "invite" | "access";
  expiresAt: Date;
  revokedAt: Date | null;
  createdBy: string;
  joinCount: number;
  createdAt: Date;
};

export type PublicShareState = "active" | "expired" | "revoked" | "unknown";

// Left-joined shape: every document/generation column is nullable until narrowed.
type ShareWithDocumentRow = {
  shareId: string;
  tenantId: string;
  documentId: string;
  permission: string;
  expiresAt: Date;
  revokedAt: Date | null;
  documentStatus: string | null;
  title: string | null;
  icon: string | null;
  updatedAt: Date | null;
  schemaVersion: number | null;
  extensions: Array<{ name: string; version: string; required: boolean }> | null;
  generationId: string | null;
  grantorCanDelegate: boolean;
};

export type PublicShareDetail = {
  shareId: string;
  state: PublicShareState;
  permission: SharePermission | null;
  kind: "invite" | "access" | null;
  expiresAt: string | null;
  document: {
    id: string;
    title: string;
    icon: string | null;
    updatedAt: string;
    schemaVersion: number;
    extensions: Array<{ name: string; version: string; required: boolean }>;
    generationId: string;
  } | null;
};

export type PublicShareDocument = {
  tenantId: string;
  documentId: string;
  title: string;
  icon: string | null;
  schemaVersion: number;
  extensions: Array<{ name: string; version: string; required: boolean }>;
  generationId: string;
  updatedAt: string;
};

function presentShare(row: ShareRow) {
  return {
    id: row.id,
    documentId: row.documentId,
    permission: row.permission === "edit" ? ("edit" as const) : ("read" as const),
    kind: row.kind,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdBy: row.createdBy,
    joinCount: row.joinCount,
    createdAt: row.createdAt.toISOString(),
  };
}

function shareState(row: { expiresAt: Date; revokedAt: Date | null }, now: Date): PublicShareState {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

function shareActions(permission: string): readonly PermissionAction[] {
  return permission === "edit" ? ["read", "comment", "write"] : ["read"];
}

function grantorCanDelegateSql() {
  const principal = {
    tenantId: sql`document_shares.tenant_id`,
    identityId: sql`document_shares.created_by`,
  };
  return sql<boolean>`(${documentActionSql(principal, "read", undefined, false)} and ${documentActionSql(principal, "share", undefined, false)}
    and (document_shares.permission = 'read' or (${documentActionSql(principal, "write", undefined, false)} and ${documentActionSql(principal, "comment", undefined, false)})))`;
}

export class ShareRepository {
  constructor(
    private readonly db: Database,
    private readonly documents: DocumentRepository,
  ) {}

  async create(principal: Principal, documentId: string, input: CreateShareInput) {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const [document] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.id, documentId),
            eq(documents.status, "active"),
            documentActionSql(principal, "share"),
            ...shareActions(input.permission).map((action) =>
              documentActionSql(principal, action, undefined, false),
            ),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) throw new DomainError("NOT_FOUND", "文档不存在或超出可分享的权限范围");
      const id = `shr_${randomUUID()}`;
      const expiresAt = new Date(input.expiresAt);
      if (expiresAt.getTime() <= Date.now())
        throw new DomainError("VALIDATION_ERROR", "分享有效期已过，请重新选择");
      const [row] = await tx
        .insert(documentShares)
        .values({
          tenantId: principal.tenantId,
          id,
          documentId,
          permission: input.permission,
          kind: input.kind ?? "invite",
          expiresAt,
          createdBy: principal.identityId,
        })
        .returning();
      if (!row) throw new Error("Share insert returned no row");
      await tx.insert(documentAuditEvents).values({
        tenantId: principal.tenantId,
        actorIdentityId: principal.identityId,
        action: "document.share-created",
        resourceId: documentId,
        details: { shareId: id, permission: input.permission, expiresAt: input.expiresAt },
      });
      return presentShare(row);
    });
  }

  async list(principal: Principal, documentId: string) {
    const document = await this.documents.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "share",
    );
    if (!document) throw new DomainError("NOT_FOUND", "Document not found");
    const rows = await this.db
      .select()
      .from(documentShares)
      .where(
        and(
          eq(documentShares.tenantId, principal.tenantId),
          eq(documentShares.documentId, documentId),
        ),
      )
      .orderBy(desc(documentShares.createdAt), desc(documentShares.id))
      .limit(50);
    return rows.map(presentShare);
  }

  async revoke(principal: Principal, documentId: string, shareId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const [share] = await tx
        .select()
        .from(documentShares)
        .where(
          and(
            eq(documentShares.tenantId, principal.tenantId),
            eq(documentShares.documentId, documentId),
            eq(documentShares.id, shareId),
          ),
        )
        .for("update")
        .limit(1);
      if (!share) throw new DomainError("NOT_FOUND", "Share link not found");
      if (share.createdBy !== principal.identityId) {
        if (!(await hasDocumentPermission(tx, principal, documentId, "share")))
          throw new DomainError("NOT_FOUND", "Document not found");
      }
      if (share.revokedAt) return; // Idempotent: repeated revocations stay 204.
      await tx
        .update(documentShares)
        .set({ revokedAt: new Date() })
        .where(and(eq(documentShares.tenantId, share.tenantId), eq(documentShares.id, shareId)));
      await tx.insert(documentAuditEvents).values({
        tenantId: principal.tenantId,
        actorIdentityId: principal.identityId,
        action: "document.share-revoked",
        resourceId: documentId,
        details: { shareId },
      });
    });
  }

  /**
   * Capability lookup by share id alone (no tenant known for anonymous callers).
   * The 128-bit UUID id is the capability; a miss never reveals which part failed.
   */
  private async findShareWithDocument(shareId: string) {
    const [row] = await this.db
      .select({
        shareId: documentShares.id,
        tenantId: documentShares.tenantId,
        documentId: documentShares.documentId,
        permission: documentShares.permission,
        kind: documentShares.kind,
        expiresAt: documentShares.expiresAt,
        revokedAt: documentShares.revokedAt,
        documentStatus: documents.status,
        title: documents.title,
        icon: documents.icon,
        updatedAt: documents.updatedAt,
        schemaVersion: documentGenerations.schemaVersion,
        extensions: documentGenerations.extensions,
        generationId: documentGenerations.id,
        grantorCanDelegate: grantorCanDelegateSql(),
      })
      .from(documentShares)
      .leftJoin(
        documents,
        and(
          eq(documents.tenantId, documentShares.tenantId),
          eq(documents.id, documentShares.documentId),
        ),
      )
      .leftJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documentShares.documentId),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(eq(documentShares.id, shareId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Narrow the left-joined row into a usable document payload. A missing share, a
   * recycled document, or a retired generation all yield null (rendered as "unknown").
   */
  private activeDocumentFrom(row: ShareWithDocumentRow): PublicShareDocument | null {
    if (
      row.documentStatus !== "active" ||
      row.generationId === null ||
      row.title === null ||
      row.updatedAt === null ||
      row.schemaVersion === null ||
      row.extensions === null
    )
      return null;
    return {
      tenantId: row.tenantId,
      documentId: row.documentId,
      title: row.title,
      icon: row.icon,
      schemaVersion: row.schemaVersion,
      extensions: row.extensions,
      generationId: row.generationId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async loadForPublic(shareId: string): Promise<PublicShareDetail> {
    const row = await this.findShareWithDocument(shareId);
    const unknown: PublicShareDetail = {
      shareId,
      state: "unknown",
      permission: null,
      kind: null,
      expiresAt: null,
      document: null,
    };
    if (!row) return unknown;
    const document = this.activeDocumentFrom(row);
    if (!document || !row.grantorCanDelegate) return unknown;
    const state = shareState(row, new Date());
    if (state !== "active")
      return {
        shareId,
        state,
        permission: null,
        kind: null,
        expiresAt: row.expiresAt.toISOString(),
        document: null,
      };
    return {
      shareId,
      state: "active",
      permission: row.permission === "edit" ? "edit" : "read",
      kind: row.kind,
      expiresAt: row.expiresAt.toISOString(),
      document: {
        id: document.documentId,
        title: document.title,
        icon: document.icon,
        updatedAt: document.updatedAt,
        schemaVersion: document.schemaVersion,
        extensions: document.extensions,
        generationId: document.generationId,
      },
    };
  }

  private async requireActivePublicDocument(
    shareId: string,
  ): Promise<PublicShareDocument & { expiresAt: Date }> {
    const row = await this.findShareWithDocument(shareId);
    const document = row ? this.activeDocumentFrom(row) : null;
    if (!row || !document || !row.grantorCanDelegate || shareState(row, new Date()) !== "active")
      throw new DomainError("NOT_FOUND", "分享链接已失效");
    return { ...document, expiresAt: row.expiresAt };
  }

  async contentForPublic(shareId: string) {
    const document = await this.requireActivePublicDocument(shareId);
    // Anonymous visitors are always read-only; the edit tier only applies after join.
    const snapshot = await this.documents.findProjectionContentSnapshot(
      document.tenantId,
      document.documentId,
      document.generationId,
    );
    if (!snapshot)
      throw new DomainError("CONFLICT", "The document content snapshot is unavailable");
    return {
      documentId: document.documentId,
      readOnly: true,
      schemaVersion: document.schemaVersion,
      extensions: document.extensions,
      generationId: document.generationId,
      durableSeq: snapshot.durableSeq,
      snapshotRevision: snapshot.snapshotRevision,
      content: snapshot.content,
    };
  }

  async assetForPublic(shareId: string, assetId: string) {
    const document = await this.requireActivePublicDocument(shareId);
    const [asset] = await this.db
      .select({
        objectKey: assets.objectKey,
        fileName: assets.fileName,
        mediaType: assets.mediaType,
      })
      .from(assets)
      .where(
        and(
          eq(assets.tenantId, document.tenantId),
          eq(assets.id, assetId),
          eq(assets.documentId, document.documentId),
          eq(assets.status, "ready"),
        ),
      )
      .limit(1);
    if (!asset) throw new DomainError("NOT_FOUND", "Asset not found");
    return { ...asset, shareExpiresAt: document.expiresAt };
  }

  async join(
    principal: Principal,
    shareId: string,
  ): Promise<{ joined: boolean; documentId: string }> {
    return this.db.transaction(async (tx) => {
      // Same tenant lock as membership, policy, access-mode and tree mutations.
      // Recheck all authority after locking; a preflight read is never sufficient.
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const [share] = await tx
        .select()
        .from(documentShares)
        .where(and(eq(documentShares.tenantId, principal.tenantId), eq(documentShares.id, shareId)))
        .for("update")
        .limit(1);
      if (!share || share.tenantId !== principal.tenantId)
        throw new DomainError("NOT_FOUND", SHARE_INVALID_MESSAGE);
      if (shareState(share, new Date()) !== "active")
        throw new DomainError("NOT_FOUND", SHARE_INVALID_MESSAGE);
      const [document] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, share.tenantId),
            eq(documents.id, share.documentId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) throw new DomainError("NOT_FOUND", SHARE_INVALID_MESSAGE);

      const actions = shareActions(share.permission);
      const grantor = { tenantId: share.tenantId, identityId: share.createdBy };
      for (const action of ["share" as const, ...actions])
        if (!(await hasDocumentPermission(tx, grantor, share.documentId, action)))
          throw new DomainError("NOT_FOUND", SHARE_INVALID_MESSAGE);
      const [delegation] = await tx
        .select({ allowed: grantorCanDelegateSql() })
        .from(documentShares)
        .innerJoin(
          documents,
          and(
            eq(documents.tenantId, documentShares.tenantId),
            eq(documents.id, documentShares.documentId),
          ),
        )
        .where(
          and(eq(documentShares.tenantId, principal.tenantId), eq(documentShares.id, shareId)),
        );
      if (!delegation?.allowed) throw new DomainError("NOT_FOUND", SHARE_INVALID_MESSAGE);
      const alreadyAllowed: boolean[] = [];
      for (const action of actions)
        alreadyAllowed.push(await hasDocumentPermission(tx, principal, share.documentId, action));
      if (shareState(share, new Date()) !== "active")
        throw new DomainError("NOT_FOUND", SHARE_INVALID_MESSAGE);
      let inserted = false;
      for (const action of actions) {
        const grants = await tx
          .insert(resourceAcl)
          .values({
            tenantId: principal.tenantId,
            documentId: share.documentId,
            identityId: principal.identityId,
            role: action,
            sourceShareId: shareId,
            createdBy: share.createdBy,
          })
          .onConflictDoNothing()
          .returning({ id: resourceAcl.id });
        inserted ||= grants.length > 0;
      }
      if (!inserted) return { joined: false, documentId: share.documentId };
      await tx
        .update(documentShares)
        .set({ joinCount: sql`${documentShares.joinCount} + 1` })
        .where(and(eq(documentShares.tenantId, share.tenantId), eq(documentShares.id, shareId)));
      await insertNotifications(tx, [
        {
          tenantId: principal.tenantId,
          actorId: share.createdBy,
          recipientId: principal.identityId,
          type: "share",
          eventKey: `share:${shareId}:${principal.identityId}`,
          documentId: share.documentId,
          message: "你通过分享链接获得了文档访问权限",
        },
      ]);
      await tx.insert(documentAuditEvents).values({
        tenantId: principal.tenantId,
        actorIdentityId: principal.identityId,
        action: "document.acl-updated",
        resourceId: share.documentId,
        details: { operation: "share-join", shareId, actions },
      });
      return { joined: !alreadyAllowed.every(Boolean), documentId: share.documentId };
    });
  }
}
