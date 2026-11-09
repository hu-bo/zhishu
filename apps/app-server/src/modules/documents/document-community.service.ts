import { lockKnowledgeTree, readKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  documentAuditEvents,
  documentComments,
  documentGenerations,
  documents,
  identityProfiles,
  workspaces,
} from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import { documentRecipients, insertNotifications } from "../notifications/index.js";
import {
  hasDocumentPermission,
  requireDocumentManager,
  type DocumentAccessMode,
} from "../authorization/permissions.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";

export class DocumentCommunityService {
  constructor(
    private readonly db: Database,
    private readonly revoker: CollaborationSessionRevoker,
  ) {}
  private async requireDocument(
    db: Pick<Database, "select">,
    principal: Principal,
    documentId: string,
    action: "read" | "comment" | "manage",
    lock = false,
  ) {
    let query = db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.id, documentId),
          eq(documents.status, "active"),
        ),
      )
      .limit(1)
      .$dynamic();
    if (lock) query = query.for("update");
    const [document] = await query;
    if (!document || !(await hasDocumentPermission(db, principal, documentId, action)))
      throw new DomainError("NOT_FOUND", "文档不存在或无权访问");
    return document;
  }
  async setAccess(
    principal: Principal,
    documentId: string,
    input: { accessMode: DocumentAccessMode; metadataRevision: number },
  ) {
    const result = await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const document = await this.requireDocument(tx, principal, documentId, "manage", true);
      if (document.metadataRevision !== input.metadataRevision)
        throw new DomainError("CONFLICT", "文档权限已变化，请刷新后重试");
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(
          and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, document.workspaceId)),
        )
        .limit(1);
      if (
        (input.accessMode === "workspace-inherited" && workspace?.kind !== "team") ||
        (input.accessMode === "personal" &&
          (workspace?.kind !== "personal" || workspace.personalOwnerId !== document.createdBy))
      )
        throw new DomainError("VALIDATION_ERROR", "访问模式与空间类型不匹配");
      if (document.accessMode === input.accessMode)
        return {
          metadataRevision: document.metadataRevision,
          accessMode: document.accessMode,
          generationId: null,
        };
      const before = await documentRecipients(tx, principal.tenantId, documentId);
      await tx
        .update(documents)
        .set({
          accessMode: input.accessMode,
          metadataRevision: document.metadataRevision + 1,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));
      await requireDocumentManager(tx, principal.tenantId, documentId);
      const recipients = new Set([
        ...before,
        ...(await documentRecipients(tx, principal.tenantId, documentId)),
      ]);
      const eventKey = `access:${randomUUID()}`;
      await insertNotifications(
        tx,
        [...recipients].map((recipientId) => ({
          tenantId: principal.tenantId,
          actorId: principal.identityId,
          recipientId,
          type: "permission",
          eventKey,
          workspaceId: document.workspaceId,
          documentId,
          message: "一篇文档的访问范围发生了变化",
        })),
      );
      await tx.insert(documentAuditEvents).values({
        tenantId: principal.tenantId,
        actorIdentityId: principal.identityId,
        action: "document.acl-updated",
        resourceId: documentId,
        details: {
          operation: "access-mode",
          before: document.accessMode,
          accessMode: input.accessMode,
        },
      });
      const [generation] = await tx
        .select({ id: documentGenerations.id })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .limit(1);
      return {
        accessMode: input.accessMode,
        metadataRevision: document.metadataRevision + 1,
        generationId: generation?.id ?? null,
      };
    });
    if (result.generationId) this.revoker.revokeDocumentSessions(documentId, result.generationId);
    return { accessMode: result.accessMode, metadataRevision: result.metadataRevision };
  }
  async listComments(principal: Principal, documentId: string, offset: number) {
    await this.requireDocument(this.db, principal, documentId, "read");
    const rows = await this.db
      .select({
        id: documentComments.id,
        authorId: documentComments.authorId,
        body: documentComments.body,
        mentionIds: documentComments.mentionIds,
        createdAt: documentComments.createdAt,
        authorName: sql<string>`coalesce(${identityProfiles.displayName}, '一位成员')`,
      })
      .from(documentComments)
      .leftJoin(
        identityProfiles,
        and(
          eq(identityProfiles.tenantId, documentComments.tenantId),
          eq(identityProfiles.identityId, documentComments.authorId),
        ),
      )
      .where(
        and(
          eq(documentComments.tenantId, principal.tenantId),
          eq(documentComments.documentId, documentId),
        ),
      )
      .orderBy(asc(documentComments.createdAt), asc(documentComments.id))
      .limit(51)
      .offset(offset);
    return {
      items: rows.slice(0, 50).map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        canDelete: r.authorId === principal.identityId,
      })),
      hasMore: rows.length > 50,
      canComment: await hasDocumentPermission(this.db, principal, documentId, "comment"),
    };
  }
  async createComment(
    principal: Principal,
    documentId: string,
    input: { id: string; body: string; mentionIds: string[] },
  ) {
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, principal.tenantId);
      const document = await this.requireDocument(tx, principal, documentId, "comment", true);
      const [existing] = await tx
        .select()
        .from(documentComments)
        .where(eq(documentComments.id, input.id))
        .limit(1);
      if (existing) {
        if (
          existing.tenantId !== principal.tenantId ||
          existing.documentId !== documentId ||
          existing.authorId !== principal.identityId ||
          existing.body !== input.body ||
          JSON.stringify(existing.mentionIds) !== JSON.stringify(input.mentionIds)
        )
          throw new DomainError("CONFLICT", "评论请求已被使用");
        return { id: existing.id };
      }
      if (input.mentionIds.length) {
        const profiles = await tx
          .select({ identityId: identityProfiles.identityId })
          .from(identityProfiles)
          .where(
            and(
              eq(identityProfiles.tenantId, principal.tenantId),
              inArray(identityProfiles.identityId, input.mentionIds),
            ),
          );
        if (profiles.length !== input.mentionIds.length)
          throw new DomainError("VALIDATION_ERROR", "提及的成员不存在");
        for (const identityId of input.mentionIds)
          if (
            !(await hasDocumentPermission(
              tx,
              { tenantId: principal.tenantId, identityId },
              documentId,
              "read",
            ))
          )
            throw new DomainError("VALIDATION_ERROR", "只能提及有文档访问权限的成员");
      }
      await tx.insert(documentComments).values({
        ...input,
        tenantId: principal.tenantId,
        documentId,
        authorId: principal.identityId,
      });
      const participants = await tx
        .selectDistinct({ authorId: documentComments.authorId })
        .from(documentComments)
        .where(
          and(
            eq(documentComments.tenantId, principal.tenantId),
            eq(documentComments.documentId, documentId),
          ),
        );
      const readable = new Set(await documentRecipients(tx, principal.tenantId, documentId));
      const recipients = new Set([
        document.createdBy,
        ...participants.map((p) => p.authorId),
        ...input.mentionIds,
      ]);
      await insertNotifications(
        tx,
        [...recipients]
          .filter((id) => readable.has(id))
          .map((recipientId) => ({
            tenantId: principal.tenantId,
            actorId: principal.identityId,
            recipientId,
            type: input.mentionIds.includes(recipientId) ? "mention" : "comment",
            eventKey: `comment:${input.id}`,
            documentId,
            workspaceId: document.workspaceId,
            message: input.mentionIds.includes(recipientId)
              ? "有人在文档评论中提及了你"
              : "你关注的文档有一条新评论",
          })),
      );
      return { id: input.id };
    });
  }
  async deleteComment(principal: Principal, documentId: string, id: string) {
    await this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, principal.tenantId);
      await this.requireDocument(tx, principal, documentId, "comment", true);
      const deleted = await tx
        .delete(documentComments)
        .where(
          and(
            eq(documentComments.tenantId, principal.tenantId),
            eq(documentComments.documentId, documentId),
            eq(documentComments.id, id),
            eq(documentComments.authorId, principal.identityId),
          ),
        )
        .returning({ id: documentComments.id });
      if (!deleted.length) throw new DomainError("NOT_FOUND", "评论不存在或无权删除");
    });
  }
}
