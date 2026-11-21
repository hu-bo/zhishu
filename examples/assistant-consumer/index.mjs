/* global AbortController, process */
import console from "node:console";
import { createAssistantRuntime } from "@zhishu/ai-runtime";
import { deterministicNativeSessionId } from "@zhishu/dsh-agent";
import { LlmAdapter } from "@zhishu/dsh-agent/kernel";

/**
 * Independent offline consumption of the unified assistant: one DSH execution composed with
 * the rag and writing plugins. No credentials, database or application code are required.
 */

const evidence = {
  freshness: "current",
  sources: [
    {
      sourceKind: "document",
      sourceId: "doc_example",
      snapshotId: "snap_example",
      title: "知书示例",
      workspaceId: "ws_example",
      documentId: "doc_example",
      generationId: "gen_example",
      durableSeq: "1",
      metadataRevision: "1",
      indexVersion: "iv_example",
    },
  ],
  items: [
    {
      evidenceId: "ev_example",
      sourceId: "doc_example",
      snapshotId: "snap_example",
      locator: { kind: "block", blockId: "block_example", start: 0, end: 24 },
      text: "知书是官方 Agent Loop 的独立消费示例",
    },
  ],
};

/** Deterministic offline model: answers with citations, or drafts when asked. */
class ExampleModel extends LlmAdapter {
  async *stream(options) {
    const messages = options.messages;
    const isRuntimeContext = (m) =>
      m.role === "user" &&
      (m.content ?? []).some(
        (block) => block.type === "text" && block.text.startsWith("Current runtime context"),
      );
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !isRuntimeContext(messages[i])) {
        lastUserIndex = i;
        break;
      }
    }
    // Only tool results after the latest user message belong to the current turn.
    const toolThisTurn = messages.slice(lastUserIndex + 1).some((m) => m.role === "tool");
    const text = (messages[lastUserIndex]?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (!toolThisTurn) {
      const draft = text.includes("起草");
      const block = {
        type: "tool-call",
        id: "call-example-1",
        name: draft ? "draft_document" : "answer_with_citations",
        arguments: JSON.stringify(
          draft
            ? {
                blocks: [{ type: "paragraph", text: "知书独立消费示例草稿。" }],
                summary: "示例草稿",
                citations: [{ evidenceId: "ev_example", quote: "独立消费示例" }],
              }
            : {
                status: "answered",
                text: "这是官方 Agent Loop 的独立消费示例。",
                citations: [{ evidenceId: "ev_example", quote: "独立消费示例" }],
              },
        ),
      };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const out = "已完成。";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: out };
    yield { type: "block-end", index: 0, block: { type: "text", text: out } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const saved = { answers: [], drafts: [] };
const ports = {
  scope: { current: () => ({ kind: "all" }), update: async () => ({ contextRevision: 2 }) },
  platform: {
    search: async () => evidence.sources,
    read: async () => evidence.items,
    register: async () => undefined,
    reserve: async () => undefined,
  },
  answer: {
    evidence: () => evidence,
    artifactOf: () => "art_example",
    verify: async () => undefined,
    save: async (answer) => saved.answers.push(answer),
  },
  writing: {
    buildInput: () => undefined,
    buildDraftInput: () => ({
      threadId: "independent-example",
      runId: "run-example",
      prompt: { id: "writing", version: "1", systemInstruction: "" },
    }),
    verify: async () => undefined,
    save: async () => undefined,
    saveDraft: async (draft) => saved.drafts.push(draft),
    schemaVersion: 7,
    systemInstruction: "",
  },
  retrieve: async () => evidence,
  registerEvidence: async () => undefined,
};

const runtime = await createAssistantRuntime({
  persistence: "ephemeral",
  agentOptions: { provider: "example", model: "deterministic" },
  ports,
  configure: (ctx) => {
    ctx.llm.registerAdapter(["example"], new ExampleModel());
  },
});

const conversationId = "independent-example";
const host = {
  authorize: async () => undefined,
  reserveModelCall: async () => undefined,
  onDeliveryPlanned: async () => undefined,
  onDeliveryConfirmed: async () => undefined,
  onApprovalRequested: async () => undefined,
  onApprovalResolved: async () => undefined,
  emitPreview: (_turn, frame) => {
    // The assistant runtime already merged typed answer text (including streamed tool
    // arguments) into the text channel; thinking and tool rows are process facts only.
    if (frame.channel === "text") process.stdout.write(frame.text);
  },
};
const context = (overrides) => ({
  contextRevision: 1,
  command: "chat",
  intentHint: "qa",
  plugins: ["rag", "writing"],
  scope: { kind: "all" },
  webSearch: false,
  ...overrides,
});

try {
  const session = await runtime.attach({
    conversationId,
    contextRevision: 1,
    nativeSessionId: deterministicNativeSessionId(conversationId, 1),
    restore: false,
    plugins: ["rag", "writing"],
  });
  const question = await session.execute(
    {
      conversationId,
      runId: "run-example-1",
      attempt: 1,
      contextRevision: 1,
      inputText: "知书是什么？",
      nativeSessionId: deterministicNativeSessionId(conversationId, 1),
      deadlineAtMs: Date.now() + 30_000,
      context: context({}),
    },
    host,
    new AbortController().signal,
  );
  console.log("\nquestion status:", question.status);
  console.log(question.resultText ?? "(no text)");
  const draft = await session.execute(
    {
      conversationId,
      runId: "run-example-2",
      attempt: 1,
      contextRevision: 1,
      inputText: "请起草一段介绍",
      nativeSessionId: deterministicNativeSessionId(conversationId, 1),
      deadlineAtMs: Date.now() + 30_000,
      context: context({
        command: "create-draft",
        intentHint: "writing",
        draft: { workspaceId: "ws_example" },
      }),
    },
    host,
    new AbortController().signal,
  );
  console.log("draft status:", draft.status);
  console.log("answers:", saved.answers.length, "drafts:", saved.drafts.length);
  if (question.status !== "completed" || draft.status !== "completed")
    throw new Error("unified assistant example failed");
  if (!saved.answers.length || !saved.drafts.length)
    throw new Error("plugins did not produce artifacts");
} finally {
  await runtime.dispose();
}
