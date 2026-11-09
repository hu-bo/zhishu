import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents } from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { policyEnforcer, roleActionSql, type PermissionAction } from "./policy.js";
import { loadPolicyOverrides, subjectActiveSql } from "./access.js";
import { DomainError } from "../../shared/domain-error.js";

export const documentAccessModes = ["personal", "workspace-inherited", "restricted"] as const;
export type DocumentAccessMode = (typeof documentAccessModes)[number];
type Subject = Pick<Principal, "tenantId" | "identityId">;
type Columns = Record<
  "id" | "tenantId" | "createdBy" | "workspaceId" | "accessMode",
  SQLWrapper
> & { catalogId?: SQLWrapper };

const documentColumns: Columns = {
  id: sql`documents.id`,
  tenantId: sql`documents.tenant_id`,
  createdBy: sql`documents.created_by`,
  workspaceId: sql`documents.workspace_id`,
  accessMode: sql`documents.access_mode`,
  catalogId: sql`documents.catalog_id`,
};

export function documentRolesSql(
  principal: { tenantId: string | SQLWrapper; identityId: string | SQLWrapper },
  d: Columns = documentColumns,
  includeAccessLinks = true,
): SQL {
  const catalogId =
    d.catalogId ??
    sql`(select loc.catalog_id from documents loc where loc.tenant_id = ${d.tenantId} and loc.id = ${d.id})`;
  return sql`with recursive parents as (
    select c.id, c.parent_id, c.access_mode, 0 as depth from catalogs c where c.tenant_id = ${d.tenantId} and c.id = ${catalogId}
    union all select c.id, c.parent_id, c.access_mode, p.depth + 1 from catalogs c join parents p on c.id = p.parent_id
      where c.tenant_id = ${d.tenantId} and p.access_mode = 'inherit' and p.depth < 17
  )
  select a.role from resource_acl a where a.tenant_id = ${d.tenantId} and a.document_id = ${d.id} and a.identity_id = ${principal.identityId} and ${documentGrantActiveSql(d, includeAccessLinks)}
  union select a.role from resource_acl a join parents p on p.id = a.catalog_id where a.tenant_id = ${d.tenantId} and a.identity_id = ${principal.identityId} and ${d.accessMode} = 'workspace-inherited'
  union select case when w.owner_identity_id = ${principal.identityId} then 'owner' else a.role end from workspaces w
    left join resource_acl a on a.tenant_id = w.tenant_id and a.workspace_id = w.id and a.identity_id = ${principal.identityId}
    where w.tenant_id = ${d.tenantId} and w.id = ${d.workspaceId} and w.kind = 'team' and ${d.accessMode} = 'workspace-inherited'
      and not exists (select 1 from parents where access_mode = 'restricted') and (w.owner_identity_id = ${principal.identityId} or a.id is not null)`;
}

export function documentGrantActiveSql(
  d: Columns = documentColumns,
  includeAccessLinks = true,
  alias = "a",
): SQL<boolean> {
  const grant = sql.identifier(alias);
  const durable = sql`${grant}.source_share_id is null or exists (select 1 from document_shares source where source.tenant_id = ${grant}.tenant_id and source.id = ${grant}.source_share_id and source.kind = 'invite')`;
  if (!includeAccessLinks) return sql`(${durable})`;
  const grantor = { tenantId: d.tenantId, identityId: sql`source.created_by` };
  return sql`(${durable} or exists (select 1 from document_shares source where source.tenant_id = ${grant}.tenant_id and source.id = ${grant}.source_share_id and source.kind = 'access' and source.revoked_at is null and source.expires_at > statement_timestamp()
    and ${documentActionSql(grantor, "share", d, false)} and ${documentActionSql(grantor, "read", d, false)}
    and (source.permission = 'read' or (${documentActionSql(grantor, "write", d, false)} and ${documentActionSql(grantor, "comment", d, false)}))))`;
}

export function documentActionSql(
  principal: { tenantId: string | SQLWrapper; identityId: string | SQLWrapper },
  action: PermissionAction,
  d: Columns = documentColumns,
  includeAccessLinks = true,
): SQL<boolean> {
  const allowed = roleActionSql(
    d.tenantId,
    d.workspaceId,
    "document",
    sql`grant_roles.role`,
    action,
  );
  return sql<boolean>`(${d.tenantId} = ${principal.tenantId} and ${subjectActiveSql(principal)} and exists (select 1 from (${documentRolesSql(principal, d, includeAccessLinks)}) grant_roles where ${allowed}))`;
}

export async function hasDocumentPermission(
  db: Pick<Database, "select">,
  principal: Subject,
  documentId: string,
  action: PermissionAction,
) {
  const [row] = await db
    .select({
      workspaceId: documents.workspaceId,
      active: subjectActiveSql(principal),
      roles: sql<string[]>`array(select role from (${documentRolesSql(principal)}) granted)`,
    })
    .from(documents)
    .where(and(eq(documents.tenantId, principal.tenantId), eq(documents.id, documentId)))
    .limit(1);
  if (!row || !row.active) return false;
  const engine = await policyEnforcer(
    await loadPolicyOverrides(db, principal.tenantId, row.workspaceId),
  );
  return engine.enforce(row.roles, "document", action);
}

function documentManagerExistsSql(tenantId: string) {
  const subject = { tenantId, identityId: sql`manager.identity_id` };
  return sql<boolean>`exists (select 1 from (
      select identity_id from resource_acl where tenant_id = ${tenantId}
      union select owner_identity_id from workspaces where tenant_id = ${tenantId}
      union select personal_owner_id from workspaces where tenant_id = ${tenantId} and personal_owner_id is not null
    ) manager where manager.identity_id not in ('system', 'migration')
      and ${documentActionSql(subject, "read")} and ${documentActionSql(subject, "manage")})`;
}

// Check the resulting policy inside the authorization mutation transaction. Candidates
// include legacy identities without a profile, but exclude non-login system actors.
export async function requireDocumentManager(
  db: Pick<Database, "select">,
  tenantId: string,
  documentId: string,
) {
  const [row] = await db
    .select({ manageable: documentManagerExistsSql(tenantId) })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)));
  if (!row?.manageable)
    throw new DomainError(
      "CONFLICT",
      "必须保留至少一名具有查看和管理权限的成员，请先添加文档管理员",
    );
}

export async function requireWorkspaceDocumentManagers(
  db: Pick<Database, "select">,
  tenantId: string,
  workspaceId: string,
) {
  const [unmanaged] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.tenantId, tenantId),
        eq(documents.workspaceId, workspaceId),
        sql`not ${documentManagerExistsSql(tenantId)}`,
      ),
    )
    .limit(1);
  if (unmanaged) throw new DomainError("CONFLICT", "此操作会使文档失去管理员，请先调整文档授权");
}
