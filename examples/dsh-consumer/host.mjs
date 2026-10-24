/* global structuredClone */
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import Persistence, {
  assertContiguous,
  materializeAppendBatch,
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from "@deepseek-ai/dsh-session-persistence";
/** Explicitly ephemeral deterministic host. It makes no production durability claim. */
export function createMemoryHost() {
  const records = new Map(),
    logs = new Map(),
    writers = new Set(),
    productWriters = new Set();
  const events = [];
  const faults = { flush: false, commit: false };
  class MemoryPersistence extends Persistence {
    handles = new Set();
    active = new Map();
    constructor(ctx) {
      super(ctx);
      ctx.on("session/event", (session, event) => {
        const h = this.active.get(session.id);
        if (h) void h.append([event]).catch(() => undefined);
      });
      ctx.on("session/flush", async (session) => {
        await this.active.get(session.id)?.flush();
      });
      ctx.effect(() => async () => {
        await Promise.all([...this.handles].map((h) => h.close()));
      });
    }
    async create(header) {
      if (logs.has(header.id)) throw new Error("EXISTS");
      logs.set(header.id, { header: structuredClone(header), events: [] });
      return this.open(header.id, "write");
    }
    async open(id, access) {
      const log = logs.get(id);
      if (!log) throw new SessionPersistenceNotFoundError(id);
      if (access === "write" && writers.has(id)) throw new SessionAlreadyOwnedError(id);
      if (access === "write") writers.add(id);
      let closed = false;
      const handle = {
        id,
        header: log.header,
        inheritedEventCount: SessionLogOffset(0),
        access,
        async read(offset = 0, length = Infinity) {
          if (closed) throw new Error("CLOSED");
          return {
            eventState: "detached",
            events: structuredClone(log.events.slice(offset, offset + length)),
          };
        },
        async append(events) {
          if (closed || access !== "write") throw new Error("READ_ONLY");
          const values = materializeAppendBatch(events);
          assertContiguous(id, values, log.events.length);
          log.events.push(...structuredClone(values));
        },
        async flush() {
          if (faults.flush) throw new Error("STORAGE_OFFLINE");
        },
        close: async () => {
          if (closed) return;
          closed = true;
          if (access === "write") {
            writers.delete(id);
            this.active.delete(id);
          }
          this.handles.delete(handle);
        },
        async [Symbol.asyncDispose]() {
          await handle.close();
        },
      };
      this.handles.add(handle);
      if (access === "write") this.active.set(id, handle);
      return handle;
    }
    async flush() {
      await Promise.all(
        [...this.handles].filter((h) => h.access === "write").map((h) => h.flush()),
      );
    }
    async stat(id) {
      const log = logs.get(id);
      return log
        ? {
            header: log.header,
            revision: SessionPersistenceRevision(String(log.events.length)),
            eventCount: log.events.length,
          }
        : undefined;
    }
    async list() {
      return Promise.all([...logs.keys()].map((id) => this.stat(id)));
    }
  }
  const store = {
    async acquire(id) {
      if (productWriters.has(id)) throw new Error("PRODUCT_WRITER_BUSY");
      productWriters.add(id);
      let closed = false;
      return {
        async load() {
          return structuredClone(records.get(id));
        },
        async commit(record, event) {
          if (faults.commit || closed) throw new Error("PRODUCT_STORAGE_OFFLINE");
          const previous = records.get(id)?.snapshot.cursor ?? "0";
          if (BigInt(event.sequence) !== BigInt(previous) + 1n) throw new Error("STALE");
          records.set(id, structuredClone(record));
          events.push(structuredClone(event));
        },
        async close() {
          closed = true;
          productWriters.delete(id);
        },
      };
    },
  };
  return { store, MemoryPersistence, records, logs, faults, events };
}
