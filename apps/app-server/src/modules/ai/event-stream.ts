import type { FastifyReply } from "fastify";
import { isAiEvent, type AiEvent } from "@zhishu/chat-contracts";
import type { AiService } from "./ai.service.js";
import type { ConversationRow } from "./ai.types.js";

/**
 * Shared conversation transport used by internal and public entry points. Same event
 * envelope and cursor semantics everywhere; a dropped SSE connection only releases the
 * subscription and never cancels a Run.
 */

export interface LiveFeed {
  /** In-process durable wake: emit after a product transaction appended events. */
  wake(conversationKey: string): void;
  next(conversationKey: string, waitMs: number, signal: AbortSignal): Promise<"wake" | "timeout">;
}

export class ConversationEventBus implements LiveFeed {
  private waiters = new Map<string, Set<() => void>>();

  wake(key: string): void {
    for (const resolve of this.waiters.get(key) ?? []) resolve();
  }

  next(key: string, waitMs: number, signal: AbortSignal): Promise<"wake" | "timeout"> {
    if (signal.aborted) return Promise.resolve("timeout");
    return new Promise((resolve) => {
      const settle = (kind: "wake" | "timeout") => {
        cleanup();
        resolve(kind);
      };
      const timer = setTimeout(() => settle("timeout"), waitMs);
      const abort = () => settle("timeout");
      const listeners = this.waiters.get(key) ?? new Set();
      const wake = () => settle("wake");
      listeners.add(wake);
      this.waiters.set(key, listeners);
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(wake);
        signal.removeEventListener("abort", abort);
      };
    });
  }
}

export const conversationKey = (conversation: Pick<ConversationRow, "tenantId" | "id">) =>
  `${conversation.tenantId}:${conversation.id}`;

export interface SseHandle {
  frame(value: unknown, id?: string): void;
  heartbeat(): void;
  close(): void;
  /** True once the transport ended, including a slow-consumer cutoff. */
  readonly closed: boolean;
}

/**
 * Slow-consumer backpressure: frames are bounded, but a stalled socket must not buffer
 * without limit. Past the threshold the connection is destroyed; clients recover from
 * the durable cursor with a snapshot refetch.
 */
const SSE_MAX_BUFFERED_BYTES = 1_048_576;

export function startSse(reply: FastifyReply): SseHandle {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  const write = (chunk: string) => {
    if (closed) return;
    reply.raw.write(chunk);
    if (reply.raw.writableLength > SSE_MAX_BUFFERED_BYTES) {
      closed = true;
      reply.raw.destroy();
    }
  };
  return {
    frame(value, id) {
      const data = JSON.stringify(value);
      write(id !== undefined ? `id: ${id}\ndata: ${data}\n\n` : `data: ${data}\n\n`);
    },
    heartbeat() {
      write(": heartbeat\n\n");
    },
    close() {
      if (closed) return;
      closed = true;
      reply.raw.end();
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Streams durable product events from the outbox cursor, wakes on same-process commits and
 * falls back to bounded polling for cross-instance delivery. Preview frames are injected by
 * the caller between event batches; gaps require the client to refetch a snapshot.
 * Public callers may filter events against current authorization and revalidate the gate
 * each poll; a failed gate ends the stream with a resync frame.
 */
export async function streamConversation(
  service: AiService,
  bus: LiveFeed,
  conversation: ConversationRow,
  cursor: string,
  sse: SseHandle,
  signal: AbortSignal,
  extraFrames?: () => unknown[],
  filterEvent?: (event: AiEvent) => Promise<boolean>,
  revalidate?: () => Promise<boolean>,
): Promise<void> {
  let position = cursor;
  const key = conversationKey(conversation);
  const resync = () => {
    sse.frame({
      type: "resync-required",
      conversationId: conversation.id,
    });
  };
  while (!signal.aborted && !sse.closed) {
    if (revalidate && !(await revalidate())) {
      resync();
      return;
    }
    const rows = await service.events(conversation.tenantId, conversation.id, position, 128);
    for (const row of rows) {
      if (signal.aborted || sse.closed) return;
      const candidate = {
        eventId: `evt_${row.sequence}`,
        conversationId: row.conversationId,
        sequence: row.sequence.toString(),
        type: row.type,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        payload: row.payload,
      };
      // Stored events must satisfy the wire contract; a corrupt row forces a snapshot
      // refetch instead of forwarding an untyped payload.
      if (!isAiEvent(candidate)) {
        resync();
        return;
      }
      position = candidate.sequence;
      if (filterEvent && !(await filterEvent(candidate))) continue;
      sse.frame(candidate, candidate.sequence);
    }
    for (const frame of extraFrames?.() ?? []) {
      if (signal.aborted || sse.closed) return;
      sse.frame(frame);
    }
    // Same-process commits wake this immediately; the interval only bounds cross-instance
    // polling and the idle heartbeat, so keep it quiet (proxies tolerate 5s easily).
    const woke = await bus.next(key, 5_000, signal);
    if (woke === "timeout" && rows.length === 0) sse.heartbeat();
  }
}
