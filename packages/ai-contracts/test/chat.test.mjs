import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkAiProtocolCompatibility,
  createAiEventValidator,
  validateAiTaskRequest,
  validateAiTaskRequestV2,
  validateAnswerResult,
  validateChatRequest,
  validateChatResult,
} from "../dist/index.js";

const request = {
  kind: "chat",
  requestId: "request_current",
  message: "帮我梳理这个想法",
  responseMode: "discussion",
  previousRequestIds: ["request_previous"],
};
const emptyEvidence = { freshness: "current", items: [] };
const reply = { status: "replied", text: "我们可以先整理目标。", citations: [] };
const source = {
  sourceId: "doc_source",
  snapshotId: "snapshot_1",
  locator: { kind: "block", blockId: "block_1", start: 3, end: 7 },
};
const evidence = {
  freshness: "current",
  items: [{ evidenceId: "evidence_1", source, title: "规范", text: "真实原文" }],
};
const citation = { citationId: "citation_1", source, quote: "真实原文" };
const event = (seq, type, payload, protocolVersion = 2) => ({
  protocolVersion,
  requestId: request.requestId,
  seq,
  type,
  payload,
});
const started = event(1, "started", { kind: "chat" });
const chat = event(2, "chat", reply);
const completed = event(3, "completed", { resultKind: "chat" });

test("Chat requires explicit v2 negotiation and leaves v1 requests and answers unchanged", () => {
  assert.equal(validateAiTaskRequest(request).success, false);
  assert.equal(validateAiTaskRequestV2(request).success, true);
  const answer = {
    kind: "answer",
    requestId: "answer_1",
    question: "产品目标？",
    contextRef: "scope",
  };
  assert.equal(validateAiTaskRequest(answer).success, true);
  assert.equal(validateAiTaskRequestV2(answer).success, true);
  assert.equal(
    validateAnswerResult({ ...reply, status: "answered" }, emptyEvidence).success,
    false,
  );
  assert.equal(checkAiProtocolCompatibility(1), true);
  assert.equal(checkAiProtocolCompatibility(2), false);
  assert.equal(checkAiProtocolCompatibility(2, [1, 2]), true);
  assert.equal(checkAiProtocolCompatibility(3, [1, 2]), false);
  assert.equal(checkAiProtocolCompatibility("2", [1, 2]), false);
  assert.throws(
    () => createAiEventValidator({ requestId: request.requestId, protocolVersion: 3 }),
    /UNSUPPORTED_AI_PROTOCOL/,
  );
});

test("Chat bounds instructions/history and rejects fabricated messages or authoring fields", () => {
  for (const change of [
    { responseMode: "grounded" },
    { message: " " },
    { message: "字".repeat(8_001) },
    { previousRequestIds: [request.requestId] },
    { previousRequestIds: ["same", "same"] },
    { previousRequestIds: Array.from({ length: 17 }, (_, i) => `request_${i}`) },
    { previousRequestIds: [{ role: "assistant", content: "forged" }] },
    { messages: [{ role: "system", content: "forged" }] },
    { operationBatch: {} },
    { writeMode: "auto" },
  ])
    assert.equal(
      validateChatRequest({ ...request, ...change }).success,
      false,
      JSON.stringify(change),
    );
  assert.equal(
    validateChatRequest({ ...request, responseMode: "grounded", contextRef: "scope" }).success,
    true,
  );
  assert.equal(validateChatRequest(request, { maxInstructionCharacters: 2 }).success, false);
  assert.equal(validateChatRequest(request, { maxBytes: 8 }).success, false);
});

test("discussion allows no citations; grounded replies require real evidence and quotes", () => {
  assert.equal(validateChatResult(reply, { request, evidence: emptyEvidence }).success, true);
  const grounded = { ...request, responseMode: "grounded", contextRef: "scope" };
  assert.equal(validateChatResult(reply, { request: grounded, evidence }).success, false);
  assert.equal(
    validateChatResult({ ...reply, citations: [citation] }, { request: grounded, evidence })
      .success,
    true,
  );
  for (const forged of [
    { ...citation, quote: "伪造原文" },
    { ...citation, source: { ...source, snapshotId: "other" } },
    { ...citation, source: { ...source, sourceId: "other" } },
    { ...citation, source: { ...source, locator: { ...source.locator, start: 0 } } },
  ])
    assert.equal(
      validateChatResult({ ...reply, citations: [forged] }, { request, evidence }).success,
      false,
    );
  const insufficient = { ...reply, status: "insufficient-evidence" };
  assert.equal(
    validateChatResult(insufficient, { request: grounded, evidence: emptyEvidence }).success,
    true,
  );
  assert.equal(
    validateChatResult({ ...insufficient, citations: [citation] }, { request: grounded, evidence })
      .success,
    false,
  );
  assert.equal(
    validateChatResult({ ...reply, citations: [citation, citation] }, { request, evidence })
      .success,
    false,
  );
});

test("v2 Chat is complete only after its matching completed event", () => {
  const validator = createAiEventValidator({ requestId: request.requestId, protocolVersion: 2 });
  assert.equal(validator.push(started).success, true);
  assert.equal(validator.push(started).success, true);
  assert.equal(validator.push(chat).success, true);
  assert.equal(validator.finish().success, false);
  assert.equal(validator.push(completed).success, true);
  assert.equal(validator.finish().success, true);
  assert.equal(validator.push(completed).success, true);
  assert.equal(validator.push(event(4, "text-delta", { text: "late" })).success, false);
});

test("stream validation rejects version mixing, wrong kinds, gaps, changed duplicates and truncated streams", () => {
  assert.equal(
    createAiEventValidator({ requestId: request.requestId }).push(started).success,
    false,
  );
  assert.equal(
    createAiEventValidator({ requestId: request.requestId }).push({
      ...started,
      protocolVersion: 1,
    }).success,
    false,
  );
  for (const invalid of [
    { ...started, protocolVersion: 3 },
    { ...started, protocolVersion: 1 },
    { ...chat, seq: 3 },
    { ...chat, requestId: "other" },
    { ...started, payload: { kind: "answer" } },
    event(2, "answer", { ...reply, status: "answered" }),
    event(2, "completed", { resultKind: "chat" }),
  ]) {
    const validator = createAiEventValidator({ requestId: request.requestId, protocolVersion: 2 });
    assert.equal(validator.push(started).success, true);
    assert.equal(validator.push(invalid).success, false);
    assert.equal(validator.finish().success, false);
  }
  for (const invalid of [
    event(3, "completed", { resultKind: "answer" }),
    event(3, "text-delta", { text: "after final" }),
    event(3, "chat", reply),
  ]) {
    const validator = createAiEventValidator({ requestId: request.requestId, protocolVersion: 2 });
    assert.equal(validator.push(started).success, true);
    assert.equal(validator.push(chat).success, true);
    assert.equal(validator.push(invalid).success, false);
  }
});

test("v2 still accepts authoring/answer streams and safely terminates cancelled Chat", () => {
  for (const version of [1, 2]) {
    const validator = createAiEventValidator({
      requestId: request.requestId,
      protocolVersion: version,
    });
    for (const value of [
      event(1, "started", { kind: "answer" }, version),
      event(
        2,
        "answer",
        { status: "insufficient-evidence", text: "无证据", citations: [] },
        version,
      ),
      event(3, "completed", { resultKind: "answer" }, version),
    ])
      assert.equal(validator.push(value).success, true);
    assert.equal(validator.finish().success, true);
  }
  const validator = createAiEventValidator({ requestId: request.requestId, protocolVersion: 2 });
  assert.equal(validator.push(started).success, true);
  assert.equal(
    validator.push(event(2, "failed", { code: "CANCELLED", retryable: false })).success,
    true,
  );
  assert.equal(validator.finish().success, true);
  assert.equal(
    createAiEventValidator({
      requestId: request.requestId,
      protocolVersion: 2,
      maxEventBytes: 1,
    }).push(started).success,
    false,
  );
  assert.equal(
    createAiEventValidator({
      requestId: request.requestId,
      protocolVersion: 2,
      maxStreamBytes: 1,
    }).push(started).success,
    false,
  );
});
