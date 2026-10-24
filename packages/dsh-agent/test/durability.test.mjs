import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { createDshRuntime } from "../dist/index.js";
import { createMemoryHost } from "../../../examples/dsh-consumer/host.mjs";
class Model extends LlmAdapter {
  async *stream() {
    yield { type: "block-end", index: 0, block: { type: "text", text: "confirmed" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
test("HTTP snapshots and outbox events share one durable cursor barrier during native input claim", async () => {
  const host = createMemoryHost();
  let session, captured;
  const runtime = await createDshRuntime({
    store: host.store,
    persistence: "required",
    agentOptions: { provider: "test", model: "test" },
    configure: async (ctx) => {
      await ctx.plugin(host.MemoryPersistence);
      ctx.llm.registerAdapter(["test"], new Model());
    },
    setup: (ctx) => {
      ctx.on("agent/inbox/claimed", () => {
        captured = session.snapshot();
      });
    },
  });
  try {
    session = await runtime.createSession("barrier");
    await session.submit({ clientMessageId: "m", idempotencyKey: "k", text: "hello" });
    for (let i = 0; i < 100 && !captured; i++) await setTimeout(10);
    assert.ok(captured);
    const snapshot = await captured;
    const committed = host.events.find(
      (event) => event.sequence === snapshot.cursor && event.conversationId === "barrier",
    );
    assert.deepEqual(snapshot, committed.snapshot);
  } finally {
    await runtime.dispose();
  }
});
test("configuration changes refuse execution on old native history and invalid limits fail before allocation", async () => {
  const host = createMemoryHost();
  const options = {
    store: host.store,
    persistence: "required",
    configurationId: "version-1",
    agentOptions: { provider: "test", model: "test" },
    configure: async (ctx) => {
      await ctx.plugin(host.MemoryPersistence);
      ctx.llm.registerAdapter(["test"], new Model());
    },
  };
  let runtime = await createDshRuntime(options);
  await runtime.createSession("versioned");
  await runtime.dispose();
  runtime = await createDshRuntime({ ...options, configurationId: "version-2" });
  try {
    await assert.rejects(runtime.restoreSession("versioned"), /CONFIGURATION_CHANGED/);
  } finally {
    await runtime.dispose();
  }
  await assert.rejects(
    createDshRuntime({ ...options, limits: { maxSessions: 0 } }),
    /INVALID_LIMITS/,
  );
});
