/* global structuredClone */
import { SessionLogOffset } from "@deepseek-ai/dsh-session";
import Persistence, {
  assertContiguous,
  materializeAppendBatch,
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from "@deepseek-ai/dsh-session-persistence";

/** Explicitly ephemeral deterministic host for kernel tests. It makes no production durability claim. */
export function createMemoryPersistencePlugin() {
  const logs = new Map(),
    writers = new Set(),
    faults = { flush: false };
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
  return { MemoryPersistence, logs, faults };
}

/** Recording turn host with optional injected failures, mirroring the shared product service. */
export function createRecordingHost(overrides = {}) {
  const calls = {
    planned: [],
    confirmed: [],
    approvals: [],
    resolved: [],
    previews: [],
    auth: 0,
    reserve: 0,
  };
  return {
    calls,
    host: {
      authorize: async () => {
        calls.auth++;
      },
      reserveModelCall: async () => {
        calls.reserve++;
        if (overrides.exceedModelBudget?.(calls.reserve)) throw new Error("BUDGET_EXCEEDED");
      },
      onDeliveryPlanned: async (turn, id) => {
        calls.planned.push([turn.runId, id]);
      },
      onDeliveryConfirmed: async (turn, id) => {
        calls.confirmed.push([turn.runId, id]);
      },
      onApprovalRequested: async (request) => {
        calls.approvals.push(request);
      },
      onApprovalResolved: async (request, outcome) => {
        calls.resolved.push([request.approvalId, outcome]);
      },
      emitPreview: (turn, frame) => {
        calls.previews.push({ runId: turn.runId, ...frame });
      },
    },
  };
}

export const turnRequest = (overrides = {}) => ({
  conversationId: "conv_test",
  runId: "run_test",
  attempt: 1,
  contextRevision: 1,
  inputText: "你好",
  nativeSessionId: "native_test",
  deadlineAtMs: Date.now() + 60_000,
  context: { contextRevision: 1, webSearch: false },
  ...overrides,
});
