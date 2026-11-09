/* global AbortController, AbortSignal, process, structuredClone */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessageChunk } from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  createAiEventValidator,
  validateAuthoringProposal,
  replacementChanges,
  replacementBatch,
} from "@zhishu/ai-contracts";
import { createAuthoringRuntime, hashContent } from "../dist/index.js";
import { applyOperationBatch, CURRENT_DOCUMENT_SCHEMA_VERSION } from "@zhishu/document-contracts";

const block = {
  type: "paragraph",
  attrs: { blockId: "block_original" },
  content: [{ type: "text", text: "原始正文" }],
};
const output = {
  blocks: [{ type: "paragraph", text: "新的草稿" }],
  summary: "草稿",
  citations: [],
};
const input = (id = "run_1", intent = "create") => ({
  threadId: `tenant:user:${id}`,
  structureRevision: 3,
  request: {
    kind: "authoring",
    requestId: id,
    intent,
    document: {
      documentId: "doc_test",
      generationId: "gen_test",
      durableSeq: 7,
      contentHash: hashContent({ type: "doc", content: [block] }),
    },
    baseStructureRevision: 3,
    target: { kind: "document-end", afterBlockId: "block_original" },
    instruction: "写一段说明",
  },
  snapshot: {
    documentId: "doc_test",
    generationId: "gen_test",
    durableSeq: 7,
    schemaVersion: 5,
    extensions: [],
    snapshotRevision: 1,
    content: { type: "doc", content: [block] },
  },
  prompt: { id: "authoring", version: "1", systemInstruction: "请用中文写作" },
});
class ScriptedModel extends BaseChatModel {
  constructor(steps) {
    super({});
    this.steps = steps;
    this.calls = 0;
  }
  _llmType() {
    return "zhishu-test-model";
  }
  bindTools() {
    return this;
  }
  async _generate() {
    throw new Error("stream required");
  }
  async *_streamResponseChunks(messages, options) {
    const step = this.steps[this.calls++];
    const calls =
      typeof step === "function"
        ? await step(messages, options)
        : (step ?? [{ name: "authoring_result", args: output, id: "final" }]);
    for (const call of calls) {
      const args = JSON.stringify(call.args),
        index = calls.indexOf(call);
      for (let offset = 0; offset < args.length; offset += 12) {
        const chunk = new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            {
              name: offset === 0 ? call.name : undefined,
              id: offset === 0 ? call.id : undefined,
              index,
              args: args.slice(offset, offset + 12),
            },
          ],
        });
        yield new ChatGenerationChunk({ text: "", message: chunk });
      }
    }
  }
}
const limits = {
  timeoutMs: 120_000,
  maxInputTokens: 30_000,
  maxOutputTokens: 4_096,
  maxOutputBytes: 32_768,
  maxModelCalls: 12,
  maxSearchCalls: 6,
  maxSourceReads: 6,
};
const options = (model, checkpointer = new MemorySaver(), extra = {}) => ({
  model,
  checkpointer,
  modelVersion: "test-v1",
  limits,
  countTokens: (text) => Buffer.byteLength(text),
  ...extra,
});
const collect = async (iterable) => {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
};
const completed = (events) => {
  assert.equal(events.at(-1).type, "completed", JSON.stringify(events));
  const validator = createAiEventValidator({ requestId: events[0].requestId });
  for (const event of events)
    assert.equal(validator.push(event).success, true, JSON.stringify(event));
  assert.equal(validator.finish().success, true);
  return events.find((event) => event.type === "proposal").payload;
};

test("AI authoring writes formula nodes while preserving text after a delimiter", async () => {
  const source = [
    "$$a^2 - b^2 = (a+b)(a-b)$$s",
    "$$(a+b)^2 = a^2 + 2ab + b^2$$",
    String.raw`$$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$`,
  ].join("\n");
  const original = input("formula_run");
  original.snapshot.schemaVersion = CURRENT_DOCUMENT_SCHEMA_VERSION;
  const model = new ScriptedModel([
    [
      {
        name: "authoring_result",
        args: { ...output, blocks: [{ type: "paragraph", text: source }] },
        id: "formula_result",
      },
    ],
  ]);
  const runtime = createAuthoringRuntime(options(model));
  const proposal = completed(
    await collect(runtime.generate(original, AbortSignal.timeout(10_000))),
  );
  const applied = applyOperationBatch(original.snapshot.content, proposal.operationBatch, {
    documentId: original.snapshot.documentId,
    generationId: original.snapshot.generationId,
  });
  assert.ok(applied.success);
  const [paragraph, binomial, quadratic] = applied.content.content.slice(1);
  assert.deepEqual(paragraph.content, [
    { type: "inlineMath", attrs: { latex: "a^2 - b^2 = (a+b)(a-b)" } },
    { type: "text", text: "s" },
  ]);
  assert.equal(binomial.type, "blockMath");
  assert.equal(binomial.attrs.latex, "(a+b)^2 = a^2 + 2ab + b^2");
  assert.equal(quadratic.type, "blockMath");
  assert.equal(quadratic.attrs.latex, String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`);
});

test("real Deep Agents streams a restricted proposal; completed checkpoints compile without another model call", async () => {
  const model = new ScriptedModel([]),
    saver = new MemorySaver(),
    runtime = createAuthoringRuntime(options(model, saver)),
    original = input();
  const events = await collect(runtime.generate(original, AbortSignal.timeout(10_000)));
  const proposal = completed(events);
  assert.ok(events.some((event) => event.type === "text-delta"));
  assert.equal(model.calls, 1);
  assert.equal(proposal.operationBatch.operations[0].afterBlockId, "block_original");
  assert.deepEqual(original.snapshot.content.content, [block]);
  const rebuilt = createAuthoringRuntime(options(model, saver));
  const reordered = JSON.parse(JSON.stringify(original), (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value,
  );
  const recovered = completed(
    await collect(rebuilt.resume(reordered, AbortSignal.timeout(10_000))),
  );
  assert.deepEqual(recovered, proposal);
  assert.equal(model.calls, 1);
  assert.equal(
    (await collect(runtime.generate(original, AbortSignal.timeout(10_000)))).at(-1).payload.code,
    "THREAD_EXISTS",
  );
});
const evidence = {
  evidenceId: "ev_one",
  source: {
    sourceId: "doc_source",
    snapshotId: "snapshot_one",
    locator: { kind: "block", blockId: "block_source", start: 0, end: 4 },
  },
  title: "来源",
  text: "真实原文",
};
test("multi-turn research registers only read evidence and rejects forged citations and revoked sources", async () => {
  const steps = [
    [{ name: "searchKnowledge", args: { query: "主题" }, id: "search" }],
    [{ name: "readSource", args: { sourceId: "doc_source" }, id: "read" }],
    [
      {
        name: "authoring_result",
        args: { ...output, citations: [{ evidenceId: "ev_one", quote: "原文" }] },
        id: "final",
      },
    ],
  ];
  const extra = {
    researchTools: {
      searchKnowledge: async () => [{ sourceId: "doc_source", title: "来源", excerpt: "摘要" }],
      readSource: async () => [evidence],
    },
    verifyEvidence: async () => true,
  };
  const proposal = completed(
    await collect(
      createAuthoringRuntime(options(new ScriptedModel(steps), undefined, extra)).generate(
        input("research", "research"),
        AbortSignal.timeout(10_000),
      ),
    ),
  );
  assert.equal(proposal.citations[0].quote, "原文");
  const forged = structuredClone(steps);
  forged[2][0].args.citations[0].evidenceId = "invented";
  const invalid = await collect(
    createAuthoringRuntime(options(new ScriptedModel(forged), undefined, extra)).generate(
      input("forged", "research"),
      AbortSignal.timeout(10_000),
    ),
  );
  assert.equal(invalid.at(-1).payload.code, "INVALID_CITATION");
  assert.ok(!invalid.some((event) => event.type === "proposal"));
  const revoked = await collect(
    createAuthoringRuntime(
      options(new ScriptedModel(steps), undefined, { ...extra, verifyEvidence: async () => false }),
    ).generate(input("revoked", "research"), AbortSignal.timeout(10_000)),
  );
  assert.equal(revoked.at(-1).payload.code, "ACCESS_REVOKED");
});
test("research checkpoint retains evidence across interruption and rechecks permissions before resuming", async () => {
  const saver = new MemorySaver(),
    original = input("interrupted", "research");
  const extra = {
    researchTools: {
      searchKnowledge: async () => [{ sourceId: "doc_source", title: "来源", excerpt: "摘要" }],
      readSource: async () => [evidence],
    },
    verifyEvidence: async () => true,
  };
  const model = new ScriptedModel([
    [{ name: "readSource", args: { sourceId: "doc_source" }, id: "read" }],
    async (_messages, config) => {
      await new Promise((resolve) =>
        config.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw new Error("interrupted");
    },
  ]);
  const stream = createAuthoringRuntime(options(model, saver, extra)).generate(
    original,
    AbortSignal.timeout(5_000),
  );
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const current = await iterator.next();
    if (
      current.done ||
      (current.value.type === "progress" && current.value.payload.stage === "reading")
    )
      break;
  }
  await iterator.return();
  const final = [
    {
      name: "authoring_result",
      args: { ...output, citations: [{ evidenceId: evidence.evidenceId, quote: "真实" }] },
      id: "final",
    },
  ];
  const resumed = completed(
    await collect(
      createAuthoringRuntime(options(new ScriptedModel([final]), saver, extra)).resume(
        original,
        AbortSignal.timeout(10_000),
      ),
    ),
  );
  assert.equal(resumed.citations[0].source.locator.end, 2);
  const revoked = await collect(
    createAuthoringRuntime(
      options(new ScriptedModel([]), saver, { ...extra, verifyEvidence: async () => false }),
    ).resume(original, AbortSignal.timeout(10_000)),
  );
  assert.equal(revoked.at(-1).payload.code, "ACCESS_REVOKED");
});
test("whole-document replacement keeps preview isolated, compiles bounded atomic changes and rejects tampering", async () => {
  for (const [oldCount, newCount] of [
    [2, 4],
    [5, 1],
    [2, 2],
  ]) {
    const original = input(`document_${oldCount}_${newCount}`, "rewrite-document");
    original.snapshot.content.content = Array.from({ length: oldCount }, (_, index) => ({
      ...structuredClone(block),
      attrs: { blockId: `block_old_${index}` },
      content: [{ type: "text", text: `原文第 ${index + 1} 段` }],
    }));
    original.request.document.contentHash = hashContent(original.snapshot.content);
    original.request.target = { kind: "document" };
    const before = structuredClone(original.snapshot.content);
    const next = {
      ...output,
      blocks: Array.from({ length: newCount }, (_, index) => ({
        type: "paragraph",
        text: `改写后的第 ${index + 1} 段`,
      })),
    };
    const proposal = completed(
      await collect(
        createAuthoringRuntime(
          options(new ScriptedModel([[{ name: "authoring_result", id: "final", args: next }]])),
        ).generate(original, AbortSignal.timeout(10_000)),
      ),
    );
    assert.deepEqual(original.snapshot.content, before);
    const applied = applyOperationBatch(before, proposal.operationBatch, {
      documentId: "doc_test",
      generationId: "gen_test",
    });
    assert.equal(applied.success, true);
    assert.equal(applied.content.content.length, newCount);
    assert.equal(proposal.operationBatch.operations.length, Math.max(oldCount, newCount));
    assert.equal(applied.content.content[0].attrs.blockId, before.content[0].attrs.blockId);
    assert.ok(applied.content.content.every((b) => b.content[0].text.startsWith("改写后")));
    const tampered = structuredClone(proposal);
    tampered.operationBatch.operations[0].targetBlockId = "block_unrelated";
    assert.equal(
      validateAuthoringProposal(tampered, {
        request: original.request,
        snapshot: original.snapshot,
        evidence: { freshness: "current", items: [] },
      }).success,
      false,
    );
    if (oldCount > newCount) {
      const missingDelete = structuredClone(proposal);
      missingDelete.operationBatch.operations.pop();
      assert.equal(
        validateAuthoringProposal(missingDelete, {
          request: original.request,
          snapshot: original.snapshot,
          evidence: { freshness: "current", items: [] },
        }).success,
        false,
      );
    }
  }
});

test("paragraph decisions preserve unrelated content, rejected originals and out-of-order tail insertions", async () => {
  const original = input("individual-review", "rewrite-document");
  original.request.target = { kind: "document" };
  const next = {
    ...output,
    blocks: Array.from({ length: 4 }, (_, index) => ({
      type: "paragraph",
      text: `建议 ${index + 1}`,
    })),
  };
  const proposal = completed(
    await collect(
      createAuthoringRuntime(
        options(new ScriptedModel([[{ name: "authoring_result", id: "result", args: next }]])),
      ).generate(original, AbortSignal.timeout(10_000)),
    ),
  );
  const changes = replacementChanges(proposal, original.snapshot.content);
  let current = structuredClone(original.snapshot.content);
  for (const index of [3, 1, 2]) {
    const batch = replacementBatch(
      proposal,
      original.snapshot.content,
      current,
      [changes[index].blockId],
      `op_decision_${index}`,
    );
    assert.ok(batch);
    const applied = applyOperationBatch(current, batch, {
      documentId: "doc_test",
      generationId: "gen_test",
    });
    assert.equal(applied.success, true);
    assert.deepEqual(applied.content.content[0], block); // First replacement is deliberately rejected.
    current = applied.content;
  }
  assert.deepEqual(
    current.content.map((b) => b.content[0].text),
    ["原始正文", "建议 2", "建议 3", "建议 4"],
  );
  assert.equal(
    replacementBatch(proposal, original.snapshot.content, current, ["block_other"], "op_forged"),
    null,
  );
  assert.equal(
    replacementBatch(
      proposal,
      original.snapshot.content,
      current,
      [changes[0].blockId, changes[0].blockId],
      "op_duplicate",
    ),
    null,
  );
});

test("target conflicts, single-block replacement, budgets and unsupported model output fail closed", async () => {
  const original = input("rewrite", "rewrite");
  original.request.target = {
    kind: "blocks",
    blocks: [{ blockId: block.attrs.blockId, contentHash: hashContent(block) }],
  };
  const proposal = completed(
    await collect(
      createAuthoringRuntime(options(new ScriptedModel([]))).generate(
        original,
        AbortSignal.timeout(10_000),
      ),
    ),
  );
  assert.equal(proposal.operationBatch.operations[0].block.attrs.blockId, block.attrs.blockId);
  const tampered = structuredClone(proposal);
  tampered.operationBatch.operations[0].targetBlockId = "block_other";
  assert.equal(
    validateAuthoringProposal(tampered, {
      request: original.request,
      snapshot: original.snapshot,
      evidence: { freshness: "current", items: [] },
    }).success,
    false,
  );
  original.structureRevision++;
  assert.equal(
    (
      await collect(
        createAuthoringRuntime(options(new ScriptedModel([]))).generate(
          original,
          AbortSignal.timeout(10_000),
        ),
      )
    ).at(-1).payload.code,
    "TARGET_CONFLICT",
  );
  const limited = createAuthoringRuntime(
    options(new ScriptedModel([]), undefined, { limits: { ...limits, maxInputTokens: 10 } }),
  );
  assert.equal(
    (await collect(limited.generate(input("budget"), AbortSignal.timeout(10_000)))).at(-1).payload
      .code,
    "BUDGET_EXCEEDED",
  );
  const malformed = new ScriptedModel([
    [
      {
        name: "authoring_result",
        args: { ...output, blocks: [{ type: "image", assetId: "asset_forged" }] },
        id: "bad",
      },
    ],
  ]);
  assert.ok(
    !(
      await collect(
        createAuthoringRuntime(options(malformed)).generate(
          input("invalid"),
          AbortSignal.timeout(10_000),
        ),
      )
    ).some((event) => event.type === "proposal"),
  );
});
test("cancellation stops delivery, timeout uses original deadline, iterator return releases admission", async () => {
  const controller = new AbortController(),
    runtime = createAuthoringRuntime(options(new ScriptedModel([])));
  const events = [];
  for await (const event of runtime.generate(input("cancel"), controller.signal)) {
    events.push(event);
    if (event.type === "text-delta") controller.abort();
  }
  assert.equal(events.at(-1).payload.code, "CANCELLED");
  assert.ok(!events.some((event) => event.type === "proposal"));
  const slow = new ScriptedModel([
    async (_messages, options) => {
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw new Error("aborted");
    },
  ]);
  const timeout = await collect(
    createAuthoringRuntime(
      options(slow, undefined, { limits: { ...limits, timeoutMs: 50 } }),
    ).generate(input("timeout"), AbortSignal.timeout(1_000)),
  );
  assert.equal(timeout.at(-1).payload.code, "TIMEOUT");
});
test(
  "official PostgreSQL saver initializes four isolated tables, survives process-level reconstruction and deletes a thread",
  { skip: !process.env.AI_TEST_DATABASE_URL },
  async () => {
    const saver = PostgresSaver.fromConnString(process.env.AI_TEST_DATABASE_URL, {
      schema: "ai_checkpoint",
    });
    let closed = false;
    try {
      await saver.setup();
      const model = new ScriptedModel([]),
        original = input("postgres");
      await saver.deleteThread(original.threadId);
      const proposal = completed(
        await collect(
          createAuthoringRuntime(options(model, saver)).generate(
            original,
            AbortSignal.timeout(10_000),
          ),
        ),
      );
      await saver.end();
      closed = true;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { readFileSync } from "node:fs";
      import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
      import { FakeToolCallingModel } from "langchain";
      import { createAuthoringRuntime } from "./dist/index.js";
      const saver = PostgresSaver.fromConnString(process.env.AI_TEST_DATABASE_URL, {schema: "ai_checkpoint"});
      try {
        const runtime = createAuthoringRuntime({model:new FakeToolCallingModel(), checkpointer:saver, modelVersion:"test-v1", limits:${JSON.stringify(limits)}, countTokens:text=>Buffer.byteLength(text)});
        const events=[]; for await (const event of runtime.resume(JSON.parse(readFileSync(0,"utf8")), AbortSignal.timeout(10000))) events.push(event);
        if(events.at(-1)?.type !== "completed") throw new Error(JSON.stringify(events));
        process.stdout.write(JSON.stringify(events.find(event=>event.type==="proposal").payload));
      } finally { await saver.end(); }
    `,
        ],
        {
          input: JSON.stringify(original),
          encoding: "utf8",
          timeout: 20_000,
          env: process.env,
          cwd: process.cwd(),
          windowsHide: true,
        },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), proposal);
      const reopened = PostgresSaver.fromConnString(process.env.AI_TEST_DATABASE_URL, {
        schema: "ai_checkpoint",
      });
      try {
        const recovered = completed(
          await collect(
            createAuthoringRuntime(
              options(
                new ScriptedModel([
                  () => {
                    throw new Error("must not call model");
                  },
                ]),
                reopened,
              ),
            ).resume(original, AbortSignal.timeout(10_000)),
          ),
        );
        assert.deepEqual(proposal, recovered);
        await reopened.deleteThread(original.threadId);
        const absent = await collect(
          createAuthoringRuntime(options(model, reopened)).resume(
            original,
            AbortSignal.timeout(10_000),
          ),
        );
        assert.equal(absent.at(-1).payload.code, "CHECKPOINT_UNAVAILABLE");
      } finally {
        await reopened.end();
      }
    } finally {
      if (!closed) await saver.end();
    }
  },
);
test("event validation rejects cross-request events, changed duplicates, gaps, missing terminal and excess bytes", () => {
  const first = {
    protocolVersion: 1,
    requestId: "run",
    seq: 1,
    type: "started",
    payload: { kind: "authoring" },
  };
  const validator = createAiEventValidator({ requestId: "run" });
  assert.equal(validator.push(first).success, true);
  assert.equal(validator.push(first).success, true);
  assert.equal(validator.push({ ...first, payload: { kind: "answer" } }).success, false);
  assert.equal(validator.push({ ...first, requestId: "other" }).success, false);
  assert.equal(
    validator.push({
      ...first,
      seq: 3,
      type: "failed",
      payload: { code: "CANCELLED", retryable: false },
    }).success,
    false,
  );
  assert.equal(validator.finish().success, false);
  assert.equal(
    createAiEventValidator({ requestId: "run", maxEventBytes: 2 }).push(first).success,
    false,
  );
});
