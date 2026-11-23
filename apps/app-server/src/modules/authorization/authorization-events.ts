import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  authorizationEvents,
  documents,
  documentGenerations,
  documentShares,
} from "../../../database/schema/index.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";

/** Each API/room owner consumes the durable permission outbox independently. */
export class AuthorizationEventWorker {
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopped = true;
  private polling: Promise<void> | undefined;
  private expiryCheckedAt = new Date();
  constructor(
    private readonly db: Database,
    private readonly revoker: CollaborationSessionRevoker,
    private readonly onError: (error: unknown) => void,
  ) {}
  async start() {
    const [row] = await this.db
      .select({ id: sql<number>`coalesce(max(${authorizationEvents.id}),0)`.mapWith(Number) })
      .from(authorizationEvents);
    this.cursor = row?.id ?? 0;
    this.stopped = false;
    this.schedule();
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pending = this.poll()
        .catch(this.onError)
        .finally(() => {
          this.pending = undefined;
          this.schedule();
        });
    }, 500);
    this.timer.unref();
  }
  poll(): Promise<void> {
    this.polling ??= this.drain().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async drain() {
    const checkedAt = new Date();
    const expired = await this.db
      .select({ documentId: documents.id, generationId: documentGenerations.id })
      .from(documentShares)
      .innerJoin(
        documents,
        and(
          eq(documents.tenantId, documentShares.tenantId),
          eq(documents.id, documentShares.documentId),
        ),
      )
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(
        and(
          eq(documentShares.kind, "access"),
          gt(documentShares.expiresAt, this.expiryCheckedAt),
          sql`${documentShares.expiresAt} <= ${checkedAt}`,
        ),
      );
    for (const session of expired)
      this.revoker.revokeDocumentSessions(session.documentId, session.generationId);
    this.expiryCheckedAt = checkedAt;
    const events = await this.db
      .select()
      .from(authorizationEvents)
      .where(gt(authorizationEvents.id, this.cursor))
      .orderBy(asc(authorizationEvents.id))
      .limit(100);
    const scopes = new Map(
      events.map((event) => [
        `${event.tenantId}:${event.workspaceId}:${event.documentId ?? "*"}`,
        event,
      ]),
    );
    for (const event of scopes.values()) {
      // A purge removes the rows used below. Its before-delete event retains only
      // generation ids, allowing every owner to close rooms after the cascade.
      const deletedGenerations = event.before?.generationIds;
      if (event.documentId && Array.isArray(deletedGenerations))
        for (const generationId of deletedGenerations)
          if (typeof generationId === "string")
            this.revoker.revokeDocumentSessions(event.documentId, generationId);
      const sessions = await this.db
        .select({ documentId: documents.id, generationId: documentGenerations.id })
        .from(documents)
        .innerJoin(documentGenerations, eq(documents.id, documentGenerations.documentId))
        .where(
          and(
            eq(documents.tenantId, event.tenantId),
            event.documentId
              ? eq(documents.id, event.documentId)
              : eq(documents.workspaceId, event.workspaceId),
          ),
        );
      for (const session of sessions)
        this.revoker.revokeDocumentSessions(session.documentId, session.generationId);
    }
    if (events.length) this.cursor = events.at(-1)!.id;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
    await this.polling;
  }
}
