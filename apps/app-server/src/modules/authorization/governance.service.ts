import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  authorizationEvents,
  documents,
  documentShares,
  identityProfiles,
  resourceAcl,
  workspaces,
} from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import {
  documentActionSql,
  documentRolesSql,
  documentGrantActiveSql,
  requireDocumentManager,
} from "./document-access.js";
import { permissionActions, effectiveActions } from "./policy.js";
import { loadPolicyOverrides, spaceActionSql } from "./access.js";
import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";

export class GovernanceService {
  constructor(private readonly db: Database) {}
  private async workspace(
    db: Pick<Database, "select">,
    principal: Principal,
    workspaceId: string,
    ownerOnly = false,
  ) {
    const [space] = await db
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.tenantId, principal.tenantId),
          eq(workspaces.id, workspaceId),
          spaceActionSql(principal, "manage"),
        ),
      )
      .limit(1);
    if (!space || (ownerOnly && space.ownerIdentityId !== principal.identityId))
      throw new DomainError("NOT_FOUND", "空间不存在或无治理权限");
    return space;
  }
  async state(principal: Principal) {
    // Only scopes the caller can currently read, including independently shared documents.
    const ownAccessSources = sql`from document_shares s join documents d on d.tenant_id=s.tenant_id and d.id=s.document_id where d.tenant_id=${principal.tenantId} and d.workspace_id=workspaces.id and s.kind='access' and s.revoked_at is null and exists(select 1 from resource_acl a where a.tenant_id=s.tenant_id and a.source_share_id=s.id and a.identity_id=${principal.identityId})`;
    return this.db
      .select({
        workspaceId: workspaces.id,
        revision: workspaces.authorizationRevision,
        offlineCacheAllowed: workspaces.offlineCacheAllowed,
        expiryRevision: sql<string>`(select md5(coalesce(max(s.expires_at)::text,'')) ${ownAccessSources} and s.expires_at<=statement_timestamp())`,
        nextExpiryAt: sql<
          string | null
        >`(select min(s.expires_at)::text ${ownAccessSources} and s.expires_at>statement_timestamp())`.mapWith(
          (value: string | null) => (value === null ? null : new Date(value).toISOString()),
        ),
      })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.tenantId, principal.tenantId),
          sql`(${spaceActionSql(principal, "read")} or exists (select 1 from documents where documents.tenant_id = ${principal.tenantId} and documents.workspace_id = workspaces.id and ${documentActionSql(principal, "read")}))`,
        ),
      )
      .orderBy(asc(workspaces.id));
  }
  async audit(principal: Principal, workspaceId: string, before?: number) {
    await this.workspace(this.db, principal, workspaceId);
    const rows = await this.db
      .select()
      .from(authorizationEvents)
      .where(
        and(
          eq(authorizationEvents.tenantId, principal.tenantId),
          eq(authorizationEvents.workspaceId, workspaceId),
          before ? sql`${authorizationEvents.id} < ${before}` : undefined,
        ),
      )
      .orderBy(desc(authorizationEvents.id))
      .limit(51);
    return {
      items: rows
        .slice(0, 50)
        .map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
      hasMore: rows.length > 50,
    };
  }
  async configure(
    principal: Principal,
    workspaceId: string,
    input: { revision: number; offlineCacheAllowed: boolean },
  ) {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const space = await this.workspace(tx, principal, workspaceId, true);
      if (space.authorizationRevision !== input.revision)
        throw new DomainError("CONFLICT", "权限配置已变化，请刷新后重试");
      await tx
        .update(workspaces)
        .set({ offlineCacheAllowed: input.offlineCacheAllowed })
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)));
      const [updated] = await tx
        .select({ revision: workspaces.authorizationRevision })
        .from(workspaces)
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)));
      return { revision: updated!.revision };
    });
  }
  async transfer(
    principal: Principal,
    workspaceId: string,
    input: { identityId: string; revision: number },
  ) {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const space = await this.workspace(tx, principal, workspaceId, true);
      if (space.kind !== "team")
        throw new DomainError("VALIDATION_ERROR", "仅团队空间支持所有权转移");
      if (space.authorizationRevision !== input.revision)
        throw new DomainError("CONFLICT", "空间权限已变化，请刷新后重试");
      if (input.identityId === principal.identityId) return { ownerIdentityId: input.identityId };
      const [member] = await tx
        .select({ identityId: resourceAcl.identityId })
        .from(resourceAcl)
        .innerJoin(
          identityProfiles,
          and(
            eq(identityProfiles.tenantId, resourceAcl.tenantId),
            eq(identityProfiles.identityId, resourceAcl.identityId),
          ),
        )
        .where(
          and(
            eq(resourceAcl.tenantId, principal.tenantId),
            eq(resourceAcl.workspaceId, workspaceId),
            eq(resourceAcl.identityId, input.identityId),
            eq(identityProfiles.active, true),
          ),
        )
        .limit(1);
      if (!member) throw new DomainError("VALIDATION_ERROR", "请选择空间内的真实成员");
      await tx
        .delete(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, principal.tenantId),
            eq(resourceAcl.workspaceId, workspaceId),
            eq(resourceAcl.identityId, input.identityId),
          ),
        );
      await tx
        .insert(resourceAcl)
        .values({
          tenantId: principal.tenantId,
          workspaceId,
          identityId: principal.identityId,
          role: "admin",
          createdBy: principal.identityId,
        })
        .onConflictDoUpdate({
          target: [resourceAcl.tenantId, resourceAcl.workspaceId, resourceAcl.identityId],
          set: { role: "admin" },
        });
      await tx
        .update(workspaces)
        .set({ ownerIdentityId: input.identityId })
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)));
      return { ownerIdentityId: input.identityId };
    });
  }
  async recover(principal: Principal, documentId: string, reason: string) {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const [document] = await tx
        .select({ workspaceId: documents.workspaceId })
        .from(documents)
        .where(and(eq(documents.tenantId, principal.tenantId), eq(documents.id, documentId)))
        .limit(1);
      if (!document) throw new DomainError("NOT_FOUND", "文档不存在或无治理权限");
      await this.workspace(tx, principal, document.workspaceId, true);
      await tx
        .insert(resourceAcl)
        .values({
          tenantId: principal.tenantId,
          documentId,
          identityId: principal.identityId,
          role: "manage",
          createdBy: principal.identityId,
        })
        .onConflictDoNothing();
      await requireDocumentManager(tx, principal.tenantId, documentId);
      await tx.execute(sql`select pg_advisory_xact_lock(718270,1)`);
      await tx.insert(authorizationEvents).values({
        tenantId: principal.tenantId,
        workspaceId: document.workspaceId,
        documentId,
        actorId: principal.identityId,
        operation: "document.governance-recovery",
        after: { reason },
      });
      return { documentId };
    });
  }
  async explain(principal: Principal, documentId: string) {
    const [document] = await this.db
      .select({
        workspaceId: documents.workspaceId,
        roles: sql<string[]>`array(select role from (${documentRolesSql(principal)}) roles)`,
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.id, documentId),
          documentActionSql(principal, "read"),
        ),
      )
      .limit(1);
    if (!document) throw new DomainError("NOT_FOUND", "文档不存在或无权访问");
    const overrides = await loadPolicyOverrides(this.db, principal.tenantId, document.workspaceId);
    const actions = [
      ...new Set(document.roles.flatMap((role) => effectiveActions("document", role, overrides))),
    ];
    const grants = await this.db
      .select({
        role: resourceAcl.role,
        sourceShareId: resourceAcl.sourceShareId,
        createdBy: resourceAcl.createdBy,
        kind: documentShares.kind,
        active: documentGrantActiveSql(undefined, true, "resource_acl"),
      })
      .from(resourceAcl)
      .innerJoin(
        documents,
        and(eq(documents.tenantId, resourceAcl.tenantId), eq(documents.id, resourceAcl.documentId)),
      )
      .leftJoin(
        documentShares,
        and(
          eq(documentShares.tenantId, resourceAcl.tenantId),
          eq(documentShares.id, resourceAcl.sourceShareId),
        ),
      )
      .where(
        and(
          eq(resourceAcl.tenantId, principal.tenantId),
          eq(resourceAcl.documentId, documentId),
          eq(resourceAcl.identityId, principal.identityId),
        ),
      );
    return {
      roles: document.roles,
      actions: permissionActions.filter((action) => actions.includes(action)),
      directGrants: grants,
    };
  }
}
