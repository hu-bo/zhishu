/* global AbortController */
import { setTimeout, clearTimeout } from "node:timers";
import assert from "node:assert/strict";
import test from "node:test";
import { LlmAdapter, LlmError, ToolCallId } from "@deepseek-ai/dsh-llm";
import { createDshRuntime } from "../dist/index.js";
import { createMemoryHost } from "../../../examples/dsh-consumer/host.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (m) =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
class Model extends LlmAdapter {
  calls = [];
  async *stream(options) {
    this.calls.push(options);
    const text = options.messages
      .filter((m) => m.role === "user" && m.source?.kind === "user")
      .map(textOf)
      .at(-1);
    if (text === "hold")
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("ABORT"));
          },
          { once: true },
        );
      });
    if (text === "approve" && !options.messages.some((m) => m.role === "tool")) {
      const block = {
        type: "tool-call",
        id: ToolCallId("action-1"),
        name: "action",
        arguments: "{}",
      };
      yield { type: "block-end", index: 0, block };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "回答:" };
    yield { type: "reasoning-delta", index: 1, text: "PRIVATE_REASONING" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text: `回答:${text}` } };
    yield { type: "finish", reason: { kind: text === "max" ? "max-tokens" : "stop" } };
  }
}
async function fixture(extra = {}) {
  const host = extra.host ?? createMemoryHost(),
    model = extra.model ?? new Model();
  let actions = 0;
  const runtime = await createDshRuntime({
    store: host.store,
    persistence: "required",
    agentOptions: { provider: "test", model: "test" },
    configure: async (ctx) => {
      await ctx.plugin(host.MemoryPersistence);
      ctx.llm.registerAdapter(["test"], model);
    },
    setup: (ctx, agent, id) => {
      ctx.systemPrompt.section({ name: "private-persona", order: 1, text: `PRIVATE_PROMPT:${id}` });
      ctx.tools.register({
        name: "action",
        description: "Test permission seam",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          render: () => [{ type: "text", text: "done" }],
        },
        execute: async () => {
          actions++;
          return { ok: true };
        },
      });
      ctx.on("tools/pre-execute", async (exec, next) =>
        exec.name === "action" ? { kind: "ask" } : next(),
      );
      extra.setup?.(ctx, agent, id);
    },
    ...extra.options,
  });
  return { runtime, host, model, actions: () => actions };
}
async function state(session, status) {
  for (let i = 0; i < 300; i++) {
    const s = await session.snapshot();
    if (s.runs.at(-1)?.status === status) return s;
    await delay(10);
  }
  throw new Error(`Did not reach ${status}`);
}
const input = (text, id = text) => ({
  clientMessageId: `message-${id}`,
  idempotencyKey: `key-${id}`,
  text,
});
test("official kernel: streaming turns, idempotency, isolated prompts and scoped cancellation", async () => {
  const f = await fixture();
  try {
    const a = await f.runtime.createSession("user-a"),
      b = await f.runtime.createSession("user-b");
    const stop = new AbortController(),
      frames = [];
    const observing = (async () => {
      for await (const frame of a.observe(stop.signal)) frames.push(frame);
    })();
    const first = await a.submit(input("你好"));
    assert.equal((await a.submit(input("你好"))).id, first.id);
    await assert.rejects(a.submit({ ...input("你好"), text: "different" }), /IDEMPOTENCY_CONFLICT/);
    await state(a, "completed");
    await a.submit(input("继续"));
    await state(a, "completed");
    assert.equal((await a.snapshot()).messages.length, 4);
    assert.ok(frames.some((f) => f.type === "assistant.delta"));
    for (const run of (await a.snapshot()).runs) {
      const deltas = frames.filter(
        (frame) => frame.type === "assistant.delta" && frame.runId === run.id,
      );
      assert.deepEqual(
        deltas.map((frame) => frame.index),
        [0, 1],
      );
    }
    assert.ok(!JSON.stringify(frames).includes("PRIVATE_REASONING"));
    assert.ok(!JSON.stringify(frames).includes("PRIVATE_PROMPT"));
    stop.abort();
    await observing;
    const held = await a.submit(input("hold"));
    await state(a, "running");
    await b.submit(input("独立用户"));
    await state(b, "completed");
    await a.cancel(held.id);
    assert.equal(
      f.host.records.get("user-a").snapshot.runs.find((run) => run.id === held.id).cancelRequested,
      true,
    );
    await state(a, "cancelled");
    assert.ok(
      f.model.calls
        .filter((c) => c.sessionId === "user-a")
        .every((c) => !JSON.stringify(c.messages).includes("PRIVATE_PROMPT:user-b")),
    );
    await b.submit(input("继续"));
    await state(b, "completed");
  } finally {
    await f.runtime.dispose();
  }
});
test("subscription loss does not cancel; max-tokens cannot report completion", async () => {
  const f = await fixture();
  try {
    const s = await f.runtime.createSession("disconnect");
    const stop = new AbortController();
    const observing = (async () => {
      for await (const frame of s.observe(stop.signal)) {
        void frame;
      }
    })();
    await s.submit(input("hold"));
    stop.abort();
    await observing;
    await state(s, "completed");
    await s.submit(input("max"));
    await state(s, "failed");
  } finally {
    await f.runtime.dispose();
  }
});
test("approval is durable, one shot, rejecting a changed repeated decision", async () => {
  const f = await fixture();
  try {
    const s = await f.runtime.createSession("approvals");
    await s.submit(input("approve"));
    const snapshot = await state(s, "waiting-approval"),
      a = snapshot.approvals[0];
    assert.equal(f.actions(), 0);
    const decision = { approvalId: a.id, decisionId: "decision-1", decision: "allow-once" };
    await s.decide(decision);
    await s.decide(decision);
    await assert.rejects(s.decide({ ...decision, decision: "reject" }), /DECISION_CONFLICT/);
    await state(s, "completed");
    assert.equal(f.actions(), 1);
  } finally {
    await f.runtime.dispose();
  }
});
test("native flush and product commit failures never publish completed", async () => {
  for (const kind of ["flush", "commit"]) {
    const f = await fixture();
    let s;
    try {
      s = await f.runtime.createSession(`fault-${kind}`);
      const frames = [],
        stop = new AbortController();
      const observing = (async () => {
        for await (const frame of s.observe(stop.signal)) frames.push(frame);
      })();
      const run = await s.submit(input("hold"));
      await state(s, "running");
      f.host.faults[kind] = true;
      await delay(1200);
      await assert.rejects(s.snapshot(), /SESSION_UNAVAILABLE/);
      assert.ok(
        !frames.some(
          (f) =>
            f.type === "snapshot" &&
            f.snapshot.runs.some((r) => r.id === run.id && r.status === "completed"),
        ),
      );
      stop.abort();
      await observing;
    } finally {
      f.host.faults[kind] = false;
      await f.runtime.dispose();
    }
  }
});
test("restart restores official history and reconciles a durable native turn without redelivery", async () => {
  const host = createMemoryHost(),
    model = new Model();
  let f = await fixture({ host, model });
  let s = await f.runtime.createSession("restart");
  await s.submit(input("first"));
  await state(s, "completed");
  const calls = model.calls.length;
  await f.runtime.dispose();
  const stored = host.records.get("restart");
  stored.snapshot.runs[0].status = "running";
  stored.snapshot.messages = stored.snapshot.messages.filter((m) => m.role === "user");
  f = await fixture({ host, model });
  try {
    s = await f.runtime.restoreSession("restart");
    const snapshot = await s.snapshot();
    assert.equal(snapshot.runs[0].status, "completed");
    assert.equal(model.calls.length, calls);
    await s.submit(input("second"));
    await state(s, "completed");
    assert.equal((await s.snapshot()).messages.length, 4);
  } finally {
    await f.runtime.dispose();
  }
});

test("blocked input and pre-request errors are native terminal failures, including after restart", async () => {
  for (const kind of ["blocked", "request-error", "provider-error"]) {
    const host = createMemoryHost();
    const setup = (ctx) => {
      if (kind === "blocked") ctx.on("agent/pre-step", async () => ({ kind: "reject" }));
      else
        ctx.on("agent/request", async () => {
          if (kind === "provider-error")
            throw new LlmError("Unsupported provider reasoning", "UNSUPPORTED_REASONING_EFFORT");
          throw new Error("TEST_PROVIDER_NOT_READY");
        });
    };
    let f = await fixture({ host, setup });
    let s = await f.runtime.createSession(kind);
    await s.submit(input(kind));
    const before = await state(s, "failed");
    assert.equal(
      before.runs[0].errorCode,
      kind === "blocked"
        ? "BLOCKED"
        : kind === "provider-error"
          ? "UNSUPPORTED_REASONING_EFFORT"
          : "ERROR",
    );
    assert.equal(f.model.calls.length, 0);
    await f.runtime.dispose();
    // Simulate native terminal settlement followed by a failed product transaction.
    host.records.get(kind).snapshot.runs[0].status = "running";
    f = await fixture({ host });
    try {
      s = await f.runtime.restoreSession(kind);
      assert.equal((await s.snapshot()).runs[0].status, "failed");
      await assert.rejects(s.resume(before.runs[0].id), /NOT_RESUMABLE/);
      assert.equal(f.model.calls.length, 0);
    } finally {
      await f.runtime.dispose();
    }
  }
});

test("durable cancellation survives a crash before native cancellation; closed handles reject commands", async () => {
  const host = createMemoryHost();
  let f = await fixture({ host });
  let s = await f.runtime.createSession("cancel-restart");
  await s.submit(input("first"));
  const completed = await state(s, "completed");
  await f.runtime.dispose();
  const stored = host.records.get("cancel-restart");
  stored.snapshot.runs[0].status = "running";
  stored.snapshot.runs[0].cancelRequested = true;
  stored.snapshot.messages = stored.snapshot.messages.filter((m) => m.role === "user");
  f = await fixture({ host });
  try {
    s = await f.runtime.restoreSession("cancel-restart");
    assert.equal((await s.snapshot()).runs[0].status, "cancelled");
    assert.equal(f.model.calls.length, 0);
    await assert.rejects(s.resume(completed.runs[0].id), /NOT_RESUMABLE/);
    await assert.rejects(
      s.decide({ approvalId: "a", decisionId: "d", decision: "allow-always" }),
      /INVALID_INPUT/,
    );
    await s.dispose();
    await assert.rejects(s.snapshot(), /SESSION_UNAVAILABLE/);
    await assert.rejects(s.cancel(completed.runs[0].id), /SESSION_UNAVAILABLE/);
    await assert.rejects(s.resume(completed.runs[0].id), /SESSION_UNAVAILABLE/);
    await assert.rejects(s.observe(new AbortController().signal).next(), /SESSION_UNAVAILABLE/);
    await assert.rejects(
      s.decide({ approvalId: "a", decisionId: "d", decision: "reject" }),
      /SESSION_UNAVAILABLE/,
    );
    // Releasing one handle leaves the root usable by another session.
    const other = await f.runtime.createSession("still-available");
    await other.submit(input("second"));
    await state(other, "completed");
  } finally {
    await f.runtime.dispose();
  }
});

test("shutdown fences an attach whose authorization is still pending", async () => {
  let release;
  const authorized = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture({ options: { authorize: () => authorized } });
  const attach = f.runtime.createSession("too-late");
  const closed = f.runtime.dispose();
  release();
  await assert.rejects(attach, /RUNTIME_CLOSED/);
  await closed;
  assert.equal(f.host.records.size, 0);
  await f.runtime.dispose();
});
