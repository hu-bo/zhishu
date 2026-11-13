/* global AbortController, process */
import console from "node:console";
import { createWritingRuntime, deterministicNativeSessionId } from "@zhishu/ai-writing";
import { LlmAdapter } from "@zhishu/ai-writing/kernel";

/** Deterministic offline model so the example never needs credentials. */
class ExampleModel extends LlmAdapter {
  async *stream(options) {
    const lastUser = options.messages.filter((message) => message.role === "user").at(-1);
    const text = `你好，这是官方 Agent Loop 的独立消费示例。收到：${(lastUser?.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")}`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const runtime = await createWritingRuntime({
  persistence: "ephemeral",
  agentOptions: { provider: "example", model: "deterministic" },
  configure: (ctx) => {
    ctx.llm.registerAdapter(["example"], new ExampleModel());
  },
});

const conversationId = "independent-example";
try {
  const session = await runtime.attach({
    conversationId,
    contextRevision: 1,
    nativeSessionId: deterministicNativeSessionId(conversationId, 1),
    restore: false,
  });
  const host = {
    authorize: async () => undefined,
    reserveModelCall: async () => undefined,
    onDeliveryPlanned: async () => undefined,
    onDeliveryConfirmed: async () => undefined,
    onApprovalRequested: async () => undefined,
    onApprovalResolved: async () => undefined,
    emitPreview: (_turn, frame) => process.stdout.write(frame.text),
  };
  const result = await session.execute(
    {
      conversationId,
      runId: "run-example-1",
      attempt: 1,
      contextRevision: 1,
      inputText: "你好",
      nativeSessionId: deterministicNativeSessionId(conversationId, 1),
      deadlineAtMs: Date.now() + 30_000,
      context: { contextRevision: 1, webSearch: false },
    },
    host,
    new AbortController().signal,
  );
  console.log("\nstatus:", result.status);
  console.log(result.resultText ?? "(no text)");
} finally {
  await runtime.dispose();
}
