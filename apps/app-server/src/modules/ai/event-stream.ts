import type { FastifyReply } from "fastify";
import type { AiService } from "./ai.service.js";
import type { ConversationRow } from "./ai.types.js";
import type { AiEvent } from "@zhishu/chat-contracts";

/**
 * Shared conversation transport used by qa, writing and public entry points. Same event
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
}

export function startSse(reply: FastifyReply): SseHandle {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  return {
    frame(value, id) {
      if (closed) return;
      const data = JSON.stringify(value);
      reply.raw.write(id !== undefined ? `id: ${id}\ndata: ${data}\n\n` : `data: ${data}\n\n`);
    },
    heartbeat() {
      if (closed) return;
      reply.raw.write(": heartbeat\n\n");
    },
    close() {
      if (closed) return;
      closed = true;
      reply.raw.end();
    },
  };
}

/**
 * Streams durable product events from the outbox cursor, wakes on same-process commits and
 * falls back to bounded polling for cross-instance delivery. Preview frames are injected by
 * the caller between event batches; gaps require the client to refetch a snapshot.
 */
export async function streamConversation(
  service: AiService,
  bus: LiveFeed,
  conversation: ConversationRow,
  cursor: string,
  sse: SseHandle,
  signal: AbortSignal,
  extraFrames?: () => unknown[],
): Promise<void> {
  let position = cursor;
  const key = conversationKey(conversation);
  while (!signal.aborted) {
    const rows = await service.events(conversation.tenantId, conversation.id, position, 128);
    for (const row of rows) {
      if (signal.aborted) return;
      const event: AiEvent = {
        eventId: `evt_${row.sequence}`,
        conversationId: row.conversationId,
        purpose: conversation.purpose,
        sequence: row.sequence.toString(),
        type: row.type,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        payload: row.payload as never,
      };
      sse.frame(event, event.sequence);
      position = event.sequence;
    }
    for (const frame of extraFrames?.() ?? []) {
      if (signal.aborted) return;
      sse.frame(frame);
    }
    const woke = await bus.next(key, 1_000, signal);
    if (woke === "timeout" && rows.length === 0) sse.heartbeat();
  }
}
