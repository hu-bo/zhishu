import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { catalogs, documents, resourceAcl, workspaces } from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { policyEnforcer, roleActionSql, type PermissionAction } from "./policy.js";
import { loadPolicyOverrides, subjectActiveSql } from "./access.js";
import { DomainError } from "../../shared/domain-error.js";

export const documentAccessModes = ["personal", "workspace-inherited", "restricted"] as const;
export type DocumentAccessMode = (typeof documentAccessModes)[number];
type Subject = Pick<Principal, "tenantId" | "identityId">;
/** 允许列引用替代字面量，使 documentRolesSql 与空间键判定共用同一份片段。 */
type SqlSubject = { tenantId: string | SQLWrapper; identityId: string | SQLWrapper };
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

/** 从给定目录沿 parent 向上的继承链：起点含自身，遇到非 inherit 节点即止，深度上限 17。 */
function catalogChainSql(tenantId: string | SQLWrapper, catalogId: SQLWrapper | string): SQL {
  return sql`with recursive parents as (
    select c.id, c.parent_id, c.access_mode, 0 as depth from catalogs c where c.tenant_id = ${tenantId} and c.id = ${catalogId}
    union all select c.id, c.parent_id, c.access_mode, p.depth + 1 from catalogs c join parents p on c.id = p.parent_id
      where c.tenant_id = ${tenantId} and p.access_mode = 'inherit' and p.depth < 17
  )`;
}
/** 继承链上是否出现 restricted 目录（含自身）；出现即切断空间继承。 */
const chainHasRestrictedSql = sql`exists (select 1 from parents where parents.access_mode = 'restricted')`;

/**
 * 团队空间成员身份推导出的文档角色：空间 owner 记为 owner，否则取空间级 resource_acl 授予的角色。
 * documentRolesSql 的继承分支与向量空间键判定共用这一份定义，避免两处平行规则。
 */
const spaceMemberRoleSql = (principal: SqlSubject) =>
  sql`case when workspaces.owner_identity_id = ${principal.identityId} then 'owner' else resource_acl.role end`;
const spaceMemberJoinSql = (principal: SqlSubject) =>
  sql`from workspaces
    left join resource_acl on resource_acl.tenant_id = workspaces.tenant_id
      and resource_acl.workspace_id = workspaces.id and resource_acl.identity_id = ${principal.identityId}`;
/** 成员证明：owner 或确有空间级授权行。viewer 之类的目录浏览回退不算成员身份。 */
const spaceMemberProofSql = (principal: SqlSubject) =>
  sql`(workspaces.owner_identity_id = ${principal.identityId} or resource_acl.id is not null)`;

export function documentRolesSql(
  principal: { tenantId: string | SQLWrapper; identityId: string | SQLWrapper },
  d: Columns = documentColumns,
  includeAccessLinks = true,
): SQL {
  const catalogId =
    d.catalogId ??
    sql`(select loc.catalog_id from documents loc where loc.tenant_id = ${d.tenantId} and loc.id = ${d.id})`;
  return sql`${catalogChainSql(d.tenantId, catalogId)}
  select a.role from resource_acl a where a.tenant_id = ${d.tenantId} and a.document_id = ${d.id} and a.identity_id = ${principal.identityId} and ${documentGrantActiveSql(d, includeAccessLinks)}
  union select a.role from resource_acl a join parents p on p.id = a.catalog_id where a.tenant_id = ${d.tenantId} and a.identity_id = ${principal.identityId} and ${d.accessMode} = 'workspace-inherited'
  union select ${spaceMemberRoleSql(principal)} ${spaceMemberJoinSql(principal)}
    where workspaces.tenant_id = ${d.tenantId} and workspaces.id = ${d.workspaceId} and workspaces.kind = 'team'
      and ${d.accessMode} = 'workspace-inherited'
      and not ${chainHasRestrictedSql}
      and ${spaceMemberProofSql(principal)}`;
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

/**
 * 向量稳定授权键（Qdrant `readAclKeys`）的方案版本。键语义一旦变化必须递增：它进入索引配置
 * 指纹，已发布载荷会被判定过期并重建，避免出现"检索签了新键、旧 points 里却没有"的静默漏召回。
 */
export const ACL_KEY_VERSION = "acl-keys-v2";

/**
 * 一篇文档载荷应携带的稳定授权键。文档键始终保留：非成员受邀与目录级授权只能用它的，组键覆盖
 * 不到时也由它兜底。团队继承文档再盖空间键、个人空间文档再盖归属主体键，使"我的全部资料"这类
 * 范围的查询键从 O(文档) 降到 O(空间)。键只是可读正文的召回投影，判权仍以服务端当前关系为准。
 */
export function documentAclKeysSql(
  tenantId: string | SQLWrapper,
  d: Record<
    "documentId" | "workspaceId" | "catalogId" | "accessMode" | "workspaceKind" | "personalOwnerId",
    SQLWrapper | string
  >,
): SQL<string[]> {
  return sql<string[]>`(${catalogChainSql(tenantId, d.catalogId)}
    select array[concat('document:', ${d.documentId})]
      || case when ${d.accessMode} = 'workspace-inherited' and ${d.workspaceKind} = 'team'
                and not ${chainHasRestrictedSql}
              then array[concat('space:', ${d.workspaceId})] else array[]::text[] end
      || case when ${d.workspaceKind} = 'personal'
                and ${d.personalOwnerId} is not null
                -- 与包内 validAclKeys 的键格式一致：含 : 或空白的身份 id 不签主体键，退回文档键。
                and ${d.personalOwnerId} ~ '^[^[:space:]:]{1,160}$'
              then array[concat('user:', ${d.personalOwnerId})] else array[]::text[] end)`;
}

/** 索引 Worker 盖章用：单篇文档的载荷授权键，与检索侧走同一条 SQL 判定。 */
export async function loadDocumentAclKeys(
  db: Pick<Database, "select">,
  tenantId: string,
  documentId: string,
): Promise<string[]> {
  const [row] = await db
    .select({
      keys: documentAclKeysSql(tenantId, {
        documentId: documents.id,
        workspaceId: documents.workspaceId,
        catalogId: documents.catalogId,
        accessMode: documents.accessMode,
        workspaceKind: workspaces.kind,
        personalOwnerId: workspaces.personalOwnerId,
      }),
    })
    .from(documents)
    .innerJoin(
      workspaces,
      and(eq(workspaces.tenantId, documents.tenantId), eq(workspaces.id, documents.workspaceId)),
    )
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
    .limit(1);
  return row?.keys ?? [];
}

/**
 * 检索侧签发给 Qdrant 的键：audience 持有的组键能覆盖的文档不再逐篇签文档键，其余退到文档键。
 * aclKeys 来自 documentAclKeysSql，盖章与签发因此不会各写一套规则；站点访客不持有组键。
 */
export function signingAclKeys(
  sources: readonly { documentId: string; aclKeys: readonly string[] }[],
  heldGroupKeys: ReadonlySet<string>,
): string[] {
  const keys = new Set<string>();
  for (const source of sources) {
    const documentKey = `document:${source.documentId}`;
    keys.add(
      source.aclKeys.find((key) => key !== documentKey && heldGroupKeys.has(key)) ?? documentKey,
    );
  }
  return [...keys];
}

/**
 * 内部主体持有的组键：真实成员（owner 或空间级授权行）且该空间角色允许此文档动作的团队空间，
 * 加上自己的个人主体键。目录浏览的 viewer 回退不构成成员证明，因此签不出空间键。
 */
export async function heldAclGroupKeys(
  db: Pick<Database, "select">,
  principal: Subject,
  action: PermissionAction,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .leftJoin(
      resourceAcl,
      and(
        eq(resourceAcl.tenantId, workspaces.tenantId),
        eq(resourceAcl.workspaceId, workspaces.id),
        eq(resourceAcl.identityId, principal.identityId),
      ),
    )
    .where(
      and(
        eq(workspaces.tenantId, principal.tenantId),
        eq(workspaces.kind, "team"),
        spaceMemberProofSql(principal),
        roleActionSql(
          principal.tenantId,
          workspaces.id,
          "document",
          spaceMemberRoleSql(principal),
          action,
        ),
      ),
    );
  return new Set([...rows.map((row) => `space:${row.id}`), `user:${principal.identityId}`]);
}
