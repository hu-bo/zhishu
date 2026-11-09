import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents, identityProfiles } from "../../../database/schema/index.js";
import { documentActionSql, hasDocumentPermission } from "../authorization/permissions.js";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "./identity.types.js";

export async function rememberIdentities(db: Database, principals: readonly Principal[]) {
  if (!principals.length) return;
  await db.transaction(async (tx) => {
    for (const tenantId of [...new Set(principals.map((p) => p.tenantId))].sort())
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${tenantId}`},718268))`,
      );
    await tx
      .insert(identityProfiles)
      .values(
        principals.map((p) => ({
          tenantId: p.tenantId,
          identityId: p.identityId,
          displayName: p.displayName,
          email: p.email,
          active: p.active,
        })),
      )
      .onConflictDoUpdate({
        target: [identityProfiles.tenantId, identityProfiles.identityId],
        set: {
          displayName: sql`excluded.display_name`,
          email: sql`excluded.email`,
          active: sql`excluded.active`,
          updatedAt: new Date(),
        },
        setWhere: sql`${identityProfiles.displayName} is distinct from excluded.display_name or ${identityProfiles.email} is distinct from excluded.email or ${identityProfiles.active} is distinct from excluded.active`,
      });
  });
}

export async function searchIdentities(
  db: Database,
  principal: Principal,
  query: string,
  documentId?: string,
) {
  if (documentId && !(await hasDocumentPermission(db, principal, documentId, "read")))
    throw new DomainError("NOT_FOUND", "文档不存在");
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  return db
    .select({
      identityId: identityProfiles.identityId,
      displayName: identityProfiles.displayName,
      email: identityProfiles.email,
    })
    .from(identityProfiles)
    .where(
      and(
        eq(identityProfiles.tenantId, principal.tenantId),
        eq(identityProfiles.active, true),
        or(ilike(identityProfiles.displayName, pattern), ilike(identityProfiles.email, pattern)),
        documentId
          ? sql`exists (select 1 from ${documents} where ${documents.id} = ${documentId} and ${documents.status} = 'active' and ${documentActionSql({ tenantId: principal.tenantId, identityId: identityProfiles.identityId }, "read")})`
          : undefined,
      ),
    )
    .orderBy(asc(identityProfiles.displayName), asc(identityProfiles.identityId))
    .limit(20);
}
