import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documents, identityProfiles, notifications } from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { documentActionSql } from "../authorization/permissions.js";
import { DomainError } from "../../shared/domain-error.js";

type NotificationInput = Omit<typeof notifications.$inferInsert, "id" | "createdAt" | "readAt">;
export async function insertNotifications(
  db: Pick<Database, "insert">,
  inputs: readonly NotificationInput[],
) {
  const values = inputs.filter((n) => n.recipientId !== n.actorId);
  if (values.length) await db.insert(notifications).values(values).onConflictDoNothing();
}

export async function documentRecipients(
  db: Pick<Database, "execute">,
  tenantId: string,
  documentId: string,
) {
  const rows = await db.execute<{ identity_id: string }>(sql`
    select i.identity_id from identity_profiles i where i.tenant_id = ${tenantId} and exists (
      select 1 from documents where documents.tenant_id = ${tenantId} and documents.id = ${documentId}
      and ${documentActionSql({ tenantId, identityId: sql`i.identity_id` }, "read")}
    )
  `);
  return rows.rows.map((r) => r.identity_id);
}

export class NotificationRepository {
  constructor(private readonly db: Database) {}
  async list(principal: Principal, input: { unread: boolean; before?: string; limit: number }) {
    const available = sql<boolean>`${documents.status} = 'active' and ${documentActionSql(principal, "read")}`;
    const cursor = input.before
      ? (JSON.parse(Buffer.from(input.before, "base64url").toString()) as {
          at: string;
          id: string;
        })
      : null;
    const items = await this.db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        actorName: sql<string>`coalesce(${identityProfiles.displayName}, '一位成员')`,
        documentId: notifications.documentId,
        workspaceId: notifications.workspaceId,
        // Resolve links at read time: old notifications never bypass current permissions.
        available,
        documentTitle: sql<
          string | null
        >`case when ${available} then ${documents.title} else null end`,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
      })
      .from(notifications)
      .leftJoin(
        identityProfiles,
        and(
          eq(identityProfiles.tenantId, notifications.tenantId),
          eq(identityProfiles.identityId, notifications.actorId),
        ),
      )
      .leftJoin(
        documents,
        and(
          eq(documents.tenantId, notifications.tenantId),
          eq(documents.id, notifications.documentId),
        ),
      )
      .where(
        and(
          eq(notifications.tenantId, principal.tenantId),
          eq(notifications.recipientId, principal.identityId),
          input.unread ? isNull(notifications.readAt) : undefined,
          cursor
            ? or(
                lt(notifications.createdAt, new Date(cursor.at)),
                and(
                  eq(notifications.createdAt, new Date(cursor.at)),
                  lt(notifications.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(input.limit + 1);
    const page = items.slice(0, input.limit);
    const last = page.at(-1);
    const [count] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, principal.tenantId),
          eq(notifications.recipientId, principal.identityId),
          isNull(notifications.readAt),
        ),
      );
    return {
      items: page.map((n) => ({
        ...n,
        available: n.available === true,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unreadCount: count?.count ?? 0,
      nextCursor:
        items.length > input.limit && last
          ? Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: last.id })).toString(
              "base64url",
            )
          : null,
    };
  }
  async read(principal: Principal, id?: string) {
    const changed = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.tenantId, principal.tenantId),
          eq(notifications.recipientId, principal.identityId),
          id ? eq(notifications.id, id) : undefined,
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    if (id && !changed.length) {
      const [existing] = await this.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, principal.tenantId),
            eq(notifications.recipientId, principal.identityId),
            eq(notifications.id, id),
          ),
        );
      if (!existing) throw new DomainError("NOT_FOUND", "通知不存在");
    }
  }
}
