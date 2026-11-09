import type { SessionInvalidator } from "../authorization/permissions.js";
import {
  idempotencyScope,
  loadIdempotencyReplay,
  storeIdempotencyReceipt,
} from "../../shared/idempotency.js";
import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { spaceActionSql } from "../authorization/access.js";
import { accessRoles } from "../authorization/policy.js";
import { insertNotifications } from "../notifications/index.js";
import {
  documentActionSql,
  requireWorkspaceDocumentManagers,
} from "../authorization/permissions.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  documents,
  workspaces,
  resourceAcl,
  identityProfiles,
} from "../../../database/schema/index.js";

import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import { ensureRootCatalog } from "../catalogs/index.js";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  SetWorkspaceMemberInput,
} from "./workspace.schema.js";

import { workspaceAccess, workspaceRole } from "../authorization/permissions.js";
import { workspaceSchema } from "./workspace.schema.js";

export class WorkspaceService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionInvalidator,
  ) {}
  async listWorkspaces(principal: Principal) {
    await this.db
      .insert(workspaces)
      .values({
        tenantId: principal.tenantId,
        id: "ws_default",
        name: "团队知识库",
        kind: "team",
        createdBy: "system",
      })
      .onConflictDoNothing();
    // Every workspace must expose a root catalog; backfill in bulk instead of per row.
    await this.db
      .execute(sql`insert into catalogs (tenant_id, id, workspace_id, parent_id, name, position, created_by)
      select w.tenant_id, 'cat_root_' || w.id, w.id, null, '根目录', 0, w.created_by from workspaces w
      where w.tenant_id = ${principal.tenantId}
        and not exists (select 1 from catalogs c where c.tenant_id = w.tenant_id and c.id = 'cat_root_' || w.id)`);
    const rows = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        personalOwnerId: workspaces.personalOwnerId,
        ownerIdentityId: workspaces.ownerIdentityId,
        authorizationRevision: workspaces.authorizationRevision,
        offlineCacheAllowed: workspaces.offlineCacheAllowed,
        icon: workspaces.icon,
        description: workspaces.description,
        createdBy: workspaces.createdBy,
        createdAt: workspaces.createdAt,
        memberCount: sql<number>`case when ${workspaces.kind} = 'personal' then 1 else (select count(*)::int from resource_acl m where m.tenant_id = ${principal.tenantId} and m.workspace_id = workspaces.id) + case when ${workspaces.ownerIdentityId} is null then 0 else 1 end end`,
        memberRole: sql<
          "admin" | "editor" | "viewer" | null
        >`(select m.role from resource_acl m where m.tenant_id = ${principal.tenantId} and m.workspace_id = workspaces.id and m.identity_id = ${principal.identityId})`,
        canManage: spaceActionSql(principal, "manage"),
        canOrganize: spaceActionSql(principal, "write"),
        rootCatalogId: sql<string>`'cat_root_' || ${workspaces.id}`,
        // Literal workspaces.id: an interpolated column would render bare and bind to the subquery alias.
        documentCount: sql<number>`(select count(*)::int from ${documents} d where d.tenant_id = ${principal.tenantId} and d.workspace_id = workspaces.id and d.status = 'active' and ${documentActionSql(principal, "read", { id: sql`d.id`, tenantId: sql`d.tenant_id`, workspaceId: sql`d.workspace_id`, createdBy: sql`d.created_by`, accessMode: sql`d.access_mode` })})`,
      })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, principal.tenantId), spaceActionSql(principal, "read")))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(100);
    return rows.map(({ memberRole, createdAt, ...row }) => {
      const role = workspaceRole(row, principal.identityId, memberRole);
      return {
        ...row,
        role,
        createdAt: createdAt.toISOString(),
      };
    });
  }
  async createWorkspace(
    principal: Principal,
    input: CreateWorkspaceInput,
    idempotencyKey?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-quota:${principal.tenantId}`}, 718269))`,
      );
      const receipt = idempotencyScope(principal, "workspaces.create", idempotencyKey, input);
      const replay = await loadIdempotencyReplay(tx, receipt, workspaceSchema);
      if (replay) return replay;
      await tx
        .insert(workspaces)
        .values({
          tenantId: principal.tenantId,
          id: "ws_default",
          name: "团队知识库",
          kind: "team",
          createdBy: "system",
        })
        .onConflictDoNothing();
      const [count] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workspaces)
        .where(eq(workspaces.tenantId, principal.tenantId));
      if ((count?.count ?? 0) >= 100)
        throw new DomainError("RESOURCE_LIMIT", "Workspace limit reached");
      const id = `ws_${randomUUID()}`;
      const [row] = await tx
        .insert(workspaces)
        .values({
          id,
          tenantId: principal.tenantId,
          name: input.name,
          kind: input.kind,
          personalOwnerId: input.kind === "personal" ? principal.identityId : null,
          ownerIdentityId: principal.identityId,
          icon: input.icon ?? null,
          description: input.description,
          createdBy: principal.identityId,
        })
        .returning({
          id: workspaces.id,
          name: workspaces.name,
          kind: workspaces.kind,
          personalOwnerId: workspaces.personalOwnerId,
          ownerIdentityId: workspaces.ownerIdentityId,
          authorizationRevision: workspaces.authorizationRevision,
          offlineCacheAllowed: workspaces.offlineCacheAllowed,
          icon: workspaces.icon,
          description: workspaces.description,
          createdBy: workspaces.createdBy,
          createdAt: workspaces.createdAt,
        });
      if (!row) throw new Error("Workspace insert returned no row");
      const rootCatalogId = await ensureRootCatalog(
        tx,
        principal.tenantId,
        id,
        principal.identityId,
      );
      const result = {
        ...row,
        createdAt: row.createdAt.toISOString(),
        rootCatalogId,
        documentCount: 0,
        memberCount: 1,
        role: "owner" as const,
        canManage: true,
        canOrganize: true,
      };
      await storeIdempotencyReceipt(tx, receipt, result, 201);
      return result;
    });
  }
  async updateWorkspace(principal: Principal, workspaceId: string, input: UpdateWorkspaceInput) {
    await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const access = await workspaceAccess(tx, principal, workspaceId);
      if (!access.canManage) throw new DomainError("NOT_FOUND", "空间不存在或无管理权限");
      await tx
        .update(workspaces)
        .set(input)
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)));
    });
    const updated = (await this.listWorkspaces(principal)).find((row) => row.id === workspaceId);
    if (!updated) throw new DomainError("NOT_FOUND", "空间不存在");
    return updated;
  }
  async listMembers(principal: Principal, workspaceId: string) {
    const { workspace, isMember } = await workspaceAccess(this.db, principal, workspaceId);
    if (!isMember) throw new DomainError("NOT_FOUND", "空间不存在或无权查看成员");
    const rows = await this.db
      .select({
        identityId: resourceAcl.identityId,
        displayName: sql<string>`coalesce(${identityProfiles.displayName}, ${resourceAcl.identityId})`,
        email: sql<string>`coalesce(${identityProfiles.email}, '')`,
        role: resourceAcl.role,
        createdAt: resourceAcl.createdAt,
      })
      .from(resourceAcl)
      .leftJoin(
        identityProfiles,
        and(
          eq(identityProfiles.tenantId, resourceAcl.tenantId),
          eq(identityProfiles.identityId, resourceAcl.identityId),
        ),
      )
      .where(
        and(eq(resourceAcl.tenantId, principal.tenantId), eq(resourceAcl.workspaceId, workspaceId)),
      )
      .orderBy(asc(resourceAcl.createdAt), asc(resourceAcl.identityId))
      .limit(500);
    const [ownerProfile] = await this.db
      .select()
      .from(identityProfiles)
      .where(
        and(
          eq(identityProfiles.tenantId, principal.tenantId),
          eq(identityProfiles.identityId, workspace.ownerIdentityId ?? ""),
        ),
      )
      .limit(1);
    const members = (
      workspace.kind === "personal"
        ? []
        : rows.filter((r) => r.identityId !== workspace.ownerIdentityId)
    ).map((row) => ({
      identityId: row.identityId,
      displayName: row.displayName,
      email: row.email,
      role: accessRoles.find((role) => role === row.role) ?? "viewer",
      createdAt: row.createdAt.toISOString(),
    }));
    return workspace.kind !== "personal" && workspace.ownerIdentityId === null
      ? members
      : [
          {
            identityId: workspace.ownerIdentityId ?? "",
            displayName:
              workspace.ownerIdentityId === principal.identityId
                ? principal.displayName
                : (ownerProfile?.displayName ?? workspace.ownerIdentityId ?? ""),
            email:
              workspace.ownerIdentityId === principal.identityId
                ? principal.email
                : (ownerProfile?.email ?? ""),
            role: "owner" as const,
            createdAt: workspace.createdAt.toISOString(),
          },
          ...members,
        ];
  }
  async setMember(
    principal: Principal,
    workspaceId: string,
    identityId: string,
    input: SetWorkspaceMemberInput,
  ) {
    const result = await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const access = await workspaceAccess(tx, principal, workspaceId);
      if (!access.canManage) throw new DomainError("NOT_FOUND", "空间不存在或无管理权限");
      if (access.workspace.kind === "personal")
        throw new DomainError("VALIDATION_ERROR", "个人空间不支持添加成员，请通过文档分享授权");
      if (identityId === access.workspace.ownerIdentityId)
        throw new DomainError("VALIDATION_ERROR", "空间所有者不能降级或移除");
      const [profile] = await tx
        .select()
        .from(identityProfiles)
        .where(
          and(
            eq(identityProfiles.tenantId, principal.tenantId),
            eq(identityProfiles.identityId, identityId),
          ),
        )
        .limit(1);
      if (!profile) throw new DomainError("VALIDATION_ERROR", "请选择同租户的真实成员");
      const memberInput = { role: input.role, updatedAt: new Date() };
      const [existing] = await tx
        .select()
        .from(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, principal.tenantId),
            eq(resourceAcl.workspaceId, workspaceId),
            eq(resourceAcl.identityId, identityId),
          ),
        )
        .limit(1);
      if (access.role !== "owner" && (input.role === "admin" || existing?.role === "admin"))
        throw new DomainError("VALIDATION_ERROR", "只有空间所有者可以管理管理员");
      if (!existing) {
        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(resourceAcl)
          .where(
            and(
              eq(resourceAcl.tenantId, principal.tenantId),
              eq(resourceAcl.workspaceId, workspaceId),
            ),
          );
        if ((count?.value ?? 0) >= 499)
          throw new DomainError("RESOURCE_LIMIT", "空间成员数量已达上限");
      }
      const [member] = await tx
        .insert(resourceAcl)
        .values({
          tenantId: principal.tenantId,
          workspaceId,
          identityId,
          createdBy: principal.identityId,
          ...memberInput,
        })
        .onConflictDoUpdate({
          target: [resourceAcl.tenantId, resourceAcl.workspaceId, resourceAcl.identityId],
          set: memberInput,
        })
        .returning();
      if (!member) throw new Error("Member insert returned no row");
      await requireWorkspaceDocumentManagers(tx, principal.tenantId, workspaceId);
      if (!existing || existing.role !== input.role)
        await insertNotifications(tx, [
          {
            tenantId: principal.tenantId,
            actorId: principal.identityId,
            recipientId: identityId,
            type: "permission",
            eventKey: `membership:${randomUUID()}`,
            workspaceId,
            message: existing ? "你的空间角色已更新" : "你已被添加到团队空间",
          },
        ]);
      return {
        identityId,
        displayName: profile.displayName,
        email: profile.email,
        role: input.role,
        createdAt: member.createdAt.toISOString(),
      };
    });
    await this.sessions.inherited(principal.tenantId, workspaceId, identityId);
    return result;
  }
  async removeMember(principal: Principal, workspaceId: string, identityId: string) {
    await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const access = await workspaceAccess(tx, principal, workspaceId);
      if (!access.canManage) throw new DomainError("NOT_FOUND", "空间不存在或无管理权限");
      if (access.workspace.kind === "personal")
        throw new DomainError("VALIDATION_ERROR", "个人空间不支持成员管理，请通过文档分享管理授权");
      if (identityId === access.workspace.ownerIdentityId)
        throw new DomainError("VALIDATION_ERROR", "空间所有者不能降级或移除");
      const [member] = await tx
        .select()
        .from(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, principal.tenantId),
            eq(resourceAcl.workspaceId, workspaceId),
            eq(resourceAcl.identityId, identityId),
          ),
        )
        .limit(1);
      if (member?.role === "admin" && access.role !== "owner")
        throw new DomainError("VALIDATION_ERROR", "只有空间所有者可以管理管理员");
      if (member)
        await insertNotifications(tx, [
          {
            tenantId: principal.tenantId,
            actorId: principal.identityId,
            recipientId: identityId,
            type: "permission",
            eventKey: `membership-removed:${randomUUID()}`,
            workspaceId,
            message: "你已被移出团队空间，空间继承权限已撤销",
          },
        ]);
      await tx
        .delete(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, principal.tenantId),
            eq(resourceAcl.workspaceId, workspaceId),
            eq(resourceAcl.identityId, identityId),
          ),
        );
      await requireWorkspaceDocumentManagers(tx, principal.tenantId, workspaceId);
    });
    await this.sessions.inherited(principal.tenantId, workspaceId, identityId);
  }
}
