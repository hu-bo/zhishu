import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { rolePermissions } from "../../../database/schema/index.js";
import { roleActionSql, type PermissionAction } from "./policy.js";

export function subjectActiveSql(principal: {
  userId: string | SQLWrapper;
  identityId: string | SQLWrapper;
}) {
  return sql<boolean>`not exists (select 1 from identity_profiles disabled_subject where disabled_subject.user_id=${principal.userId} and disabled_subject.identity_id=${principal.identityId} and disabled_subject.active=false)`;
}

export function loadPolicyOverrides(
  db: Pick<Database, "select">,
  userId: string,
  workspaceId: string,
) {
  return db
    .select({
      resourceType: rolePermissions.resourceType,
      role: rolePermissions.role,
      actions: rolePermissions.actions,
    })
    .from(rolePermissions)
    .where(and(eq(rolePermissions.userId, userId), eq(rolePermissions.workspaceId, workspaceId)));
}

export function spaceActionSql(
  principal: { userId: string; identityId: string | SQLWrapper },
  action: PermissionAction,
  w: Record<"id" | "userId" | "kind" | "personalOwnerId" | "ownerIdentityId", SQLWrapper> = {
    id: sql`workspaces.id`,
    userId: sql`workspaces.user_id`,
    kind: sql`workspaces.kind`,
    personalOwnerId: sql`workspaces.personal_owner_id`,
    ownerIdentityId: sql`workspaces.owner_identity_id`,
  },
) {
  const role = sql`case when (${w.kind} = 'personal' and ${w.personalOwnerId} = ${principal.identityId}) or (${w.kind} <> 'personal' and ${w.ownerIdentityId} = ${principal.identityId}) then 'owner' else (select a.role from resource_acl a where a.user_id = ${w.userId} and a.workspace_id = ${w.id} and a.identity_id = ${principal.identityId} and ${w.kind} <> 'personal') end`;
  return sql<boolean>`(${w.userId} = ${principal.userId} and ${subjectActiveSql(principal)} and ${roleActionSql(w.userId, w.id, "space", role, action)})`;
}

type CatalogColumns = Record<"id" | "userId" | "workspaceId", SQLWrapper>;
export function catalogActionSql(
  principal: { userId: string; identityId: string | SQLWrapper },
  action: PermissionAction,
  c: CatalogColumns = {
    id: sql`catalogs.id`,
    userId: sql`catalogs.user_id`,
    workspaceId: sql`catalogs.workspace_id`,
  },
) {
  const allowed = roleActionSql(c.userId, c.workspaceId, "catalog", sql`granted.role`, action);
  return sql<boolean>`(${c.userId} = ${principal.userId} and ${subjectActiveSql(principal)} and exists (select 1 from (
    with recursive parents as (
      select p.id, p.parent_id, p.access_mode, 0 as depth from catalogs p where p.user_id = ${c.userId} and p.id = ${c.id}
      union all select p.id, p.parent_id, p.access_mode, a.depth + 1 from catalogs p join parents a on a.parent_id = p.id
        where p.user_id = ${c.userId} and a.access_mode = 'inherit' and a.depth < 17
    )
    select a.role from resource_acl a join parents p on p.id = a.catalog_id where a.user_id = ${c.userId} and a.identity_id = ${principal.identityId}
    union select case when (w.kind = 'personal' and w.personal_owner_id = ${principal.identityId}) or (w.kind <> 'personal' and w.owner_identity_id = ${principal.identityId}) then 'owner' else a.role end
      from workspaces w left join resource_acl a on a.user_id = w.user_id and a.workspace_id = w.id and a.identity_id = ${principal.identityId} and w.kind <> 'personal'
      where w.user_id = ${c.userId} and w.id = ${c.workspaceId} and not exists (select 1 from parents where access_mode = 'restricted')
  ) granted where ${allowed}))`;
}
