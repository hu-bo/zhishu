import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { catalogs, documents, resourceAcl, workspaces } from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { catalogActionSql } from "../authorization/access.js";
import { documentActionSql } from "../authorization/permissions.js";
import { requireWorkspaceOrganizer } from "../authorization/permissions.js";
import { DomainError } from "../../shared/domain-error.js";

export type TransferRequest = {
  kind: "document" | "catalog";
  resourceId: string;
  targetCatalogId: string;
};
export async function previewTransfer(
  db: Pick<Database, "select" | "execute">,
  principal: Principal,
  input: TransferRequest,
) {
  const [target] = await db
    .select({ workspaceId: catalogs.workspaceId })
    .from(catalogs)
    .where(
      and(
        eq(catalogs.tenantId, principal.tenantId),
        eq(catalogs.id, input.targetCatalogId),
        catalogActionSql(principal, "write"),
      ),
    )
    .limit(1);
  if (!target) throw new DomainError("NOT_FOUND", "目标目录不可编辑");
  const destination = await requireWorkspaceOrganizer(db, principal, target.workspaceId);
  let workspaceId: string;
  let rows: { id: string; metadataRevision: number; accessMode: string; exportable: boolean }[];
  let tree: unknown[] = [];
  if (input.kind === "document") {
    const [source] = await db
      .select({
        workspaceId: documents.workspaceId,
        id: documents.id,
        metadataRevision: documents.metadataRevision,
        accessMode: documents.accessMode,
        exportable: documentActionSql(principal, "export"),
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.id, input.resourceId),
          eq(documents.status, "active"),
          documentActionSql(principal, "move"),
        ),
      )
      .limit(1);
    if (!source) throw new DomainError("NOT_FOUND", "文档不存在或无移动权限");
    workspaceId = source.workspaceId;
    rows = [source];
  } else {
    const [source] = await db
      .select()
      .from(catalogs)
      .where(
        and(
          eq(catalogs.tenantId, principal.tenantId),
          eq(catalogs.id, input.resourceId),
          catalogActionSql(principal, "move"),
        ),
      )
      .limit(1);
    if (!source) throw new DomainError("NOT_FOUND", "目录不存在或无移动权限");
    workspaceId = source.workspaceId;
    const subtree = sql`with recursive subtree as (select id,0 as depth from catalogs where tenant_id=${principal.tenantId} and id=${input.resourceId} union all select c.id,s.depth+1 from catalogs c join subtree s on c.parent_id=s.id where c.tenant_id=${principal.tenantId} and s.depth<17)`;
    rows = (
      await db.execute<{
        id: string;
        metadataRevision: number;
        accessMode: string;
        exportable: boolean;
      }>(
        sql`${subtree} select documents.id,documents.metadata_revision as "metadataRevision",documents.access_mode as "accessMode",${documentActionSql(principal, "export")} as exportable from documents where documents.tenant_id=${principal.tenantId} and documents.catalog_id in(select id from subtree) order by documents.id`,
      )
    ).rows;
    tree = (
      await db.execute(
        sql`${subtree} select c.id,c.parent_id,c.updated_at from catalogs c where c.tenant_id=${principal.tenantId} and c.id in(select id from subtree) order by c.id`,
      )
    ).rows;
  }
  const crossWorkspace = workspaceId !== target.workspaceId;
  if (rows.some((row) => !row.exportable))
    throw new DomainError("NOT_FOUND", "权限影响预览需要全部文档的导出权限");
  const [sourceSpace] = await db
    .select({ revision: workspaces.authorizationRevision })
    .from(workspaces)
    .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)));
  const ids = rows.map((row) => row.id);
  const [grants] = await db
    .select({ count: sql<number>`count(distinct ${resourceAcl.identityId})::int` })
    .from(resourceAcl)
    .where(
      and(
        eq(resourceAcl.tenantId, principal.tenantId),
        sql`${resourceAcl.documentId} = any(${sql.param(ids)}::text[])`,
      ),
    );
  const token = createHash("sha256")
    .update(
      JSON.stringify([
        principal.identityId,
        input,
        sourceSpace?.revision,
        destination.workspace.authorizationRevision,
        rows,
        tree,
      ]),
    )
    .digest("hex");
  return {
    token,
    crossWorkspace,
    documentCount: rows.length,
    preservedDirectSubjectCount: grants?.count ?? 0,
    targetMemberAccess:
      destination.workspace.kind === "team"
        ? ("inherit-as-configured" as const)
        : ("explicit-only" as const),
    revokePublicLinks: crossWorkspace,
  };
}
