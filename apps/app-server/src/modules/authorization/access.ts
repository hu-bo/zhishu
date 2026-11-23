import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { rolePermissions } from "../../../database/schema/index.js";
import { roleActionSql, type PermissionAction } from "./policy.js";

export function subjectActiveSql(principal: {
  tenantId: string | SQLWrapper;
  identityId: string | SQLWrapper;
}) {
  return sql<boolean>`not exists (select 1 from identity_profiles disabled_subject where disabled_subject.tenant_id=${principal.tenantId} and disabled_subject.identity_id=${principal.identityId} and disabled_subject.active=false)`;
}

export function loadPolicyOverrides(
  db: Pick<Database, "select">,
  tenantId: string,
  workspaceId: string,
) {
  return db
    .select({
      resourceType: rolePermissions.resourceType,
      role: rolePermissions.role,
      actions: rolePermissions.actions,
    })
    .from(rolePermissions)
    .where(
      and(eq(rolePermissions.tenantId, tenantId), eq(rolePermissions.workspaceId, workspaceId)),
    );
}

export function spaceActionSql(
  principal: { tenantId: string; identityId: string | SQLWrapper },
  action: PermissionAction,
  w: Record<"id" | "tenantId" | "kind" | "personalOwnerId" | "ownerIdentityId", SQLWrapper> = {
    id: sql`workspaces.id`,
    tenantId: sql`workspaces.tenant_id`,
    kind: sql`workspaces.kind`,
    personalOwnerId: sql`workspaces.personal_owner_id`,
    ownerIdentityId: sql`workspaces.owner_identity_id`,
  },
) {
  const role = sql`case when (${w.kind} = 'personal' and ${w.personalOwnerId} = ${principal.identityId}) or (${w.kind} <> 'personal' and ${w.ownerIdentityId} = ${principal.identityId}) then 'owner' else (select a.role from resource_acl a where a.tenant_id = ${w.tenantId} and a.workspace_id = ${w.id} and a.identity_id = ${principal.identityId} and ${w.kind} <> 'personal') end`;
  return sql<boolean>`(${w.tenantId} = ${principal.tenantId} and ${subjectActiveSql(principal)} and ${roleActionSql(w.tenantId, w.id, "space", role, action)})`;
}

type CatalogColumns = Record<"id" | "tenantId" | "workspaceId", SQLWrapper>;
export function catalogActionSql(
  principal: { tenantId: string; identityId: string | SQLWrapper },
  action: PermissionAction,
  c: CatalogColumns = {
    id: sql`catalogs.id`,
    tenantId: sql`catalogs.tenant_id`,
    workspaceId: sql`catalogs.workspace_id`,
  },
) {
  const allowed = roleActionSql(c.tenantId, c.workspaceId, "catalog", sql`granted.role`, action);
  return sql<boolean>`(${c.tenantId} = ${principal.tenantId} and ${subjectActiveSql(principal)} and exists (select 1 from (
    with recursive parents as (
      select p.id, p.parent_id, p.access_mode, 0 as depth from catalogs p where p.tenant_id = ${c.tenantId} and p.id = ${c.id}
      union all select p.id, p.parent_id, p.access_mode, a.depth + 1 from catalogs p join parents a on a.parent_id = p.id
        where p.tenant_id = ${c.tenantId} and a.access_mode = 'inherit' and a.depth < 17
    )
    select a.role from resource_acl a join parents p on p.id = a.catalog_id where a.tenant_id = ${c.tenantId} and a.identity_id = ${principal.identityId}
    union select case when (w.kind = 'personal' and w.personal_owner_id = ${principal.identityId}) or (w.kind <> 'personal' and w.owner_identity_id = ${principal.identityId}) then 'owner' else a.role end
      from workspaces w left join resource_acl a on a.tenant_id = w.tenant_id and a.workspace_id = w.id and a.identity_id = ${principal.identityId} and w.kind <> 'personal'
      where w.tenant_id = ${c.tenantId} and w.id = ${c.workspaceId} and not exists (select 1 from parents where access_mode = 'restricted')
  ) granted where ${allowed}))`;
}
