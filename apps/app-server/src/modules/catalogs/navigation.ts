import { sql, type SQLWrapper } from "drizzle-orm";
import { catalogActionSql, spaceActionSql } from "../authorization/access.js";
import type { Principal } from "../identity/identity.types.js";

type Subject = Pick<Principal, "tenantId" | "identityId">;
export type CatalogPathSegment = { id: string; name: string };

export function workspaceNameSql(principal: Subject) {
  return sql<string>`case when ${spaceActionSql(principal, "read")} then workspaces.name else '与我共享' end`;
}

// A readable child never grants the names or navigation capabilities of its
// ancestors. Project each visible segment in the same snapshot as the document.
export function catalogPathSql(
  principal: Subject,
  location: { catalogId: SQLWrapper; workspaceId: SQLWrapper },
  includeRoot = true,
) {
  const visible = catalogActionSql(principal, "read", {
    id: sql`path_node.id`,
    tenantId: sql`path_node.tenant_id`,
    workspaceId: sql`path_node.workspace_id`,
  });
  return sql<CatalogPathSegment[]>`(with recursive navigation_path as (
    select c.id, c.tenant_id, c.workspace_id, c.parent_id, c.name, array[c.id] as visited, 0 as depth
      from catalogs c where c.tenant_id = ${principal.tenantId}
        and c.workspace_id = ${location.workspaceId} and c.id = ${location.catalogId}
    union all
    select c.id, c.tenant_id, c.workspace_id, c.parent_id, c.name, p.visited || c.id, p.depth + 1
      from catalogs c join navigation_path p on c.id = p.parent_id
      where c.tenant_id = ${principal.tenantId} and c.workspace_id = ${location.workspaceId}
        and not c.id = any(p.visited) and p.depth < 17
  ) select coalesce(jsonb_agg(jsonb_build_object('id', path_node.id, 'name', path_node.name)
      order by path_node.depth desc) filter (where ${visible} and (${includeRoot} or path_node.parent_id is not null)), '[]'::jsonb)
    from navigation_path path_node)`;
}
