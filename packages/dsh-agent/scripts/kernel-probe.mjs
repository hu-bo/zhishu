import console from "node:console";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Registry from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import Llm, { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Approval from "@deepseek-ai/dsh-user-approval";
const ctx = new Context();
class Model extends LlmAdapter {
  async *stream(options) {
    options.signal?.throwIfAborted();
    const text = `第${options.messages.filter((m) => m.role === "user").length}轮`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
try {
  for (const plugin of [Llm, Sessions, Projections]) await ctx.plugin(plugin);
  await ctx.plugin(Prompt, { includeHarnessIdentity: false });
  await ctx.plugin(Tools, { mode: "native" });
  await ctx.plugin(Registry);
  await ctx.plugin(Approval, {});
  ctx.llm.registerAdapter(["probe"], new Model());
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
  const handle = await ctx.agents.create({
    sessionId: SessionId("kernel-probe"),
    agentOptions: { provider: "probe", model: "deterministic" },
  });
  const events = [],
    frames = [];
  handle.agent.ctx.on("session/event", (s, e) => {
    if (s === handle.agent.session) events.push(e);
  });
  handle.agent.ctx.on("agent/assistant-stream", ({ frame }) => frames.push(frame));
  for (let i = 1; i <= 2; i++) {
    handle.agent.send(
      createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "继续" }] }),
      "next-turn",
      true,
    );
    await handle.agent.whenIdle();
    assert.equal(
      events.filter((e) => e.type === "turn/end" && e.data.reason.kind === "completed").length,
      i,
    );
  }
  assert.equal(frames.filter((f) => f.type === "start").length, 2);
  assert.equal(
    handle.agent.session.deriveMessages().filter((m) => m.role === "assistant").length,
    2,
  );
  await handle.dispose();
  assert.equal(ctx.agents.get(SessionId("kernel-probe")), undefined);
  console.log(
    "Official Agent Loop: two streaming turns, native turn completion and scoped disposal passed (deterministic adapter; no paid call).",
  );
} finally {
  await ctx.fiber.dispose();
}
