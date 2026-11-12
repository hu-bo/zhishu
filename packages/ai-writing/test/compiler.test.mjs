import assert from "node:assert/strict";
import test from "node:test";
import { compileProposal, validateInput, deterministicNativeSessionId } from "../dist/index.js";
import { hashContent } from "@zhishu/ai-contracts/hash";

const paragraph = (blockId, text) => ({
  type: "paragraph",
  attrs: { blockId },
  content: [{ type: "text", text }],
});
const snapshot = {
  documentId: "doc_1",
  generationId: "gen_1",
  durableSeq: 12,
  schemaVersion: 6,
  extensions: [],
  snapshotRevision: 1,
  content: { type: "doc", content: [paragraph("block_a", "第一段原文内容")] },
};
const document = {
  documentId: "doc_1",
  generationId: "gen_1",
  durableSeq: 12,
  contentHash: hashContent(snapshot.content),
};
const evidence = {
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
const baseInput = {
  threadId: "conv_1",
  runId: "run_1",
  document,
  baseStructureRevision: 4,
  snapshot,
  prompt: { id: "writing", version: "1", systemInstruction: "写作" },
};

test("compileProposal emits WritingProposalPayload with resolved citations and no embedded identity", () => {
  const input = {
    ...baseInput,
    evidence,
    request: {
      intent: "create",
      instruction: "追加一段摘要",
      target: { kind: "document-end", afterBlockId: "block_a" },
    },
  };
  validateInput(input, {});
  const proposal = compileProposal(
    input,
    {
      blocks: [{ type: "paragraph", text: "原文摘要：第一段原文内容。" }],
      summary: "追加了摘要",
      citations: [{ evidenceId: "ev_1", quote: "第一段原文内容" }],
    },
    evidence,
    { artifactResolver: "art_ev_1" },
  );
  assert.equal(Object.hasOwn(proposal, "proposalId"), false);
  assert.equal(Object.hasOwn(proposal, "requestId"), false);
  assert.equal(proposal.citations[0].evidenceArtifactId, "art_ev_1");
  assert.deepEqual(proposal.citations[0].locator, {
    kind: "block",
    blockId: "block_a",
    start: 0,
    end: 7,
  });
  assert.equal(proposal.operationBatch.operations[0].type, "insert-block");
  // Deterministic block identity from thread+run only.
  const again = compileProposal(
    input,
    {
      blocks: [{ type: "paragraph", text: "原文摘要：第一段原文内容。" }],
      summary: "追加了摘要",
      citations: [{ evidenceId: "ev_1", quote: "第一段原文内容" }],
    },
    evidence,
    { artifactResolver: "art_ev_1" },
  );
  assert.equal(
    again.operationBatch.operations[0].block.attrs.blockId,
    proposal.operationBatch.operations[0].block.attrs.blockId,
  );
});

test("fabricated or unregistered citation references fail closed", () => {
  const input = {
    ...baseInput,
    evidence,
    request: {
      intent: "research",
      instruction: "依据资料写作",
      target: { kind: "document-end", afterBlockId: "block_a" },
    },
  };
  assert.throws(
    () =>
      compileProposal(
        input,
        {
          blocks: [{ type: "paragraph", text: "依据不存在来源的内容" }],
          summary: "s",
          citations: [{ evidenceId: "ev_ghost", quote: "不存在" }],
        },
        evidence,
        { artifactResolver: "art_x" },
      ),
    /INVALID_CITATION/,
  );
  // research intent without any citation is insufficient.
  assert.throws(
    () =>
      compileProposal(
        input,
        { blocks: [{ type: "paragraph", text: "无引用草稿" }], summary: "s", citations: [] },
        evidence,
        { artifactResolver: "art_x" },
      ),
    /INSUFFICIENT_EVIDENCE/,
  );
});

test("target capture mismatch blocks compilation", () => {
  assert.throws(
    () =>
      validateInput(
        {
          ...baseInput,
          document: { ...document, contentHash: `sha256:${"f".repeat(64)}` },
          request: {
            intent: "create",
            instruction: "x",
            target: { kind: "document-end", afterBlockId: "block_a" },
          },
        },
        {},
      ),
    /TARGET_CONFLICT/,
  );
});

test("native session ids separate context revisions for the same conversation", () => {
  assert.notEqual(
    deterministicNativeSessionId("conv_9", 1),
    deterministicNativeSessionId("conv_9", 2),
  );
});
