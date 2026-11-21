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
  proposalBatch,
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

// Characterization fixtures for the three proposal target strategies.
const zeroHash = `sha256:${"0".repeat(64)}`;
const docVersion = {
  documentId: "doc_1",
  generationId: "gen_1",
  durableSeq: 12,
  contentHash: zeroHash,
};
const snapshotOf = (blocks) => ({
  documentId: "doc_1",
  schemaVersion: 6,
  content: { type: "doc", content: blocks },
});
const proposalContext = (request, snapshot) => ({
  request,
  document: docVersion,
  baseStructureRevision: 4,
  snapshot,
  evidence: bundle,
  artifactResolver: () => "art_1",
});
const proposalPayload = (target, operations, preconditions) => ({
  document: docVersion,
  baseStructureRevision: 4,
  target,
  operationBatch: {
    operationId: "op_1",
    documentId: "doc_1",
    generationId: "gen_1",
    origin: "ai-accept",
    ...(preconditions ? { preconditions } : {}),
    operations,
  },
  summary: "摘要",
  citations: [],
});
const replaceOp = (targetBlockId, block) => ({ type: "replace-block", targetBlockId, block });
const deleteOp = (targetBlockId) => ({ type: "delete-block", targetBlockId });
const insertOp = (block, afterBlockId) => ({
  type: "insert-block",
  parentBlockId: null,
  ...(afterBlockId !== undefined ? { afterBlockId } : {}),
  block,
});
const callout = (blockId) => ({
  type: "callout",
  attrs: { blockId, theme: "info" },
  content: [paragraph(`${blockId}_inner`, "提示")],
});
const issueCode = (result) => result.issues[0].code;

test("blocks target admits one in-place replacement and refuses drift", () => {
  const snapshot = snapshotOf([paragraph("block_a", "原文"), paragraph("block_b", "第二段")]);
  const target = { kind: "blocks", blocks: [{ blockId: "block_a", contentHash: zeroHash }] };
  const request = { intent: "rewrite", instruction: "改写", target };
  const context = proposalContext(request, snapshot);
  const operations = [replaceOp("block_a", paragraph("block_a", "改写后"))];
  const preconditions = [{ blockId: "block_a" }];
  assert.equal(
    validateWritingProposalPayload(proposalPayload(target, operations, preconditions), context)
      .success,
    true,
  );
  // translate shares the replacement strategy.
  assert.equal(
    validateWritingProposalPayload(proposalPayload(target, operations, preconditions), {
      ...context,
      request: { ...request, intent: "translate" },
    }).success,
    true,
  );
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(target, [...operations, ...operations], preconditions),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          target,
          [replaceOp("block_b", paragraph("block_b", "改错段"))],
          preconditions,
        ),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          target,
          [replaceOp("block_a", paragraph("block_other", "换身份"))],
          preconditions,
        ),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  assert.equal(
    issueCode(validateWritingProposalPayload(proposalPayload(target, operations), context)),
    "TARGET_CONFLICT",
  );
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(target, [replaceOp("block_a", callout("block_a"))], preconditions),
        context,
      ),
    ),
    "INVALID_OUTPUT",
  );
});

test("document target validates replace/delete/append batches", () => {
  const snapshot = snapshotOf([paragraph("block_a", "第一段"), paragraph("block_b", "第二段")]);
  const target = { kind: "document" };
  const request = { intent: "rewrite-document", instruction: "重写全文", target };
  const context = proposalContext(request, snapshot);
  const preconditions = [{ blockId: "block_a" }, { blockId: "block_b" }];
  const replaceA = replaceOp("block_a", paragraph("block_a", "新第一段"));
  const replaceB = replaceOp("block_b", paragraph("block_b", "新第二段"));
  const appendC = insertOp(paragraph("block_c", "追加"), "block_b");
  // Grow: replace the kept prefix, append the excess.
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(target, [replaceA, replaceB, appendC], preconditions),
      context,
    ).success,
    true,
  );
  // Shrink: replace the kept prefix, delete the excess.
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(target, [replaceA, deleteOp("block_b")], preconditions),
      context,
    ).success,
    true,
  );
  // Once deleting starts, no further operation is admitted.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          target,
          [replaceA, deleteOp("block_b"), insertOp(paragraph("block_c", "追加"), "block_a")],
          preconditions,
        ),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  // Fewer operations than old blocks is refused up front.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(proposalPayload(target, [replaceA], preconditions), context),
    ),
    "UNSUPPORTED_TARGET",
  );
  // Every old block touched needs a precondition.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(target, [replaceA, deleteOp("block_b")], [{ blockId: "block_a" }]),
        context,
      ),
    ),
    "TARGET_CONFLICT",
  );
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          target,
          [replaceOp("block_a", callout("block_a")), deleteOp("block_b")],
          preconditions,
        ),
        context,
      ),
    ),
    "INVALID_OUTPUT",
  );
  // A duplicate appended identity passes the loop but fails the dry run.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          target,
          [replaceA, replaceB, appendC, insertOp(paragraph("block_c", "重复"), "block_c")],
          preconditions,
        ),
        context,
      ),
    ),
    "INVALID_OUTPUT",
  );
  // The document strategy is bound to rewrite-document.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(proposalPayload(target, [replaceA, replaceB], preconditions), {
        ...context,
        request: { ...request, intent: "create" },
      }),
    ),
    "UNSUPPORTED_TARGET",
  );
});

test("auto intent resolves against the proposal target", () => {
  const codeBlock = {
    type: "codeBlock",
    attrs: { blockId: "block_code" },
    content: [{ type: "text", text: "x" }],
  };
  const snapshot = snapshotOf([paragraph("block_a", "原文"), codeBlock]);
  const request = {
    intent: "auto",
    instruction: "帮我改",
    target: { kind: "document-end", afterBlockId: "block_a" },
  };
  const context = proposalContext(request, snapshot);
  // A document proposal resolves to rewrite-document.
  const docTarget = { kind: "document" };
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(
        docTarget,
        [replaceOp("block_a", paragraph("block_a", "新")), deleteOp("block_code")],
        [{ blockId: "block_a" }, { blockId: "block_code" }],
      ),
      context,
    ).success,
    true,
  );
  // A single paragraph block proposal resolves to rewrite.
  const blockTarget = { kind: "blocks", blocks: [{ blockId: "block_a", contentHash: zeroHash }] };
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(
        blockTarget,
        [replaceOp("block_a", paragraph("block_a", "新"))],
        [{ blockId: "block_a" }],
      ),
      context,
    ).success,
    true,
  );
  // A document-end proposal keeps auto and appends.
  const endTarget = { kind: "document-end", afterBlockId: "block_a" };
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(
        endTarget,
        [insertOp(paragraph("block_new", "追加"), "block_a")],
        [{ blockId: "block_a" }],
      ),
      context,
    ).success,
    true,
  );
  // Only paragraph/heading blocks can be auto-rewritten.
  const codeTarget = { kind: "blocks", blocks: [{ blockId: "block_code", contentHash: zeroHash }] };
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          codeTarget,
          [replaceOp("block_code", { ...codeBlock, content: [{ type: "text", text: "y" }] })],
          [{ blockId: "block_code" }],
        ),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  // Multi-block proposals are refused.
  const multiTarget = {
    kind: "blocks",
    blocks: [
      { blockId: "block_a", contentHash: zeroHash },
      { blockId: "block_code", contentHash: zeroHash },
    ],
  };
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          multiTarget,
          [replaceOp("block_a", paragraph("block_a", "新"))],
          [{ blockId: "block_a" }],
        ),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  // auto itself requires a document-end request target.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          docTarget,
          [replaceOp("block_a", paragraph("block_a", "新"))],
          [{ blockId: "block_a" }],
        ),
        { ...context, request: { ...request, target: { kind: "document" } } },
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
});

test("document-end proposals chain inserts from the anchor", () => {
  const snapshot = snapshotOf([paragraph("block_a", "原文")]);
  const target = { kind: "document-end", afterBlockId: "block_a" };
  const request = { intent: "continue", instruction: "续写", target };
  const context = proposalContext(request, snapshot);
  const first = insertOp(paragraph("block_n1", "续写一"), "block_a");
  const second = insertOp(paragraph("block_n2", "续写二"), "block_n1");
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(target, [first, second], [{ blockId: "block_a" }]),
      context,
    ).success,
    true,
  );
  // A broken cursor chain is refused.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(
        proposalPayload(
          target,
          [first, insertOp(paragraph("block_n2", "续写二"), "block_a")],
          [{ blockId: "block_a" }],
        ),
        context,
      ),
    ),
    "UNSUPPORTED_TARGET",
  );
  // Empty documents append without an anchor or precondition.
  const emptyTarget = { kind: "document-end", afterBlockId: null };
  assert.equal(
    validateWritingProposalPayload(
      proposalPayload(emptyTarget, [insertOp(paragraph("block_n1", "首段"))]),
      proposalContext({ ...request, target: emptyTarget }, snapshotOf([])),
    ).success,
    true,
  );
  // research requires at least one citation.
  assert.equal(
    issueCode(
      validateWritingProposalPayload(proposalPayload(target, [first], [{ blockId: "block_a" }]), {
        ...context,
        request: { ...request, intent: "research" },
      }),
    ),
    "INVALID_CITATION",
  );
});

test("proposalBatch repositions selected inserts before existing followers", () => {
  const empty = { type: "doc", content: [] };
  const payloadFor = (operations) => ({
    document: docVersion,
    baseStructureRevision: 4,
    target: { kind: "document-end", afterBlockId: null },
    operationBatch: {
      operationId: "op_1",
      documentId: "doc_1",
      generationId: "gen_1",
      origin: "ai-accept",
      operations,
    },
    summary: "追加",
    citations: [],
  });
  const insertX = insertOp(paragraph("block_x", "X"));
  const insertY = insertOp(paragraph("block_y", "Y"));
  // No follower in current content: append after the last block.
  const appended = proposalBatch(
    payloadFor([insertX]),
    empty,
    { type: "doc", content: [paragraph("block_p", "已有")] },
    ["block_x"],
    "op_2",
  );
  assert.equal(appended.operations[0].afterBlockId, "block_p");
  assert.equal("beforeBlockId" in appended.operations[0], false);
  // A follower already present wins over the tail anchor.
  const before = proposalBatch(
    payloadFor([insertX, insertY]),
    empty,
    { type: "doc", content: [paragraph("block_y", "Y")] },
    ["block_x"],
    "op_2",
  );
  assert.equal(before.operations[0].beforeBlockId, "block_y");
  assert.equal("afterBlockId" in before.operations[0], false);
  // Empty current content: no positional keys at all.
  const bare = proposalBatch(payloadFor([insertX]), empty, empty, ["block_x"], "op_2");
  assert.equal("beforeBlockId" in bare.operations[0], false);
  assert.equal("afterBlockId" in bare.operations[0], false);
});
