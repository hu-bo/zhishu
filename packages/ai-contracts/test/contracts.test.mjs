import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  validateScopeSelection,
  validateEvidenceBundle,
  citationsMatchEvidence,
  validatePublicHttpUrl,
  validateQaAnswer,
  validateWritingProposalPayload,
} from "../dist/index.js";

const blockSource = {
  sourceKind: "document",
  sourceId: "doc_1",
  snapshotId: "snap_1",
  title: "设计规范",
  workspaceId: "ws_1",
  documentId: "doc_1",
  generationId: "gen_1",
  durableSeq: "12",
  metadataRevision: "3",
  indexVersion: "iv_1",
};
const item = {
  evidenceId: "ev_1",
  sourceId: "doc_1",
  snapshotId: "snap_1",
  locator: { kind: "block", blockId: "block_a", start: 0, end: 11 },
  text: "知书是一款中文写作工具",
};
const bundle = { sources: [blockSource], items: [item], freshness: "current" };

test("scope selection enforces bounds and uniqueness", () => {
  assert.equal(validateScopeSelection({ kind: "all" }).success, true);
  assert.equal(
    validateScopeSelection({ kind: "workspaces", workspaceIds: ["ws_1", "ws_1"] }).success,
    false,
  );
  assert.equal(
    validateScopeSelection({ kind: "documents", documentIds: Array(65).fill("d") }).success,
    false,
  );
  assert.equal(validateScopeSelection({ kind: "unknown" }).success, false);
});

test("evidence bundle requires source identity and locator/text length match", () => {
  assert.equal(validateEvidenceBundle(bundle).success, true);
  assert.equal(
    validateEvidenceBundle({
      ...bundle,
      items: [{ ...item, locator: { kind: "block", blockId: "block_a", start: 0, end: 99 } }],
    }).success,
    false,
  );
  // An item that names an unregistered source is rejected.
  assert.equal(
    validateEvidenceBundle({ ...bundle, items: [{ ...item, sourceId: "ghost" }] }).success,
    false,
  );
  // Duplicate (sourceId, snapshotId) sources are rejected.
  assert.equal(
    validateEvidenceBundle({ ...bundle, sources: [blockSource, blockSource] }).success,
    false,
  );
});

test("citation quote must match the stored slice verbatim", () => {
  const good = [
    {
      citationId: "c1",
      evidenceArtifactId: "art_1",
      evidenceId: "ev_1",
      locator: { kind: "block", blockId: "block_a", start: 2, end: 4 },
      quote: "是一",
    },
  ];
  assert.equal(citationsMatchEvidence(good, bundle, "art_1"), true);
  assert.equal(
    citationsMatchEvidence([{ ...good[0], quote: "伪造的引用" }], bundle, "art_1"),
    false,
  );
  // Fabricated artifact identity is refused.
  assert.equal(
    citationsMatchEvidence([{ ...good[0], evidenceArtifactId: "art_x" }], bundle, "art_1"),
    false,
  );
  // Duplicate citationId is refused.
  assert.equal(citationsMatchEvidence([good[0], good[0]], bundle, "art_1"), false);
});

test("web urls reject credentials, unsafe protocols and internal addresses", () => {
  assert.equal(validatePublicHttpUrl("https://example.com/a"), true);
  assert.equal(validatePublicHttpUrl("https://user:pass@example.com"), false);
  assert.equal(validatePublicHttpUrl("javascript:alert(1)"), false);
  assert.equal(validatePublicHttpUrl("http://127.0.0.1/x"), false);
  assert.equal(validatePublicHttpUrl("http://localhost/x"), false);
  assert.equal(validatePublicHttpUrl("http://10.1.2.3/x"), false);
});

test("answered requires at least one valid citation; insufficient must have none", () => {
  const citation = {
    citationId: "c1",
    evidenceArtifactId: "art_1",
    evidenceId: "ev_1",
    locator: { kind: "block", blockId: "block_a", start: 0, end: 11 },
    quote: "知书是一款中文写作工具",
  };
  assert.equal(
    validateQaAnswer(
      { status: "answered", text: "知书是写作工具。", citations: [citation] },
      { evidence: bundle, evidenceArtifactId: "art_1" },
    ).success,
    true,
  );
  assert.equal(
    validateQaAnswer(
      { status: "answered", text: "无依据的断言。", citations: [] },
      { evidence: bundle, evidenceArtifactId: "art_1" },
    ).success,
    false,
  );
  assert.equal(
    validateQaAnswer(
      { status: "insufficient-evidence", text: "资料不足。", citations: [citation] },
      { evidence: bundle, evidenceArtifactId: "art_1" },
    ).success,
    false,
  );
});

const paragraph = (blockId, text) => ({
  type: "paragraph",
  attrs: { blockId },
  content: [{ type: "text", text }],
});

test("proposal payload is validated against request target and evidence", () => {
  const snapshot = {
    documentId: "doc_1",
    schemaVersion: 6,
    content: { type: "doc", content: [paragraph("block_a", "第一段原文")] },
  };
  const request = {
    intent: "create",
    instruction: "追加一段",
    target: { kind: "document-end", afterBlockId: "block_a" },
  };
  const payload = {
    document: {
      documentId: "doc_1",
      generationId: "gen_1",
      durableSeq: 12,
      contentHash: `sha256:${"0".repeat(64)}`,
    },
    baseStructureRevision: 4,
    target: { kind: "document-end", afterBlockId: "block_a" },
    operationBatch: {
      operationId: "op_1",
      documentId: "doc_1",
      generationId: "gen_1",
      origin: "ai-accept",
      preconditions: [{ blockId: "block_a" }],
      operations: [
        {
          type: "insert-block",
          parentBlockId: null,
          afterBlockId: "block_a",
          block: paragraph("block_new", "新增内容"),
        },
      ],
    },
    summary: "追加了一段",
    citations: [],
  };
  const context = {
    request,
    document: payload.document,
    baseStructureRevision: payload.baseStructureRevision,
    snapshot,
    evidence: bundle,
    artifactResolver: () => "art_1",
  };
  assert.equal(validateWritingProposalPayload(payload, context).success, true);
  // A mismatched target is a conflict.
  assert.equal(
    validateWritingProposalPayload({ ...payload, target: { kind: "document" } }, context).success,
    false,
  );
  // Payload must not smuggle identity fields.
  assert.equal(
    validateWritingProposalPayload({ ...payload, proposalId: "proposal_x" }, context).success,
    false,
  );
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});
