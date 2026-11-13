/* global AbortController, setTimeout, clearTimeout */
import assert from "node:assert/strict";
import test from "node:test";
import { LlmAdapter, ToolCallId } from "@deepseek-ai/dsh-llm";
import { createWritingRuntime } from "../dist/index.js";
import { deterministicNativeSessionId } from "../dist/index.js";
import { createMemoryPersistencePlugin, createRecordingHost, turnRequest } from "./helpers.mjs";

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
        const timer = setTimeout(resolve, 400);
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
    if (text === "metered") yield { type: "usage", usage: { inputTokens: 11, outputTokens: 7 } };
    yield { type: "finish", reason: { kind: text === "max" ? "max-tokens" : "stop" } };
  }
}

async function fixture(extra = {}) {
  const memory = extra.memory ?? createMemoryPersistencePlugin(),
    model = extra.model ?? new Model();
  const runtime = await createWritingRuntime({
    persistence: "required",
    agentOptions: { provider: "test", model: "test" },
    configure: async (ctx) => {
      await ctx.plugin(memory.MemoryPersistence);
      ctx.llm.registerAdapter(["test"], model);
    },
    setup: (ctx, agent) => {
      ctx.tools.register({
        name: "action",
        description: "Test permission seam",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: {
          schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          render: () => [{ type: "text", text: "done" }],
        },
        execute: async () => {
          extra.onAction?.();
          return { ok: true };
        },
      });
      ctx.on("tools/pre-execute", async (exec, next) =>
        exec.name === "action" ? { kind: "ask" } : next(),
      );
      extra.setup?.(ctx, agent);
    },
    ...extra.options,
  });
  return { runtime, memory, model };
}

test("native turn streams dense preview frames and settles completed without private text", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_a",
      contextRevision: 1,
      nativeSessionId: "native_a",
      restore: false,
    });
    const recorder = createRecordingHost();
    const result = await session.execute(
      turnRequest({ nativeSessionId: "native_a", inputText: "你好" }),
      recorder.host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.resultText, "回答:你好");
    assert.equal(result.deliveryConfirmed, true);
    assert.deepEqual(
      recorder.calls.previews.map((f) => f.index),
      [0, 1],
    );
    assert.ok(!JSON.stringify(recorder.calls.previews).includes("PRIVATE_REASONING"));
    assert.equal(recorder.calls.auth, 1);
    assert.equal(recorder.calls.reserve, 1);
    // A second turn on the same session continues the native log.
    const second = createRecordingHost();
    const result2 = await session.execute(
      turnRequest({ runId: "run_2", inputText: "继续", nativeSessionId: "native_a" }),
      second.host,
      new AbortController().signal,
    );
    assert.equal(result2.status, "completed");
    assert.equal(f.model.calls.length, 2);
  } finally {
    await f.runtime.dispose();
  }
});

test("approval is requested durably, decided once, and side effects run only after allow", async () => {
  let actions = 0;
  const memory = createMemoryPersistencePlugin();
  const model = new Model();
  const runtime = await createWritingRuntime({
    persistence: "required",
    agentOptions: { provider: "test", model: "test" },
    configure: async (ctx) => {
      await ctx.plugin(memory.MemoryPersistence);
      ctx.llm.registerAdapter(["test"], model);
    },
    setup: (ctx) => {
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
    },
  });
  try {
    const session = await runtime.attach({
      conversationId: "conv_b",
      contextRevision: 1,
      nativeSessionId: "native_b",
      restore: false,
    });
    const recorder = createRecordingHost();
    const executing = session.execute(
      turnRequest({ nativeSessionId: "native_b", inputText: "approve" }),
      recorder.host,
      new AbortController().signal,
    );
    for (let i = 0; i < 100 && recorder.calls.approvals.length === 0; i++) await delay(10);
    assert.equal(actions, 0);
    const approval = recorder.calls.approvals[0];
    assert.equal(approval.action, "action");
    await session.decide(approval.approvalId, "allow-once");
    const result = await executing;
    assert.equal(result.status, "completed");
    assert.equal(actions, 1);
    // One-shot: the same approval identity cannot be decided twice.
    await assert.rejects(session.decide(approval.approvalId, "reject"), /APPROVAL_EXPIRED/);
    assert.deepEqual(recorder.calls.resolved[0][1], "allowed-once");
    assert.equal(result.hasToolFacts, true);
  } finally {
    await runtime.dispose();
  }
});

test("model budget and flush faults stop completed publication", async () => {
  // Budget: reserveModelCall throwing must fail the turn without executing the request.
  const f = await fixture();
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_c",
      contextRevision: 1,
      nativeSessionId: "native_c",
      restore: false,
    });
    const recorder = createRecordingHost({ exceedModelBudget: (n) => n >= 1 });
    const result = await session.execute(
      turnRequest({ nativeSessionId: "native_c", inputText: "你好" }),
      recorder.host,
      new AbortController().signal,
    );
    assert.equal(result.status, "failed");
  } finally {
    await f.runtime.dispose();
  }
  // Flush fault: product publication path never sees a completed result.
  const g = await fixture();
  try {
    const session = await g.runtime.attach({
      conversationId: "conv_d",
      contextRevision: 1,
      nativeSessionId: "native_d",
      restore: false,
    });
    const first = createRecordingHost();
    await session.execute(
      turnRequest({ nativeSessionId: "native_d", inputText: "你好" }),
      first.host,
      new AbortController().signal,
    );
    g.memory.faults.flush = true;
    const second = createRecordingHost();
    await assert.rejects(
      session.execute(
        turnRequest({ runId: "run_2", nativeSessionId: "native_d", inputText: "继续" }),
        second.host,
        new AbortController().signal,
      ),
    );
    g.memory.faults.flush = false;
  } finally {
    await g.runtime.dispose();
  }
});

test("restart settles a durable native turn without redelivery or new model calls", async () => {
  const memory = createMemoryPersistencePlugin();
  const model = new Model();
  let f = await fixture({ memory, model });
  const session = await f.runtime.attach({
    conversationId: "conv_e",
    contextRevision: 1,
    nativeSessionId: "native_e",
    restore: false,
  });
  const recorder = createRecordingHost();
  const executed = await session.execute(
    turnRequest({ nativeSessionId: "native_e", inputText: "first" }),
    recorder.host,
    new AbortController().signal,
  );
  assert.equal(executed.status, "completed");
  const calls = model.calls.length;
  await f.runtime.dispose();
  // Simulate a completed native turn whose product transaction never landed.
  const restoredRuntime = await fixture({ memory, model });
  try {
    const restored = await restoredRuntime.runtime.attach({
      conversationId: "conv_e",
      contextRevision: 1,
      nativeSessionId: "native_e",
      restore: true,
    });
    const settleHost = createRecordingHost();
    const settled = await restored.settle(
      turnRequest({
        nativeSessionId: "native_e",
        inputText: "first",
        plannedNativeMessageId: executed.nativeMessageId,
        deliveryConfirmed: true,
      }),
      settleHost.host,
      new AbortController().signal,
    );
    assert.equal(settled.status, "completed");
    assert.equal(settled.resultText, "回答:first");
    assert.equal(model.calls.length, calls);
    // Settle never re-plans delivery of a confirmed message.
    assert.equal(settleHost.calls.planned.length, 0);
  } finally {
    await restoredRuntime.runtime.dispose();
  }
});

test("deadline-exceeded turns fail before the model; cancellation aborts the active run", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_f",
      contextRevision: 1,
      nativeSessionId: "native_f",
      restore: false,
    });
    const recorder = createRecordingHost();
    const late = await session.execute(
      turnRequest({ nativeSessionId: "native_f", deadlineAtMs: Date.now() - 1 }),
      recorder.host,
      new AbortController().signal,
    );
    assert.equal(late.status, "failed");
    assert.equal(late.errorCode, "DEADLINE");
    assert.equal(f.model.calls.length, 0);

    const hold = createRecordingHost();
    const executing = session.execute(
      turnRequest({ runId: "run_hold", nativeSessionId: "native_f", inputText: "hold" }),
      hold.host,
      new AbortController().signal,
    );
    await delay(20);
    session.cancelActive("run_hold");
    const result = await executing;
    assert.equal(result.status, "cancelled");
  } finally {
    await f.runtime.dispose();
  }
});

test("idle sessions are recycled and can be restored afterwards", async () => {
  const detached = [];
  const memory = createMemoryPersistencePlugin();
  const f = await fixture({
    memory,
    options: {
      limits: { maxSessions: 4, sessionIdleMs: 60 },
      onSessionDetached: (id) => detached.push(id),
    },
  });
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_idle",
      contextRevision: 1,
      nativeSessionId: "native_idle",
      restore: false,
    });
    const recorder = createRecordingHost();
    const executed = await session.execute(
      turnRequest({ nativeSessionId: "native_idle", inputText: "first" }),
      recorder.host,
      new AbortController().signal,
    );
    assert.equal(executed.status, "completed");
    for (let i = 0; i < 100 && detached.length === 0; i++) await delay(20);
    assert.deepEqual(detached, ["native_idle"]);
    // The writer lock was released: restoring the recycled session succeeds and settles
    // the durable turn without a new model call.
    const calls = f.model.calls.length;
    const restored = await f.runtime.attach({
      conversationId: "conv_idle",
      contextRevision: 1,
      nativeSessionId: "native_idle",
      restore: true,
    });
    const settled = await restored.settle(
      turnRequest({
        nativeSessionId: "native_idle",
        inputText: "first",
        plannedNativeMessageId: executed.nativeMessageId,
        deliveryConfirmed: true,
      }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(settled.status, "completed");
    assert.equal(f.model.calls.length, calls);
  } finally {
    await f.runtime.dispose();
  }
});

test("a full session cache evicts the least recently used idle session", async () => {
  const detached = [];
  const f = await fixture({
    options: {
      limits: { maxSessions: 1, sessionIdleMs: 600_000 },
      onSessionDetached: (id) => detached.push(id),
    },
  });
  try {
    const first = await f.runtime.attach({
      conversationId: "conv_lru_a",
      contextRevision: 1,
      nativeSessionId: "native_lru_a",
      restore: false,
    });
    await first.execute(
      turnRequest({ nativeSessionId: "native_lru_a", inputText: "你好" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    const second = await f.runtime.attach({
      conversationId: "conv_lru_b",
      contextRevision: 1,
      nativeSessionId: "native_lru_b",
      restore: false,
    });
    assert.deepEqual(detached, ["native_lru_a"]);
    const result = await second.execute(
      turnRequest({ nativeSessionId: "native_lru_b", inputText: "继续" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
  } finally {
    await f.runtime.dispose();
  }
});

test("a busy session is never evicted to make room", async () => {
  const detached = [];
  const f = await fixture({
    options: {
      limits: { maxSessions: 1, sessionIdleMs: 1 },
      onSessionDetached: (id) => detached.push(id),
    },
  });
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_busy",
      contextRevision: 1,
      nativeSessionId: "native_busy",
      restore: false,
    });
    const executing = session.execute(
      turnRequest({ nativeSessionId: "native_busy", inputText: "hold" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    await delay(30);
    // The active turn holds the only slot: a second attach must refuse, not evict.
    await assert.rejects(
      f.runtime.attach({
        conversationId: "conv_busy_b",
        contextRevision: 1,
        nativeSessionId: "native_busy_b",
        restore: false,
      }),
      /RESOURCE_LIMIT/,
    );
    assert.deepEqual(detached, []);
    session.cancelActive("run_test");
    assert.equal((await executing).status, "cancelled");
  } finally {
    await f.runtime.dispose();
  }
});

test("a host-retained idle session is not swept", async () => {
  const detached = [];
  const f = await fixture({
    options: {
      limits: { maxSessions: 1, sessionIdleMs: 30 },
      retainSession: () => true,
      onSessionDetached: (id) => detached.push(id),
    },
  });
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_retained",
      contextRevision: 1,
      nativeSessionId: "native_retained",
      restore: false,
    });
    await session.execute(
      turnRequest({ nativeSessionId: "native_retained", inputText: "你好" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    await delay(120);
    assert.deepEqual(detached, []);
    await assert.rejects(
      f.runtime.attach({
        conversationId: "conv_retained_b",
        contextRevision: 1,
        nativeSessionId: "native_retained_b",
        restore: false,
      }),
      /RESOURCE_LIMIT/,
    );
  } finally {
    await f.runtime.dispose();
  }
});

test("adapter-reported token usage settles with the turn result", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.attach({
      conversationId: "conv_metered",
      contextRevision: 1,
      nativeSessionId: "native_metered",
      restore: false,
    });
    const result = await session.execute(
      turnRequest({ nativeSessionId: "native_metered", inputText: "metered" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 });
    // Providers that report no accounting leave usage absent, never fabricated.
    const second = await session.execute(
      turnRequest({ runId: "run_unmetered", nativeSessionId: "native_metered", inputText: "你好" }),
      createRecordingHost().host,
      new AbortController().signal,
    );
    assert.equal(second.usage, undefined);
  } finally {
    await f.runtime.dispose();
  }
});

test("deterministic native session ids isolate context revisions", () => {
  const a = deterministicNativeSessionId("conv_x", 1);
  const b = deterministicNativeSessionId("conv_x", 2);
  assert.equal(a, deterministicNativeSessionId("conv_x", 1));
  assert.notEqual(a, b);
  assert.match(a, /^writing_[a-f0-9]{40}$/);
});
