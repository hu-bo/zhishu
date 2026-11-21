import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAiEvent,
  applyPreviewFrame,
  isCreateDraft,
  isSubmitMessage,
  isStreamFrame,
} from "../dist/index.js";

const snapshot = (cursor) => ({
  conversation: {
    id: "conv_1",
    title: "助手对话",
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

test("terminal runs never regress and foreign conversations never cross", () => {
  let state = snapshot("0");
  state = applyAiEvent(state, envelope("run.updated", "1", { run: run("completed") }));
  const rolled = applyAiEvent(state, envelope("run.updated", "2", { run: run("running") }));
  assert.equal(rolled, null);
  const wrongConversation = applyAiEvent(
    { ...state, conversation: { ...state.conversation, id: "conv_other" } },
    envelope("run.updated", "2", { run: run("running") }),
  );
  assert.equal(wrongConversation, null);
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

test("conversation.updated binds the draft target without a second state machine", () => {
  let state = snapshot("0");
  state = applyAiEvent(
    state,
    envelope("conversation.updated", "1", {
      contextRevision: 2,
      status: "active",
      targetDocumentId: "doc_1",
    }),
  );
  assert.equal(state.conversation.targetDocumentId, "doc_1");
  assert.equal(state.conversation.contextRevision, 2);
  assert.equal(state.cursor, "1");
});

test("one submit schema carries intent hints instead of purpose forks", () => {
  assert.equal(
    isSubmitMessage({
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "问题",
      expectedContextRevision: 1,
    }),
    true,
  );
  assert.equal(
    isSubmitMessage({
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "帮我改写",
      expectedContextRevision: 1,
      intentHint: "writing",
      webSearch: true,
      plugins: ["rag", "writing"],
    }),
    true,
  );
  // Purpose forks and unknown plugins are refused at the contract boundary.
  assert.equal(
    isSubmitMessage({
      purpose: "qa",
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "问题",
      expectedContextRevision: 1,
    }),
    false,
  );
  assert.equal(
    isSubmitMessage({
      clientMessageId: "cm",
      idempotencyKey: "ik",
      text: "问题",
      expectedContextRevision: 1,
      plugins: ["legacy-authoring"],
    }),
    false,
  );
});

test("submit selection targets carry block ids instead of anchors", () => {
  const submit = (target) => ({
    clientMessageId: "cm",
    idempotencyKey: "ik",
    text: "改写所选段落",
    expectedContextRevision: 1,
    editorContext: { documentId: "doc_1", target },
  });
  assert.equal(
    isSubmitMessage(submit({ kind: "selection", blockIds: ["block_a", "block_b"] })),
    true,
  );
  // The retired anchor/selectedText shape must fail at the contract boundary.
  assert.equal(
    isSubmitMessage(
      submit({
        kind: "selection",
        anchor: {
          documentId: "doc_1",
          generationId: "gen_1",
          anchorVersion: 1,
          encoding: "yjs-relative-position-v1",
          startBlockId: "block_a",
          endBlockId: "block_a",
          start: "AAAA",
          end: "AAAA",
        },
        selectedText: "所选文本",
      }),
    ),
    false,
  );
  assert.equal(isSubmitMessage(submit({ kind: "selection" })), false);
  assert.equal(isSubmitMessage(submit({ kind: "selection", blockIds: [] })), false);
  const blockIds = (count) => Array.from({ length: count }, (_, index) => `block_${index}`);
  assert.equal(isSubmitMessage(submit({ kind: "selection", blockIds: blockIds(256) })), true);
  assert.equal(isSubmitMessage(submit({ kind: "selection", blockIds: blockIds(257) })), false);
});

test("create-draft is an explicit user command with its own idempotency identity", () => {
  assert.equal(
    isCreateDraft({
      idempotencyKey: "draft_1",
      instruction: "基于这些资料写一篇结构化草稿",
      workspaceId: "ws_personal",
      expectedContextRevision: 3,
      referenceArtifactIds: ["art_1"],
    }),
    true,
  );
  assert.equal(
    isCreateDraft({
      idempotencyKey: "draft_1",
      instruction: "写",
      expectedContextRevision: 3,
    }),
    false,
  );
});

test("preview merge rejects stale, gaps and cross-attempt frames", () => {
  const frame = (index, text, attempt = 1, revision = 1) => ({
    type: "preview",
    conversationId: "conv_1",
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

test("preview merge keeps thinking and tool channels independent", () => {
  const base = {
    type: "preview",
    conversationId: "conv_1",
    runId: "run_1",
    streamEpoch: "epoch_1",
    attempt: 1,
    contextRevision: 1,
    revision: 1,
  };
  const text = (index, value, attempt = 1) => ({
    ...base,
    index,
    attempt,
    channel: "text",
    text: value,
  });
  const thinking = (index, value) => ({ ...base, index, channel: "thinking", text: value });
  const tool = (id, status, name = "rewrite_paragraph") => ({
    ...base,
    index: 0,
    channel: "tool",
    tool: { id, name, status },
  });
  // A tool frame before any text seeds the state without disturbing text merge counters.
  let preview = applyPreviewFrame(undefined, tool("call_1", "running"));
  assert.deepEqual(
    preview.tools.map((t) => [t.id, t.status]),
    [["call_1", "running"]],
  );
  preview = applyPreviewFrame(preview, thinking(0, "先定位目标段落"));
  preview = applyPreviewFrame(preview, thinking(1, "，再改写"));
  assert.equal(preview.thinking, "先定位目标段落，再改写");
  preview = applyPreviewFrame(preview, text(0, "改写后的正文"));
  assert.equal(preview.text, "改写后的正文");
  assert.equal(preview.thinking, "先定位目标段落，再改写");
  // Tool status advances by id and never regresses; new tools append in order.
  preview = applyPreviewFrame(preview, tool("call_1", "completed"));
  preview = applyPreviewFrame(preview, tool("call_1", "running"));
  preview = applyPreviewFrame(preview, tool("call_2", "failed", "web_search"));
  assert.deepEqual(
    preview.tools.map((t) => [t.id, t.status]),
    [
      ["call_1", "completed"],
      ["call_2", "failed"],
    ],
  );
  // A gap on the thinking channel clears only thinking text.
  preview = applyPreviewFrame(preview, thinking(9, "跳到后面"));
  assert.equal(preview.thinking, "");
  assert.equal(preview.thinkingIncomplete, true);
  assert.equal(preview.text, "改写后的正文");
  // Another attempt resets every channel.
  preview = applyPreviewFrame(preview, text(0, "重试", 2));
  assert.equal(preview.thinking, "");
  assert.deepEqual(preview.tools, []);
  assert.equal(preview.text, "重试");
});

test("stream frame guard accepts events previews and resync", () => {
  assert.equal(isStreamFrame(envelope("run.updated", "1", { run: run("queued") })), true);
  assert.equal(isStreamFrame({ type: "resync-required", conversationId: "c" }), true);
  assert.equal(isStreamFrame({ type: "unknown", conversationId: "c" }), false);
});
