import { Value } from "@sinclair/typebox/value";
import { canonicalJson } from "./canonical-json.js";
import type { Static, TSchema } from "@sinclair/typebox";
import {
  documentContractJsonSchemas,
  applyOperationBatch,
  MATHEMATICS_DOCUMENT_SCHEMA_VERSION,
  type DocumentSnapshot,
} from "@zhishu/document-contracts";
import {
  EvidenceBundleSchema,
  QaAnswerSchema,
  ScopeSelectionSchema,
  WritingDraftPayloadSchema,
  WritingProposalPayloadSchema,
  WritingRequestSchema,
  type Citation,
  type DocumentVersion,
  type EvidenceBundle,
  type EvidenceItem,
  type QaAnswer,
  type ScopeSelection,
  type WritingDraftPayload,
  type WritingProposalPayload,
  type WritingRequest,
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

export function validateScopeSelection(value: unknown): ValidationResult<ScopeSelection> {
  const result = validateSchema(ScopeSelectionSchema, value, 32_768);
  if (!result.success) return result;
  let ids: string[];
  switch (result.data.kind) {
    case "all":
      ids = [];
      break;
    case "workspaces":
      ids = result.data.workspaceIds;
      break;
    case "documents":
      ids = result.data.documentIds;
      break;
  }
  if (ids.some((id) => !id.trim() || id !== id.trim())) return invalid("INVALID_PAYLOAD");
  return result;
}

/** Only validated public web addresses may back web evidence. */
export function validatePublicHttpUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    return false;
  // Reject literal private/loopback/link-local IPv4 and IPv6 addresses.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    )
      return false;
  }
  if (host.startsWith("[") || host === "::1") return false;
  return true;
}

export function validateEvidenceBundle(value: unknown): ValidationResult<EvidenceBundle> {
  const result = validateSchema(EvidenceBundleSchema, value, 1_048_576);
  if (!result.success) return result;
  const bundle = result.data;
  if ((bundle.items.length === 0) !== (bundle.sources.length === 0))
    return invalid("INVALID_CITATION");
  const sourceKeys = new Set<string>();
  for (const source of bundle.sources) {
    const key = `${source.sourceId}\u0000${source.snapshotId}`;
    if (sourceKeys.has(key)) return invalid("INVALID_CITATION");
    sourceKeys.add(key);
    if (source.sourceKind === "web" && !validatePublicHttpUrl(source.canonicalUrl))
      return invalid("INVALID_PAYLOAD");
  }
  const evidenceIds = new Set<string>();
  for (const item of bundle.items) {
    if (evidenceIds.has(item.evidenceId)) return invalid("INVALID_CITATION");
    evidenceIds.add(item.evidenceId);
    if (!sourceKeys.has(`${item.sourceId}\u0000${item.snapshotId}`))
      return invalid("INVALID_CITATION");
    const locator = item.locator;
    if (locator.kind !== "page" && locator.end - locator.start !== item.text.length)
      return invalid("INVALID_CITATION");
  }
  return result;
}

/**
 * A citation is only legitimate when it names registered evidence of this bundle and its
 * quote matches the stored slice of that snapshot verbatim. Artifact identity is either one
 * fixed id (single-batch QA) or resolved per evidenceId (multi-batch writing runs).
 */
export type EvidenceArtifactResolver =
  string | undefined | ((evidenceId: string) => string | undefined);

function artifactForEvidence(
  resolver: EvidenceArtifactResolver,
  evidenceId: string,
): string | undefined {
  if (typeof resolver === "function") return resolver(evidenceId);
  return resolver;
}

export function citationsMatchEvidence(
  citations: readonly Citation[],
  evidence: EvidenceBundle,
  artifactResolver: EvidenceArtifactResolver = undefined,
): boolean {
  const byId = new Map<string, EvidenceItem>();
  for (const item of evidence.items) byId.set(item.evidenceId, item);
  const ids = new Set<string>();
  return citations.every((citation) => {
    if (ids.has(citation.citationId)) return false;
    ids.add(citation.citationId);
    if (citation.evidenceArtifactId !== artifactForEvidence(artifactResolver, citation.evidenceId))
      return false;
    const item = byId.get(citation.evidenceId);
    if (!item) return false;
    if (citation.locator.kind === "page" || item.locator.kind === "page")
      return (
        canonicalJson(citation.locator) === canonicalJson(item.locator) &&
        item.text.includes(citation.quote)
      );
    if (citation.locator.kind !== item.locator.kind) return false;
    if (citation.locator.kind === "block" && item.locator.kind === "block") {
      if (citation.locator.blockId !== item.locator.blockId) return false;
    }
    if (citation.locator.kind === "section" && item.locator.kind === "section") {
      if (citation.locator.sectionId !== item.locator.sectionId) return false;
    }
    const from = item.locator,
      to = citation.locator;
    return (
      to.start >= from.start &&
      to.end <= from.end &&
      to.end > to.start &&
      item.text.slice(to.start - from.start, to.end - from.start) === citation.quote
    );
  });
}

/** intent ↔ target matrix; selection is resolved to blocks before a Run is admitted. */
export function validateWritingRequest(
  value: unknown,
  limits: { maxBytes?: number; maxInstructionCharacters?: number } = {},
): ValidationResult<WritingRequest> {
  const result = validateSchema(WritingRequestSchema, value, limits.maxBytes ?? 65_536);
  if (!result.success) return result;
  const request = result.data;
  if (request.instruction.length > (limits.maxInstructionCharacters ?? 8_000))
    return invalid<typeof request>("LIMIT_EXCEEDED");
  if (
    (["rewrite", "translate"].includes(request.intent) &&
      (request.target.kind !== "blocks" || request.target.blocks.length !== 1)) ||
    (["auto", "research", "create", "continue", "summarize"].includes(request.intent) &&
      request.target.kind !== "document-end") ||
    (request.intent === "rewrite-document") !== (request.target.kind === "document")
  )
    return invalid<typeof request>("UNSUPPORTED_TARGET");
  return result;
}

export function validateQaAnswer(
  value: unknown,
  context: { evidence: EvidenceBundle; evidenceArtifactId?: string },
): ValidationResult<QaAnswer> {
  const result = validateSchema(QaAnswerSchema, value);
  if (!result.success) return result;
  const answer = result.data;
  if (
    !validateEvidenceBundle(context.evidence).success ||
    !citationsMatchEvidence(answer.citations, context.evidence, context.evidenceArtifactId) ||
    (answer.status === "answered" && answer.citations.length === 0) ||
    (answer.status === "insufficient-evidence" && answer.citations.length > 0)
  )
    return invalid<QaAnswer>("INVALID_CITATION");
  return result;
}

/**
 * Validates the immutable draft payload of a create-draft Run: content contract, bounded
 * block count and citations against registered evidence. Document creation re-validates
 * authoritatively inside the binding transaction.
 */
export function validateWritingDraftPayload(
  value: unknown,
  context: { evidence: EvidenceBundle; artifactResolver: EvidenceArtifactResolver },
): ValidationResult<WritingDraftPayload> {
  const result = validateSchema(WritingDraftPayloadSchema, value, 2_097_152);
  if (!result.success) return result;
  const draft = result.data;
  if (
    draft.content.content.length === 0 ||
    draft.content.content.length > 256 ||
    !citationsMatchEvidence(draft.citations, context.evidence, context.artifactResolver)
  )
    return invalid<WritingDraftPayload>("INVALID_CITATION");
  return result;
}

export interface ProposalValidationContext {
  request: WritingRequest;
  /** Baseline document version captured at Run admission. */
  document: DocumentVersion;
  baseStructureRevision: number;
  snapshot: DocumentSnapshot;
  evidence: EvidenceBundle;
  artifactResolver: EvidenceArtifactResolver;
}

/**
 * rewrite-document batch check: the kept prefix is replaced in place (identities preserved),
 * the surplus old blocks are deleted, and only when nothing was deleted may excess output be
 * appended as a chained insert tail. Ends with the same application dry run as the other
 * strategies.
 */
function validateDocumentReplacement(
  request: WritingRequest,
  proposal: WritingProposalPayload,
  snapshot: DocumentSnapshot,
  allowedBlocks: readonly string[],
): ValidationResult<WritingProposalPayload> {
  if (request.intent !== "rewrite-document")
    return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
  const batch = proposal.operationBatch;
  const oldBlocks = snapshot.content.content;
  if (oldBlocks.length > 256 || batch.operations.length < oldBlocks.length)
    return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
  let deleting = false,
    outputs = 0;
  let after: string | null = null;
  for (const [index, operation] of batch.operations.entries()) {
    const old = oldBlocks[index];
    if (old) {
      if (!batch.preconditions?.some((p) => p.blockId === old.attrs.blockId))
        return invalid<WritingProposalPayload>("TARGET_CONFLICT");
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
        return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
    } else if (
      deleting ||
      operation.type !== "insert-block" ||
      operation.parentBlockId !== null ||
      operation.beforeBlockId !== undefined ||
      (operation.afterBlockId ?? null) !== after
    )
      return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
    if (
      (operation.type !== "insert-block" && operation.type !== "replace-block") ||
      !allowedBlocks.includes(operation.block.type)
    )
      return invalid<WritingProposalPayload>("INVALID_OUTPUT");
    outputs++;
    after = operation.block.attrs.blockId;
  }
  if (
    !outputs ||
    !applyOperationBatch(snapshot.content, batch, {
      documentId: snapshot.documentId,
      generationId: proposal.document.generationId,
    }).success
  )
    return invalid<WritingProposalPayload>("INVALID_OUTPUT");
  return { success: true, data: proposal };
}

/**
 * Validates the proposal against the accepted request and target snapshot. Identity lives on
 * the artifact row, so payload checks are content and preconditions only.
 */
export function validateWritingProposalPayload(
  value: unknown,
  context: ProposalValidationContext,
): ValidationResult<WritingProposalPayload> {
  const result = validateSchema(WritingProposalPayloadSchema, value);
  if (!result.success) return result;
  const proposal = result.data;
  let { request } = context;
  const batch = proposal.operationBatch;
  if (request.intent === "auto") {
    if (request.target.kind !== "document-end")
      return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
    if (proposal.target.kind === "document") {
      request = { ...request, intent: "rewrite-document", target: proposal.target };
    } else if (proposal.target.kind === "blocks") {
      const blockId = proposal.target.blocks[0]?.blockId;
      const block = context.snapshot.content.content.find((node) => node.attrs.blockId === blockId);
      if (
        proposal.target.blocks.length !== 1 ||
        !block ||
        !["paragraph", "heading"].includes(block.type)
      )
        return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
      request = { ...request, intent: "rewrite", target: proposal.target };
    }
  }
  if (
    canonicalJson(proposal.document) !== canonicalJson(context.document) ||
    proposal.baseStructureRevision !== context.baseStructureRevision ||
    canonicalJson(proposal.target) !== canonicalJson(request.target) ||
    batch.origin !== "ai-accept" ||
    batch.documentId !== proposal.document.documentId ||
    batch.generationId !== proposal.document.generationId
  )
    return invalid<WritingProposalPayload>("TARGET_CONFLICT");
  if (
    !citationsMatchEvidence(proposal.citations, context.evidence, context.artifactResolver) ||
    (request.intent === "research" && proposal.citations.length === 0)
  )
    return invalid<WritingProposalPayload>("INVALID_CITATION");
  const target = request.target;
  const allowedBlocks = ["paragraph", "heading", "codeBlock"];
  if (context.snapshot.schemaVersion >= MATHEMATICS_DOCUMENT_SCHEMA_VERSION)
    allowedBlocks.push("blockMath");
  // Strategy dispatch follows the target discriminated union. The accepted request already
  // satisfies the validateWritingRequest intent ↔ target matrix (rewrite/translate ↔ single
  // blocks, rewrite-document ↔ document, every other intent ↔ document-end), so the blocks
  // case is always a replacement and document-end always a chained insert.
  let anchor: string | null;
  switch (target.kind) {
    case "document":
      return validateDocumentReplacement(request, proposal, context.snapshot, allowedBlocks);
    case "blocks": {
      anchor = target.blocks.at(-1)?.blockId ?? null;
      for (const operation of batch.operations) {
        if (
          batch.operations.length !== 1 ||
          operation.type !== "replace-block" ||
          operation.targetBlockId !== target.blocks[0]?.blockId ||
          operation.block.attrs.blockId !== operation.targetBlockId
        )
          return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
        if (!allowedBlocks.includes(operation.block.type))
          return invalid<WritingProposalPayload>("INVALID_OUTPUT");
      }
      break;
    }
    case "document-end": {
      anchor = target.afterBlockId;
      let after = anchor;
      for (const operation of batch.operations) {
        if (
          operation.type !== "insert-block" ||
          operation.parentBlockId !== null ||
          operation.beforeBlockId !== undefined ||
          (operation.afterBlockId ?? null) !== after
        )
          return invalid<WritingProposalPayload>("UNSUPPORTED_TARGET");
        if (!allowedBlocks.includes(operation.block.type))
          return invalid<WritingProposalPayload>("INVALID_OUTPUT");
        after = operation.block.attrs.blockId;
      }
      break;
    }
  }
  if (anchor && !batch.preconditions?.some((p) => p.blockId === anchor))
    return invalid<WritingProposalPayload>("TARGET_CONFLICT");
  const applied = applyOperationBatch(context.snapshot.content, batch, {
    documentId: context.snapshot.documentId,
    generationId: proposal.document.generationId,
  });
  if (!applied.success) return invalid<WritingProposalPayload>("INVALID_OUTPUT");
  return result;
}
