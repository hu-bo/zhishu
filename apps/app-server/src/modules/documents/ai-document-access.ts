import { documentActionSql, hasDocumentPermission } from "../authorization/permissions.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents, documentGenerations, workspaces } from "../../../database/schema/index.js";
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
    if (await this.canWrite(principal, id)) writable = true;
    return {
      ...(await this.owner.snapshot(principal, id)),
      aiWritable: writable,
      workspaceId: row.workspaceId,
    };
  }

  /** Writing requires read+ai+write; personal-workspace limits are lifted with team review. */
  async canWrite(principal: Principal, id: string): Promise<boolean> {
    try {
      await this.authorized(this.db, principal, id, ["write", "ai"]);
      return true;
    } catch {
      return false;
    }
  }
}
