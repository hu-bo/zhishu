import console from "node:console";
import { setTimeout } from "node:timers";
import { createDshRuntime } from "@zhishu/dsh-agent";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { createMemoryHost } from "./host.mjs";
class ExampleModel extends LlmAdapter {
  async *stream() {
    const text = "你好，这是官方 Agent Loop 的独立消费示例。";
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
const host = createMemoryHost();
const runtime = await createDshRuntime({
  store: host.store,
  persistence: "ephemeral",
  agentOptions: { provider: "example", model: "deterministic" },
  configure: async (ctx) => {
    await ctx.plugin(host.MemoryPersistence);
    ctx.llm.registerAdapter(["example"], new ExampleModel());
  },
});
try {
  const session = await runtime.createSession("independent-example");
  const run = await session.submit({
    clientMessageId: "message-1",
    idempotencyKey: "send-1",
    text: "你好",
  });
  let snapshot;
  do {
    await new Promise((r) => setTimeout(r, 10));
    snapshot = await session.snapshot();
  } while (
    snapshot.runs.find((r) => r.id === run.id)?.status === "running" ||
    snapshot.runs.find((r) => r.id === run.id)?.status === "queued"
  );
  console.log(snapshot.messages.at(-1).text);
} finally {
  await runtime.dispose();
}
