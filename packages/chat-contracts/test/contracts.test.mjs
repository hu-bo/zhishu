import test from "node:test";
import assert from "node:assert/strict";
import { applyAiEvent, applyPreviewFrame, isSubmitMessage, isStreamFrame } from "../dist/index.js";

const snapshot = (cursor) => ({
  conversation: {
    id: "conv_1",
    purpose: "qa",
    title: "问答",
    scope: { kind: "all" },
    contextRevision: 1,
    status: "active",
    eventSequence: cursor,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  },
  messages: [],
  runs: [],
  artifacts: [],
  cursor,
});
const run = (status, attempt = 1) => ({
  id: "run_1",
  conversationId: "conv_1",
  purpose: "qa",
  status,
  attempt,
  contextRevision: 1,
  inputHash: `sha256:${"a".repeat(64)}`,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:01.000Z",
});
const envelope = (type, sequence, payload) => ({
  eventId: `evt_${sequence}`,
  conversationId: "conv_1",
  purpose: "qa",
  sequence,
  type,
  entityId: payload.run?.id ?? payload.message?.id ?? "art_1",
  createdAt: "2026-11-10T00:00:01.000Z",
  payload,
});

test("events advance the cursor only in order and never embed snapshots", () => {
  let state = snapshot("0");
  state = applyAiEvent(state, envelope("run.updated", "1", { run: run("queued") }));
  assert.equal(state.cursor, "1");
  // Gap and stale events are refused; caller resyncs.
  assert.equal(applyAiEvent(state, envelope("run.updated", "5", { run: run("running") })), null);
  assert.equal(applyAiEvent(state, envelope("run.updated", "1", { run: run("running") })), null);
  state = applyAiEvent(state, envelope("run.updated", "2", { run: run("running") }));
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].status, "running");
});

test("terminal runs never regress and purposes never cross", () => {
  let state = snapshot("0");
  state = applyAiEvent(state, envelope("run.updated", "1", { run: run("completed") }));
  const rolled = applyAiEvent(state, envelope("run.updated", "2", { run: run("running") }));
  assert.equal(rolled, null);
  const wrongPurpose = applyAiEvent(
    { ...state, conversation: { ...state.conversation, purpose: "writing" } },
    envelope("run.updated", "2", { run: run("running") }),
  );
  assert.equal(wrongPurpose, null);
});

test("message events keep committed bodies consistent and ordered", () => {
  let state = snapshot("0");
  const user = {
    id: "msg_1",
    conversationId: "conv_1",
    runId: "run_1",
    role: "user",
    parts: [{ kind: "text", text: "什么是知书？" }],
    clientMessageId: "cm_1",
    createdAt: "2026-11-10T00:00:00.000Z",
    committedAt: "2026-11-10T00:00:00.000Z",
  };
  state = applyAiEvent(state, envelope("message.created", "1", { message: user }));
  assert.equal(state.messages.length, 1);
  state = applyAiEvent(state, envelope("run.updated", "2", { run: run("completed") }));
  const assistant = {
    id: "msg_2",
    conversationId: "conv_1",
    runId: "run_1",
    role: "assistant",
    parts: [{ kind: "text", text: "回答。" }],
    createdAt: "2026-11-10T00:00:02.000Z",
    committedAt: "2026-11-10T00:00:02.000Z",
  };
  state = applyAiEvent(state, envelope("message.created", "3", { message: assistant }));
  assert.deepEqual(
    state.messages.map((m) => m.id),
    ["msg_1", "msg_2"],
  );
});

test("scope.changed updates the conversation context revision", () => {
  let state = snapshot("0");
  state = applyAiEvent(
    state,
    envelope("scope.changed", "1", {
      contextRevision: 2,
      scope: { kind: "workspaces", workspaceIds: ["ws_1"] },
    }),
  );
  assert.equal(state.conversation.contextRevision, 2);
  assert.equal(state.conversation.scope.kind, "workspaces");
});

test("submit schema discriminates purposes", () => {
  assert.equal(
    isSubmitMessage({
      purpose: "qa",
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "问题",
      expectedContextRevision: 1,
    }),
    true,
  );
  // A qa message may not smuggle writing fields.
  assert.equal(
    isSubmitMessage({
      purpose: "qa",
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "问题",
      expectedContextRevision: 1,
      webSearch: true,
    }),
    false,
  );
  assert.equal(
    isSubmitMessage({
      purpose: "writing",
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "帮我改写",
      expectedContextRevision: 1,
      intent: "rewrite",
    }),
    true,
  );
});

test("preview merge rejects stale, gaps and cross-attempt frames", () => {
  const frame = (index, text, attempt = 1, revision = 1) => ({
    type: "preview",
    conversationId: "conv_1",
    purpose: "qa",
    runId: "run_1",
    streamEpoch: "epoch_1",
    attempt,
    contextRevision: 1,
    revision,
    index,
    channel: "text",
    text,
  });
  let preview = applyPreviewFrame(undefined, frame(0, "你好"));
  assert.equal(preview.text, "你好");
  preview = applyPreviewFrame(preview, frame(1, "，知书"));
  assert.equal(preview.text, "你好，知书");
  // Duplicate index is idempotent.
  assert.equal(applyPreviewFrame(preview, frame(1, "重复")).text, "你好，知书");
  // A gap marks the preview incomplete until the durable message arrives.
  preview = applyPreviewFrame(preview, frame(4, "跳到后面"));
  assert.equal(preview.incomplete, true);
  assert.equal(preview.text, "");
  // New attempt restarts the stream.
  preview = applyPreviewFrame(preview, frame(0, "重试文本", 2));
  assert.equal(preview.text, "重试文本");
  assert.equal(preview.incomplete, false);
});

test("stream frame guard accepts events previews and resync", () => {
  assert.equal(isStreamFrame(envelope("run.updated", "1", { run: run("queued") })), true);
  assert.equal(
    isStreamFrame({ type: "resync-required", conversationId: "c", purpose: "qa" }),
    true,
  );
  assert.equal(isStreamFrame({ type: "unknown", conversationId: "c" }), false);
});
