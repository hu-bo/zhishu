import { Value } from "@sinclair/typebox/value";
import { canonicalJson } from "./canonical-json.js";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  documentContractJsonSchemas,
  applyOperationBatch,
  type DocumentSnapshot,
} from "@zhishu/document-contracts";
import {
  AiTaskRequestSchema,
  ChatRequestSchema,
  ChatResultSchema,
  AuthoringProposalSchema,
  AnswerResultSchema,
  EvidenceBundleSchema,
  type EvidenceBundle,
  type SourceCitation,
  type AuthoringRequest,
  type AiTaskRequestV2,
  type ChatRequest,
} from "./schema.js";

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; issues: { code: string; path: string; message: string }[] };
export function invalid<T>(code: string, path = "$"): ValidationResult<T> {
  return { success: false, issues: [{ code, path, message: "AI payload failed validation." }] };
}
export function validateSchema<S extends TSchema>(
  schema: S,
  value: unknown,
  maxBytes = 65_536,
): ValidationResult<Static<S>> {
  try {
    // Bound recursion and bytes before invoking a recursive JSON Schema validator.
    let nodes = 0;
    const visit = (node: unknown, depth: number): void => {
      if (++nodes > 100_000 || depth > 64) throw new Error("limit");
      if (node && typeof node === "object")
        for (const child of Object.values(node)) visit(child, depth + 1);
    };
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
      return invalid("LIMIT_EXCEEDED");
    if (!Value.Check(schema, [...documentContractJsonSchemas], value))
      return invalid("INVALID_PAYLOAD");
    return { success: true, data: value as Static<S> };
  } catch {
    return invalid("INVALID_PAYLOAD");
  }
}
export function validateAiTaskRequest(
  value: unknown,
  limits: { maxBytes?: number; maxInstructionCharacters?: number } = {},
) {
  const result = validateSchema(AiTaskRequestSchema, value, limits.maxBytes ?? 65_536);
  if (!result.success) return result;
  const request = result.data;
  if (
    (request.kind === "answer" ? request.question : request.instruction).length >
    (limits.maxInstructionCharacters ?? 8_000)
  )
    return invalid<typeof request>("LIMIT_EXCEEDED");
  if (
    request.kind === "authoring" &&
    ((["rewrite", "translate"].includes(request.intent) &&
      (request.target.kind !== "blocks" || request.target.blocks.length !== 1)) ||
      (request.intent === "research" && request.target.kind !== "document-end") ||
      (request.intent === "rewrite-document") !== (request.target.kind === "document") ||
      request.target.kind === "selection")
  )
    return invalid<typeof request>("UNSUPPORTED_TARGET");
  return result;
}
export function validateEvidenceBundle(value: unknown): ValidationResult<EvidenceBundle> {
  const result = validateSchema(EvidenceBundleSchema, value, 1_048_576);
  if (!result.success) return result;
  const ids = new Set<string>();
  for (const item of result.data.items) {
    const locator = item.source.locator;
    if (
      ids.has(item.evidenceId) ||
      (locator.kind !== "page" &&
        (locator.end < locator.start || locator.end - locator.start !== item.text.length))
    )
      return invalid("INVALID_CITATION");
    ids.add(item.evidenceId);
  }
  return result;
}
export function validateChatRequest(
  value: unknown,
  limits: { maxBytes?: number; maxInstructionCharacters?: number } = {},
) {
  const result = validateSchema(ChatRequestSchema, value, limits.maxBytes ?? 65_536);
  if (!result.success) return result;
  const request = result.data;
  if (request.message.length > (limits.maxInstructionCharacters ?? 8_000))
    return invalid<typeof request>("LIMIT_EXCEEDED");
  if (
    !request.message.trim() ||
    (request.responseMode === "grounded" && !request.contextRef) ||
    request.previousRequestIds?.includes(request.requestId)
  )
    return invalid<typeof request>("INVALID_PAYLOAD");
  return result;
}
export function validateAiTaskRequestV2(
  value: unknown,
  limits: { maxBytes?: number; maxInstructionCharacters?: number } = {},
): ValidationResult<AiTaskRequestV2> {
  if (value && typeof value === "object" && "kind" in value && value.kind === "chat")
    return validateChatRequest(value, limits);
  return validateAiTaskRequest(value, limits);
}
export function citationsMatch(
  citations: readonly SourceCitation[],
  evidence: EvidenceBundle,
): boolean {
  const ids = new Set<string>();
  return citations.every((citation) => {
    if (ids.has(citation.citationId)) return false;
    ids.add(citation.citationId);
    return evidence.items.some((item) => {
      if (
        item.source.sourceId !== citation.source.sourceId ||
        item.source.snapshotId !== citation.source.snapshotId
      )
        return false;
      const from = item.source.locator,
        to = citation.source.locator;
      if (from.kind === "page" || to.kind === "page")
        return canonicalJson(from) === canonicalJson(to) && item.text.includes(citation.quote);
      if (
        from.kind !== to.kind ||
        (from.kind === "block" && to.kind === "block" && from.blockId !== to.blockId) ||
        (from.kind === "section" && to.kind === "section" && from.sectionId !== to.sectionId)
      )
        return false;
      return (
        to.start >= from.start &&
        to.end <= from.end &&
        to.end > to.start &&
        item.text.slice(to.start - from.start, to.end - from.start) === citation.quote
      );
    });
  });
}
export function validateAnswerResult(value: unknown, evidence: EvidenceBundle) {
  const result = validateSchema(AnswerResultSchema, value);
  if (!result.success) return result;
  if (
    !validateEvidenceBundle(evidence).success ||
    !citationsMatch(result.data.citations, evidence) ||
    (result.data.status === "answered" && result.data.citations.length === 0) ||
    (evidence.items.length === 0 && result.data.status !== "insufficient-evidence")
  )
    return invalid<typeof result.data>("INVALID_CITATION");
  return result;
}
export function validateChatResult(
  value: unknown,
  context: { request: ChatRequest; evidence: EvidenceBundle },
) {
  const result = validateSchema(ChatResultSchema, value);
  if (!result.success) return result;
  const { request, evidence } = context;
  if (!validateChatRequest(request).success) return invalid<typeof result.data>("INVALID_PAYLOAD");
  if (
    !validateEvidenceBundle(evidence).success ||
    !citationsMatch(result.data.citations, evidence) ||
    (request.responseMode === "grounded" &&
      result.data.status === "replied" &&
      result.data.citations.length === 0) ||
    (result.data.status === "insufficient-evidence" && result.data.citations.length > 0)
  )
    return invalid<typeof result.data>("INVALID_CITATION");
  return result;
}
export function validateAuthoringProposal(
  value: unknown,
  context: { request: AuthoringRequest; snapshot: DocumentSnapshot; evidence: EvidenceBundle },
) {
  const result = validateSchema(AuthoringProposalSchema, value);
  if (!result.success) return result;
  const proposal = result.data,
    request = context.request,
    batch = proposal.operationBatch;
  if (
    proposal.requestId !== request.requestId ||
    canonicalJson(proposal.document) !== canonicalJson(request.document) ||
    canonicalJson(proposal.target) !== canonicalJson(request.target) ||
    proposal.baseStructureRevision !== request.baseStructureRevision ||
    batch.origin !== "ai-accept" ||
    batch.documentId !== request.document.documentId ||
    batch.generationId !== request.document.generationId
  )
    return invalid<typeof proposal>("TARGET_CONFLICT");
  if (
    !citationsMatch(proposal.citations, context.evidence) ||
    (request.intent === "research" && proposal.citations.length === 0)
  )
    return invalid<typeof proposal>("INVALID_CITATION");
  const target = request.target;
  if (target.kind === "selection") return invalid<typeof proposal>("UNSUPPORTED_TARGET");
  if (target.kind === "document") {
    if (request.intent !== "rewrite-document")
      return invalid<typeof proposal>("UNSUPPORTED_TARGET");
    const oldBlocks = context.snapshot.content.content;
    if (oldBlocks.length > 256 || batch.operations.length < oldBlocks.length)
      return invalid<typeof proposal>("UNSUPPORTED_TARGET");
    let deleting = false,
      outputs = 0;
    let after: string | null = null;
    for (let index = 0; index < batch.operations.length; index++) {
      const operation = batch.operations[index]!;
      const old = oldBlocks[index];
      if (old) {
        if (!batch.preconditions?.some((p) => p.blockId === old.attrs.blockId))
          return invalid<typeof proposal>("TARGET_CONFLICT");
        if (operation.type === "delete-block" && operation.targetBlockId === old.attrs.blockId) {
          deleting = true;
          continue;
        }
        if (
          deleting ||
          operation.type !== "replace-block" ||
          operation.targetBlockId !== old.attrs.blockId ||
          operation.block.attrs.blockId !== old.attrs.blockId
        )
          return invalid<typeof proposal>("UNSUPPORTED_TARGET");
      } else if (
        deleting ||
        operation.type !== "insert-block" ||
        operation.parentBlockId !== null ||
        operation.beforeBlockId !== undefined ||
        (operation.afterBlockId ?? null) !== after
      )
        return invalid<typeof proposal>("UNSUPPORTED_TARGET");
      if (
        (operation.type !== "insert-block" && operation.type !== "replace-block") ||
        !["paragraph", "heading", "codeBlock"].includes(operation.block.type)
      )
        return invalid<typeof proposal>("INVALID_OUTPUT");
      outputs++;
      after = operation.block.attrs.blockId;
    }
    if (
      !outputs ||
      !applyOperationBatch(context.snapshot.content, batch, {
        documentId: context.snapshot.documentId,
        generationId: request.document.generationId,
      }).success
    )
      return invalid<typeof proposal>("INVALID_OUTPUT");
    return result;
  }
  const replacing = request.intent === "rewrite" || request.intent === "translate";
  let after =
    target.kind === "document-end" ? target.afterBlockId : (target.blocks.at(-1)?.blockId ?? null);
  const anchor = after;
  for (const operation of batch.operations) {
    if (replacing) {
      if (
        batch.operations.length !== 1 ||
        operation.type !== "replace-block" ||
        target.kind !== "blocks" ||
        operation.targetBlockId !== target.blocks[0]?.blockId ||
        operation.block.attrs.blockId !== operation.targetBlockId
      )
        return invalid<typeof proposal>("UNSUPPORTED_TARGET");
    } else {
      if (
        operation.type !== "insert-block" ||
        operation.parentBlockId !== null ||
        operation.beforeBlockId !== undefined ||
        (operation.afterBlockId ?? null) !== after
      )
        return invalid<typeof proposal>("UNSUPPORTED_TARGET");
      after = operation.block.attrs.blockId;
    }
    if (
      (operation.type === "insert-block" || operation.type === "replace-block") &&
      !["paragraph", "heading", "codeBlock"].includes(operation.block.type)
    )
      return invalid<typeof proposal>("INVALID_OUTPUT");
  }
  if (anchor && !batch.preconditions?.some((p) => p.blockId === anchor))
    return invalid<typeof proposal>("TARGET_CONFLICT");
  const applied = applyOperationBatch(context.snapshot.content, batch, {
    documentId: context.snapshot.documentId,
    generationId: request.document.generationId,
  });
  if (!applied.success) return invalid<typeof proposal>("INVALID_OUTPUT");
  return result;
}
export function checkAiProtocolCompatibility(
  version: unknown,
  supportedVersions: readonly (1 | 2)[] = [1],
): boolean {
  return (version === 1 || version === 2) && supportedVersions.includes(version);
}
