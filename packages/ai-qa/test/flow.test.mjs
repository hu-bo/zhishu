/* global AbortSignal */
import assert from "node:assert/strict";
import test from "node:test";
import { runQaAnswerFlow, QaFlowError } from "../dist/index.js";

const bundle = {
  sources: [
    {
      sourceKind: "document",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      title: "知书产品规范",
      workspaceId: "ws_1",
      documentId: "doc_1",
      generationId: "gen_1",
      durableSeq: "12",
      metadataRevision: "3",
      indexVersion: "iv_1",
    },
  ],
  items: [
    {
      evidenceId: "ev_1",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      locator: { kind: "block", blockId: "block_a", start: 0, end: 12 },
      text: "知书面向在线文档编辑与团队知识库管理。",
    },
  ],
  freshness: "current",
};
const scope = { kind: "all" };
const baseInput = {
  runId: "run_1",
  conversationId: "conv_1",
  question: "知书是做什么的？",
  history: [],
  scope,
  retrieval: { contextTokenBudget: 4000, maxEvidenceItems: 32, maxRepairRounds: 1 },
  attempt: 1,
};

function makePorts(overrides = {}) {
  const calls = [];
  return {
    calls,
    ports: {
      onStep: async (stepId, status) => {
        calls.push(`step:${stepId}:${status}`);
      },
      retrieve: async () => {
        calls.push("retrieve");
        return bundle;
      },
      registerEvidence: async () => {
        calls.push("register");
        return {
          evidenceArtifactId: "art_ev",
          evidenceRefs: bundle.items.map((item) => ({
            evidenceArtifactId: "art_ev",
            evidenceId: item.evidenceId,
          })),
        };
      },
      generate: async () => {
        calls.push("generate");
        return {
          output: {
            status: "answered",
            text: "知书面向在线文档编辑与团队知识库管理。",
            citations: [{ evidenceId: "ev_1", quote: "知书面向在线文档编辑" }],
          },
          inputTokens: 100,
          outputTokens: 20,
        };
      },
      verifyEvidence: async () => {
        calls.push("verify");
        return true;
      },
      stage: async ({ answer }) => {
        calls.push(`stage:${answer.status}`);
      },
      ...overrides,
    },
  };
}

test("grounded answer resolves citations onto registered evidence identities", async () => {
  const { ports, calls } = makePorts();
  const outcome = await runQaAnswerFlow(ports, { ...baseInput, signal: AbortSignal.timeout(5000) });
  assert.equal(outcome.status, "answered");
  assert.equal(outcome.answer.citations[0].evidenceArtifactId, "art_ev");
  assert.deepEqual(outcome.answer.citations[0].locator, {
    kind: "block",
    blockId: "block_a",
    start: 0,
    end: 10,
  });
  assert.equal(calls.filter((c) => c === "generate").length, 1);
  assert.ok(calls.includes("verify"));
});

test("fabricated evidence ids get bounded repair then fail closed", async () => {
  let attempts = 0;
  const { ports } = makePorts({
    generate: async () => {
      attempts++;
      return {
        output: {
          status: "answered",
          text: "回答",
          citations: [{ evidenceId: "ev_ghost", quote: "任意" }],
        },
        inputTokens: 10,
        outputTokens: 1,
      };
    },
  });
  await assert.rejects(
    runQaAnswerFlow(ports, { ...baseInput, signal: AbortSignal.timeout(5000) }),
    (error) => error instanceof QaFlowError && error.code === "INVALID_CITATION",
  );
  // one initial round plus maxRepairRounds=1.
  assert.equal(attempts, 2);
});

test("empty authorized scope returns insufficient without calling the model", async () => {
  const { ports, calls } = makePorts({
    retrieve: async () => ({ sources: [], items: [], freshness: "current" }),
    generate: async () => {
      throw new Error("must not generate");
    },
  });
  const outcome = await runQaAnswerFlow(ports, { ...baseInput, signal: AbortSignal.timeout(5000) });
  assert.equal(outcome.status, "insufficient-evidence");
  assert.equal(outcome.answer.citations.length, 0);
  assert.ok(!calls.includes("generate"));
});

test("delivery re-check failure revokes access before publishing", async () => {
  const { ports } = makePorts({ verifyEvidence: async () => false });
  await assert.rejects(
    runQaAnswerFlow(ports, { ...baseInput, signal: AbortSignal.timeout(5000) }),
    (error) => error.code === "ACCESS_REVOKED",
  );
});

test("committed staged result is re-delivered without regenerating", async () => {
  const { ports, calls } = makePorts({
    generate: async () => {
      throw new Error("must not regenerate");
    },
  });
  const staged = {
    status: "answered",
    text: "此前的回答。",
    citations: [
      {
        citationId: "citation_1",
        evidenceArtifactId: "art_ev",
        evidenceId: "ev_1",
        locator: { kind: "block", blockId: "block_a", start: 0, end: 6 },
        quote: "知书面向在线",
      },
    ],
    evidenceArtifactId: "art_ev",
  };
  const outcome = await runQaAnswerFlow(ports, {
    ...baseInput,
    signal: AbortSignal.timeout(5000),
    resume: { evidence: { bundle, evidenceArtifactId: "art_ev" }, staged: { answer: staged } },
  });
  assert.equal(outcome.answer.text, "此前的回答。");
  assert.ok(!calls.includes("retrieve"));
  assert.ok(!calls.includes("generate"));
  assert.ok(calls.includes("verify"));
});
