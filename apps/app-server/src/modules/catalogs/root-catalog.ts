import type { Database } from "../../../database/index.js";
import { catalogs } from "../../../database/schema/index.js";
export function rootCatalogId(workspaceId: string): string {
  return `cat_root_${workspaceId}`;
}
/** Idempotent root provisioning; safe on every workspace materialization path. */
export async function ensureRootCatalog(
  db: Pick<Database, "insert">,
  tenantId: string,
  workspaceId: string,
  createdBy = "system",
): Promise<string> {
  const id = rootCatalogId(workspaceId);
  await db
    .insert(catalogs)
    .values({
      tenantId,
      id,
      workspaceId,
      parentId: null,
      name: "根目录",
      position: 0,
      createdBy,
    })
    .onConflictDoNothing();
  return id;
}
