import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents, identityProfiles } from "../../../database/schema/index.js";
import { documentActionSql, hasDocumentPermission } from "../authorization/permissions.js";
import { DomainError } from "../../shared/domain-error.js";
import { readKnowledgeTree } from "../../shared/knowledge-transaction.js";
import type { Principal } from "./identity.types.js";

/**
 * Project authenticated principals into the directory. The hot path is a lock-free read:
 * unchanged profiles return without a transaction, so ordinary API requests never serialize
 * on the user tree lock. Only a changed projection takes the shared tree lock and upserts,
 * which still orders it against exclusive authorization/directory mutations.
 */
export async function rememberIdentities(db: Database, principals: readonly Principal[]) {
  if (!principals.length) return;
  const userIds = [...new Set(principals.map((p) => p.userId))];
  const existing = await db
    .select({
      userId: identityProfiles.userId,
      identityId: identityProfiles.identityId,
      displayName: identityProfiles.displayName,
      email: identityProfiles.email,
      active: identityProfiles.active,
    })
    .from(identityProfiles)
    .where(inArray(identityProfiles.userId, userIds));
  const byKey = new Map(existing.map((row) => [`${row.userId}:${row.identityId}`, row]));
  const changed = principals.filter((p) => {
    const row = byKey.get(`${p.userId}:${p.identityId}`);
    return (
      !row || row.displayName !== p.displayName || row.email !== p.email || row.active !== p.active
    );
  });
  if (!changed.length) return;
  await db.transaction(async (tx) => {
    for (const userId of [...new Set(changed.map((p) => p.userId))].sort())
      await readKnowledgeTree(tx, userId);
    await tx
      .insert(identityProfiles)
      .values(
        changed.map((p) => ({
          userId: p.userId,
          identityId: p.identityId,
          displayName: p.displayName,
          email: p.email,
          active: p.active,
        })),
      )
      .onConflictDoUpdate({
        target: [identityProfiles.userId, identityProfiles.identityId],
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
        eq(identityProfiles.userId, principal.userId),
        eq(identityProfiles.active, true),
        or(ilike(identityProfiles.displayName, pattern), ilike(identityProfiles.email, pattern)),
        documentId
          ? sql`exists (select 1 from ${documents} where ${documents.id} = ${documentId} and ${documents.status} = 'active' and ${documentActionSql({ userId: principal.userId, identityId: identityProfiles.identityId }, "read")})`
          : undefined,
      ),
    )
    .orderBy(asc(identityProfiles.displayName), asc(identityProfiles.identityId))
    .limit(20);
}
