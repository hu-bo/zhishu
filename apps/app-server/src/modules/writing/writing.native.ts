import type { Pool, PoolClient } from "pg";
import {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionLogOffset,
  SessionOwnershipLostError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  validateStoredEvents,
  type Context,
  type SessionAccess,
  type SessionEvent,
  type SessionHandle,
  type SessionHeader,
  type SessionId,
  type SessionPersistenceCreateOptions,
} from "@zhishu/ai-writing/kernel";

interface Stored {
  header: SessionHeader;
  inherited_event_count: string;
  events: SessionEvent[];
  next_seq: string;
}

/**
 * Native session log identity is derivable: `ws_<conversation-32hex>_<revision>`.
 * Persistence rows carry tenant/conversation/contextRevision so product tables can
 * enforce composite foreign keys without a second snapshot of product state.
 */
export function nativeSessionIdFor(conversationId: string, contextRevision: number): string {
  return `ws_${conversationId.replace(/^ai_/, "")}_${contextRevision}`;
}
export function parseNativeSessionId(
  id: string,
): { conversationId: string; contextRevision: number } | undefined {
  const match = /^ws_([a-f0-9]{32})_(\d+)$/.exec(id);
  if (!match) return;
  return { conversationId: `ai_${match[1]}`, contextRevision: Number(match[2]) };
}

/** A dedicated PG connection holds each writer lock. Its loss fences every append. */
export function postgresNativeSessionPersistence(
  pool: Pool,
  onAppendError?: (sessionId: string, error: unknown) => void,
): new (ctx: Context) => SessionPersistence {
  return class PostgresNativeSessionPersistence extends SessionPersistence {
    private handles = new Set<SessionHandle>();
    private writers = new Map<string, SessionHandle>();
    constructor(ctx: Context) {
      super(ctx);
      ctx.on("session/event", (session, event) => {
        const handle = this.writers.get(session.id);
        // A failed append poisons the handle; flush/close expose it. Log the first fault.
        if (handle)
          void handle.append([event]).catch((error: unknown) => {
            onAppendError?.(session.id, error);
          });
      });
      ctx.on("session/flush", async (session) => {
        const handle = this.writers.get(session.id);
        if (handle) await handle.flush();
      });
      ctx.effect(() => async () => {
        await Promise.all([...this.handles].map((h) => h.close()));
      });
    }
    async create(header: SessionHeader, options?: SessionPersistenceCreateOptions) {
      options?.signal?.throwIfAborted();
      const checked = materializeCreateHeader(header);
      const parsed = parseNativeSessionId(checked.id);
      const meta = parsed
        ? await pool.query<{ tenantId: string }>(
            'select tenant_id as "tenantId" from ai_conversations where id=$1',
            [parsed.conversationId],
          )
        : undefined;
      const tenantId = meta?.rows[0]?.tenantId;
      if (!parsed || !tenantId) throw new Error("NATIVE_SESSION_CONTEXT_MISSING");
      const client = await this.writer(checked.id);
      try {
        const result = await client.query(
          `insert into writing_sessions(id,tenant_id,conversation_id,purpose,context_revision,header,inherited_event_count,events,next_seq)
           values($1,$2,$3,'writing',$4,$5,$6,'[]',0) on conflict do nothing returning id`,
          [
            checked.id,
            tenantId,
            parsed.conversationId,
            parsed.contextRevision,
            JSON.stringify(checked),
            options?.inheritedEventCount ?? 0,
          ],
        );
        if (!result.rowCount) throw new SessionAlreadyExistsError(checked.id);
        return this.handle(client, checked.id, "write");
      } catch (error) {
        await this.release(client, checked.id);
        throw error;
      }
    }
    async open(id: SessionId, access: SessionAccess, options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      const client = access === "write" ? await this.writer(id) : await pool.connect();
      try {
        return await this.handle(client, id, access);
      } catch (error) {
        if (access === "write") await this.release(client, id);
        else client.release();
        throw error;
      }
    }
    private async writer(id: SessionId) {
      const client = await pool.connect();
      try {
        const result = await client.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1,719101)) as locked",
          [id],
        );
        if (!result.rows[0]?.locked) throw new SessionAlreadyOwnedError(id);
        await client.query("set synchronous_commit = on");
        return client;
      } catch (error) {
        client.release();
        throw error;
      }
    }
    private async release(client: PoolClient, id: SessionId) {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1,719101))", [id]);
        client.release();
      } catch {
        client.release(true);
      }
    }
    private async handle(
      client: PoolClient,
      id: SessionId,
      access: SessionAccess,
    ): Promise<SessionHandle> {
      const load = async () => {
        const result = await client.query<Stored>(
          "select header,inherited_event_count,events,next_seq from writing_sessions where id=$1",
          [id],
        );
        const row = result.rows[0];
        if (!row) throw new SessionPersistenceNotFoundError(id);
        assertStoredId(id, row.header);
        assertVersion(row.header);
        validateStoredEvents(row.header, row.events);
        if (row.events.length !== Number(row.next_seq)) throw new Error("SESSION_CORRUPT");
        assertContiguous(id, row.events, 0);
        return row;
      };
      const row = await load();
      let closed = false,
        lost = false,
        cursor = row.events.length;
      let pending: Promise<unknown> = Promise.resolve();
      let closing: Promise<void> | undefined;
      const loss = () => {
        lost = true;
      };
      client.on("error", loss);
      client.on("end", loss);
      const check = (operation: string, write = false) => {
        if (closed) throw new SessionHandleClosedError(id, operation);
        if (lost) throw new SessionOwnershipLostError(id);
        if (write && access !== "write") throw new SessionReadOnlyError(id, operation);
      };
      const handle: SessionHandle = {
        id,
        header: materializeCreateHeader(row.header),
        access,
        inheritedEventCount: SessionLogOffset(Number(row.inherited_event_count)),
        async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {
          check("read");
          options?.signal?.throwIfAborted();
          await pending;
          const current = await load();
          return { eventState: "detached", events: current.events.slice(offset, offset + length) };
        },
        append(events, options) {
          check("append", true);
          const detached = materializeAppendBatch(events);
          const next = pending.then(async () => {
            if (lost) throw new SessionOwnershipLostError(id);
            options?.signal?.throwIfAborted();
            assertContiguous(id, detached, cursor);
            const result = await client.query(
              "update writing_sessions set events=events || $2::jsonb,next_seq=next_seq+$3,updated_at=now() where id=$1 and next_seq=$4",
              [id, JSON.stringify(detached), detached.length, cursor],
            );
            if (!result.rowCount) throw new SessionOwnershipLostError(id);
            cursor += detached.length;
          });
          // A failed append poisons this handle; flush and close must expose it.
          pending = next;
          return next;
        },
        async flush(options) {
          check("flush", true);
          options?.signal?.throwIfAborted();
          await pending;
          await client.query("select 1");
        },
        close: () => {
          closing ??= (async () => {
            if (closed) return;
            closed = true;
            try {
              await pending;
            } finally {
              client.removeListener("error", loss);
              client.removeListener("end", loss);
              this.handles.delete(handle);
              if (this.writers.get(id) === handle) this.writers.delete(id);
              if (access === "write") await this.release(client, id);
              else client.release(lost);
            }
          })();
          return closing;
        },
        async [Symbol.asyncDispose]() {
          await handle.close();
        },
      };
      this.handles.add(handle);
      if (access === "write") this.writers.set(id, handle);
      return handle;
    }
    async flush() {
      await Promise.all(
        [...this.handles].filter((h) => h.access === "write").map((h) => h.flush()),
      );
    }
    async stat(id: SessionId) {
      const result = await pool.query<Stored>(
        "select header,inherited_event_count,events,next_seq from writing_sessions where id=$1",
        [id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      assertStoredId(id, row.header);
      assertVersion(row.header);
      return {
        header: row.header,
        eventCount: Number(row.next_seq),
        revision: SessionPersistenceRevision(String(row.next_seq)),
      };
    }
    async list() {
      const result = await pool.query<{ id: SessionId }>(
        "select id from writing_sessions order by id limit 1000",
      );
      const snapshots = await Promise.all(result.rows.map((r) => this.stat(r.id)));
      return snapshots.filter((s) => s !== undefined);
    }
  };
}
