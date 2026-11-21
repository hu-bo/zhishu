/* global AbortController */
import assert from "node:assert/strict";
import test from "node:test";
import { LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import { createAssistantRuntime, INSUFFICIENT_EVIDENCE_TEXT } from "../dist/index.js";
import { createArgumentTextExtractor, withAssistantPreviewHost } from "../dist/preview.js";
import { createMemoryPersistencePlugin, createRecordingHost, turnRequest } from "./helpers.mjs";

const textOf = (m) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

const emptyBundle = { sources: [], items: [], freshness: "current" };
const bundle = {
  sources: [
    {
      sourceKind: "document",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      title: "知书规范",
      workspaceId: "ws_1",
      documentId: "doc_1",
      generationId: "gen_1",
      durableSeq: "12",
      metadataRevision: "1",
      indexVersion: "iv_1",
    },
  ],
  items: [
    {
      evidenceId: "ev_1",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      locator: { kind: "block", blockId: "block_a", start: 0, end: 7 },
      text: "第一段原文内容",
    },
  ],
  freshness: "current",
};

/** Scripted model: echoes text, or calls draft_document when the user asks for a draft. */
class Model extends LlmAdapter {
  calls = [];
  async *stream(options) {
    this.calls.push(options);
    const text = options.messages
      .filter((m) => m.role === "user" && m.source?.kind === "user")
      .map(textOf)
      .at(-1);
    if (text === "answerstream" && !options.messages.some((m) => m.role === "tool")) {
      // The final answer lives in streamed tool arguments: exactly the case previews must type out.
      const args = JSON.stringify({
        status: "answered",
        text: "结论：知书把检索与写作合并到同一条预览流。",
        citations: [{ evidenceId: "ev_1", quote: "第一段原文内容" }],
      });
      const id = ToolCallId("answer-1");
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      for (let i = 0, first = true; i < args.length; i += 9) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id,
          ...(first ? { name: "answer_with_citations" } : {}),
          argumentsDelta: args.slice(i, i + 9),
        };
        first = false;
      }
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id, name: "answer_with_citations", arguments: args },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (text.includes("起草") && !options.messages.some((m) => m.role === "tool")) {
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: ToolCallId("draft-1"),
          name: "draft_document",
          arguments: JSON.stringify({
            blocks: [{ type: "paragraph", text: "草稿正文" }],
            summary: "草稿已生成",
            citations: [],
          }),
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: `回答:${text}` };
    yield { type: "block-end", index: 0, block: { type: "text", text: `回答:${text}` } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const context = (overrides = {}) => ({
  contextRevision: 1,
  command: "chat",
  intentHint: "qa",
  plugins: ["scope", "rag", "writing"],
  scope: { kind: "all" },
  webSearch: false,
  ...overrides,
});

function portsFixture({ evidence = bundle } = {}) {
  const registered = [];
  const answers = [];
  const drafts = [];
  const proposals = [];
  let current = evidence;
  const ports = {
    scope: { current: () => ({ kind: "all" }), update: async () => ({ contextRevision: 2 }) },
    platform: {
      search: async () => current.sources,
      read: async () => current.items,
      register: async (items) => registered.push(items),
      reserve: async () => undefined,
    },
    answer: {
      evidence: () => current,
      artifactOf: () => "art_ev_1",
      verify: async () => undefined,
      save: async (answer) => answers.push(answer),
    },
    writing: {
      buildInput: () => undefined,
      buildDraftInput: () => ({
        threadId: "conv_test",
        runId: "run_test",
        prompt: { id: "writing", version: "1", systemInstruction: "" },
      }),
      verify: async () => undefined,
      save: async (proposal) => proposals.push(proposal),
      saveDraft: async (draft) => drafts.push(draft),
      schemaVersion: 6,
      systemInstruction: "",
    },
    retrieve: async () => current,
    registerEvidence: async (b) => registered.push(b.items),
  };
  return { ports, registered, answers, drafts, proposals, setEvidence: (b) => (current = b) };
}

async function fixture({ ports, memory, model, plugins = ["scope", "rag", "writing"] } = {}) {
  const f = portsFixture();
  const usedPorts = ports ?? f.ports;
  const usedMemory = memory ?? createMemoryPersistencePlugin();
  const usedModel = model ?? new Model();
  const runtime = await createAssistantRuntime({
    persistence: "required",
    agentOptions: { provider: "test", model: "test" },
    ports: usedPorts,
    configure: async (ctx) => {
      await ctx.plugin(usedMemory.MemoryPersistence);
      ctx.llm.registerAdapter(["test"], usedModel);
    },
  });
  const attach = (overrides = {}) =>
    runtime.attach({
      conversationId: "conv_a",
      contextRevision: 1,
      nativeSessionId: "native_a",
      restore: false,
      plugins,
      ...overrides,
    });
  return { runtime, attach, memory: usedMemory, model: usedModel, ...f, ports: usedPorts };
}

const request = (overrides = {}) =>
  turnRequest({ nativeSessionId: "native_a", context: context(), ...overrides });

test("one conversation flows question -> draft -> question on a single native session", async () => {
  const f = await fixture();
  try {
    const session = await f.attach();
    // 1. Grounded question: deterministic pre-retrieval registers evidence, then one model turn.
    const question = await session.execute(
      request({ inputText: "什么是知书？" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(question.status, "completed");
    assert.equal(f.registered.length, 1);
    assert.equal(f.model.calls.length, 1);
    // 2. User-accepted create-draft in the SAME session: the draft tool compiles an artifact.
    const draft = await session.execute(
      request({
        runId: "run_draft",
        inputText: "请起草一篇介绍",
        context: context({
          command: "create-draft",
          intentHint: "writing",
          draft: { workspaceId: "ws_1" },
        }),
      }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(draft.status, "completed");
    assert.equal(draft.resultText, "草稿已生成");
    assert.equal(f.drafts.length, 1);
    assert.equal(f.drafts[0].content.content[0].type, "paragraph");
    // 3. Continue asking questions without switching sessions or transports.
    const again = await session.execute(
      request({ runId: "run_q2", inputText: "继续追问" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(again.status, "completed");
    assert.equal(f.model.calls.length, 3);
  } finally {
    await f.runtime.dispose();
  }
});

test("empty authorized scope answers without a model call and keeps native context", async () => {
  const f = await fixture();
  f.setEvidence(emptyBundle);
  try {
    const session = await f.attach();
    const result = await session.execute(
      request({ inputText: "空范围提问" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.resultText, INSUFFICIENT_EVIDENCE_TEXT);
    assert.equal(f.model.calls.length, 0);
    assert.equal(f.registered.length, 0);
    // The recorded exchange stays visible to the next real turn.
    f.setEvidence(bundle);
    const next = await session.execute(
      request({ runId: "run_2", inputText: "补充资料后再问" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(next.status, "completed");
    assert.equal(f.model.calls.length, 1);
    const seen = f.model.calls[0].messages.map(textOf).join("\n");
    assert.ok(seen.includes("空范围提问"));
    assert.ok(seen.includes(INSUFFICIENT_EVIDENCE_TEXT));
  } finally {
    await f.runtime.dispose();
  }
});

test("retrievalDone retries skip pre-retrieval and reuse the Run ledger", async () => {
  const f = await fixture();
  try {
    const session = await f.attach();
    const result = await session.execute(
      request({ inputText: "重试的问题", retrievalDone: true }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
    assert.equal(f.registered.length, 0);
    assert.equal(f.model.calls.length, 1);
  } finally {
    await f.runtime.dispose();
  }
});

test("plugin composition changes visible tools, not just prompts", async () => {
  const f = await fixture({ plugins: ["scope"] });
  try {
    const session = await f.attach();
    // The model attempts a draft tool that this session never registered.
    const result = await session.execute(
      request({
        inputText: "请起草一篇介绍",
        context: context({ command: "create-draft", intentHint: "writing", plugins: ["scope"] }),
      }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(f.drafts.length, 0);
    assert.ok(result.status === "completed" || result.status === "failed");
  } finally {
    await f.runtime.dispose();
  }
});

test("restart settles the durable turn without new model calls", async () => {
  const memory = createMemoryPersistencePlugin();
  const model = new Model();
  const f = await fixture({ memory, model });
  const session = await f.attach();
  const executed = await session.execute(
    request({ inputText: "first" }),
    createRecordingHost().host,
    new AbortController().signal,
  );
  assert.equal(executed.status, "completed");
  const calls = model.calls.length;
  await f.runtime.dispose();
  const restored = await fixture({ memory, model });
  try {
    const settledSession = await restored.attach({ restore: true });
    const settled = await settledSession.settle(
      request({
        inputText: "first",
        plannedNativeMessageId: executed.nativeMessageId,
        deliveryConfirmed: true,
      }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(settled.status, "completed");
    assert.equal(model.calls.length, calls);
  } finally {
    await restored.runtime.dispose();
  }
});

test("allowed product history initializes a fresh native context as data", async () => {
  const f = await fixture();
  try {
    const session = await f.attach();
    const result = await session.execute(
      request({
        inputText: "继续",
        history: [
          { role: "user", content: "此前的问题" },
          { role: "assistant", content: "此前的回答" },
        ],
      }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
    const seen = f.model.calls[0].messages.map(textOf).join("\n");
    assert.ok(seen.includes("此前的问题"));
    assert.ok(seen.includes("此前的回答"));
    assert.ok(seen.includes("本轮输入：继续"));
  } finally {
    await f.runtime.dispose();
  }
});

test("entry safety policy is injected by the runtime, not the kernel adapter", async () => {
  const f = await fixture();
  try {
    const session = await f.attach();
    await session.execute(
      request({ inputText: "你好" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    const system = f.model.calls[0].messages.find((m) => m.role === "system");
    const systemText = textOf(system);
    // Product safety guidance is entry policy owned by ai-runtime; dsh-agent stays agnostic.
    assert.ok(systemText.includes("知书中文助手"), "runtime applies the product safety preamble");
    assert.ok(systemText.includes("不可信资料"), "runtime marks tool/material data untrusted");
  } finally {
    await f.runtime.dispose();
  }
});

test("argument text extractor follows configured value paths across chunk boundaries", () => {
  const extractor = createArgumentTextExtractor([["blocks", "*", "text"]]);
  const args = JSON.stringify({
    blocks: [
      { type: "paragraph", text: "第一行\n第二段" },
      { type: "heading", text: "标题" },
    ],
    summary: "不应出现",
    citations: [{ evidenceId: "ev_1", quote: "也不应出现" }],
  });
  let out = "";
  for (let i = 0; i < args.length; i += 3) out += extractor.push(args.slice(i, i + 3));
  assert.equal(out, "第一行\n第二段标题");

  // Escapes may split across chunks, including a \uXXXX tail.
  const unicode = createArgumentTextExtractor([["text"]]);
  assert.equal(unicode.push('{"text":"caf'), "caf");
  assert.equal(unicode.push("\\u00"), "");
  assert.equal(unicode.push("e9!"), "é!");
  assert.equal(unicode.push('"'), "");
});

test("preview host merges text deltas and streamed tool arguments into one dense stream", () => {
  const seen = [];
  const wrapped = withAssistantPreviewHost({
    emitPreview: (_turn, frame) => seen.push(frame),
  });
  const turn = { conversationId: "c", runId: "r", attempt: 1, contextRevision: 1 };
  const frame = (overrides) => ({ streamEpoch: "e1", revision: 1, ...overrides });
  wrapped.emitPreview(turn, frame({ channel: "text", index: 0, text: "先看资料，" }));
  wrapped.emitPreview(turn, frame({ channel: "thinking", index: 0, text: "思考中" }));
  wrapped.emitPreview(
    turn,
    frame({
      channel: "tool-args",
      index: 0,
      text: '{"text":"结论：',
      tool: { id: "c1", name: "answer_with_citations", status: "running" },
    }),
  );
  wrapped.emitPreview(
    turn,
    frame({
      channel: "tool-args",
      index: 1,
      text: '统一"}',
      tool: { id: "c1", name: "", status: "running" },
    }),
  );
  wrapped.emitPreview(
    turn,
    frame({
      channel: "tool",
      index: 0,
      text: "",
      tool: { id: "c1", name: "answer_with_citations", status: "completed" },
    }),
  );
  // Raw arguments never leave this layer; visible text forms one dense sequence.
  assert.deepEqual(
    seen.map((f) => [f.channel, f.index]),
    [
      ["text", 0],
      ["thinking", 0],
      ["text", 1],
      ["text", 2],
      ["tool", 0],
    ],
  );
  assert.equal(
    seen
      .filter((f) => f.channel === "text")
      .map((f) => f.text)
      .join(""),
    "先看资料，结论：统一",
  );
  // A new attempt revision restarts the dense numbering.
  wrapped.emitPreview(turn, frame({ channel: "text", index: 0, revision: 2, text: "新一轮" }));
  assert.deepEqual(seen.at(-1), {
    streamEpoch: "e1",
    revision: 2,
    channel: "text",
    index: 0,
    text: "新一轮",
  });
});

test("streamed answer arguments type out as text previews before the durable result", async () => {
  const f = await fixture();
  try {
    const session = await f.attach();
    const recorder = createRecordingHost();
    const result = await session.execute(
      request({ inputText: "answerstream" }),
      recorder.host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
    assert.equal(f.answers.length, 1);
    const previews = recorder.calls.previews;
    assert.ok(!previews.some((p) => p.channel === "tool-args"), "raw args stay internal");
    const typed = previews
      .filter((p) => p.channel === "text")
      .map((p, i) => {
        assert.equal(p.index, i);
        return p.text;
      })
      .join("");
    assert.equal(typed, "结论：知书把检索与写作合并到同一条预览流。");
    assert.deepEqual(
      previews.filter((p) => p.channel === "tool").map((p) => p.tool.status),
      ["running", "completed"],
    );
  } finally {
    await f.runtime.dispose();
  }
});
