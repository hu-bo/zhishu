import test from "node:test";
import assert from "node:assert/strict";
import {
  isSubmitChatMessage,
  isChatFrame,
  applyChatEvent,
  applyChatSnapshot,
} from "../dist/index.js";
const snapshot = {
  protocolVersion: 1,
  conversation: { id: "writing", title: "title", createdAt: "2026-10-24T00:00:00Z" },
  messages: [],
  runs: [],
  approvals: [],
  cursor: "10",
};
test("bounded commands, explicit live frames and monotonic durable snapshots", () => {
  assert.ok(
    isSubmitChatMessage({ clientMessageId: "message", idempotencyKey: "key", text: "写作" }),
  );
  assert.ok(
    !isSubmitChatMessage({
      clientMessageId: "message",
      idempotencyKey: "key",
      text: "写作",
      systemPrompt: "injected",
    }),
  );
  assert.ok(
    !isChatFrame({
      type: "assistant.delta",
      conversationId: "writing",
      runId: "run",
      text: "missing attempt identity",
    }),
  );
  const event = {
    type: "snapshot",
    eventId: "event",
    conversationId: "writing",
    sequence: "11",
    snapshot: { ...snapshot, cursor: "11" },
  };
  assert.equal(applyChatEvent(snapshot, event).cursor, "11");
  assert.equal(applyChatEvent(event.snapshot, event), event.snapshot);
  assert.equal(applyChatSnapshot(event.snapshot, snapshot), event.snapshot);
  assert.equal(applyChatSnapshot(snapshot, { ...snapshot, cursor: "14" }).cursor, "14");
  assert.throws(
    () =>
      applyChatSnapshot(snapshot, {
        ...snapshot,
        conversation: { ...snapshot.conversation, title: "changed" },
      }),
    /CHANGED_DUPLICATE/,
  );
  assert.throws(() => applyChatEvent(snapshot, { ...event, sequence: "10" }), /INVALID_CURSOR/);
  assert.throws(
    () =>
      applyChatEvent(snapshot, {
        ...event,
        sequence: "12",
        snapshot: { ...snapshot, cursor: "12" },
      }),
    /EVENT_GAP/,
  );
  assert.throws(
    () => applyChatEvent(snapshot, { ...event, conversationId: "rag" }),
    /WRONG_CONVERSATION/,
  );
});
