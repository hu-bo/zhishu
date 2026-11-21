import { createHash } from "node:crypto";
import { z } from "zod";
import {
  checkSnapshotCompatibility,
  displayLatexPattern,
  inlineLatexPattern,
  isValidMathSource,
  MATHEMATICS_DOCUMENT_SCHEMA_VERSION,
  SUPPORTED_DOCUMENT_SCHEMA_VERSIONS,
  validateDocumentSnapshot,
  type DocumentBlock,
  type DocumentContent,
  type OperationBatch,
} from "@zhishu/document-contracts";
import {
  validateWritingRequest,
  validateWritingProposalPayload,
  validateWritingDraftPayload,
  validateEvidenceBundle,
  fail,
  type Citation,
  type EvidenceBundle,
  type ModelCitation,
  type WritingDraftPayload,
  type WritingProposalPayload,
} from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-contracts/hash";
import type { WritingInput, DraftInput, CompilerOptions } from "./types.js";

export { hashContent };

/** Model-authored structured draft. Identity and href are never model output. */
const outputBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), text: z.string().max(32_000) }).strict(),
  z
    .object({
      type: z.literal("heading"),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      text: z.string().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("codeBlock"),
      language: z.string().regex(/^[A-Za-z0-9_+-]{1,32}$/),
      text: z.string().max(32_000),
    })
    .strict(),
]);
export const WritingOutputSchema = z
  .object({
    blocks: z.array(outputBlock).min(1).max(256),
    summary: z.string().max(2_000),
    citations: z
      .array(
        z
          .object({ evidenceId: z.string().min(1).max(160), quote: z.string().min(1).max(8_000) })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .meta({ title: "authoring_result" });
export type WritingOutput = z.infer<typeof WritingOutputSchema>;

type OutputBlock = WritingOutput["blocks"][number];
type DraftBlock = OutputBlock | { type: "blockMath"; text: string };
type Paragraph = Extract<DocumentBlock, { type: "paragraph" }>;
type Operation = OperationBatch["operations"][number];

function splitDisplayMath(block: OutputBlock): DraftBlock[] {
  if (block.type !== "paragraph") return [block];
  const blocks: DraftBlock[] = [];
  let offset = 0;
  const addParagraph = (end: number) => {
    const text = block.text.slice(offset, end).replace(/^(?:\r?\n)+|(?:\r?\n)+$/gu, "");
    if (text) blocks.push({ type: "paragraph", text });
  };
  for (const match of block.text.matchAll(new RegExp(displayLatexPattern.source, "gmu"))) {
    const latex = match[1]!.trim();
    if (!isValidMathSource(latex)) continue;
    addParagraph(match.index);
    blocks.push({ type: "blockMath", text: latex });
    offset = match.index + match[0].length;
  }
  if (offset === 0) return [block];
  addParagraph(block.text.length);
  return blocks;
}

function inlineContent(text: string): NonNullable<Paragraph["content"]> {
  const content: NonNullable<Paragraph["content"]> = [];
  let offset = 0;
  const pattern = new RegExp(`${displayLatexPattern.source}|${inlineLatexPattern.source}`, "gmu");
  for (const match of text.matchAll(pattern)) {
    const latex = (match[1] ?? match[2] ?? match[3]!).trim();
    if (!isValidMathSource(latex)) continue;
    if (offset < match.index) content.push({ type: "text", text: text.slice(offset, match.index) });
    content.push({ type: "inlineMath", attrs: { latex } });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) content.push({ type: "text", text: text.slice(offset) });
  return content;
}

/**
 * Baseline check per target kind. validateWritingRequest has already passed, so the
 * intent ↔ target matrix holds and the three kinds are exhaustive.
 */
function validateTargetBaseline(
  request: WritingInput["request"],
  snapshot: WritingInput["snapshot"],
): void {
  if (request.target.kind === "document") {
    if (request.intent !== "rewrite-document" || snapshot.content.content.length > 256)
      fail("UNSUPPORTED_TARGET");
    return;
  }
  if (request.target.kind === "document-end") {
    if ((snapshot.content.content.at(-1)?.attrs.blockId ?? null) !== request.target.afterBlockId)
      fail("TARGET_CONFLICT");
    return;
  }
  let previous = -1;
  for (const target of request.target.blocks) {
    const index = snapshot.content.content.findIndex(
      (block) => block.attrs.blockId === target.blockId,
    );
    if (
      index < 0 ||
      index <= previous ||
      hashContent(snapshot.content.content[index]) !== target.contentHash
    )
      fail("TARGET_CONFLICT");
    previous = index;
  }
  const last = snapshot.content.content[previous];
  // Unreachable past validation: blocks targets name at least one existing block.
  if (!last) fail("UNSUPPORTED_TARGET");
  if (
    ["rewrite", "translate"].includes(request.intent) &&
    !["paragraph", "heading"].includes(last.type)
  )
    fail("UNSUPPORTED_TARGET");
}

/** Fail-closed input validation before any model call. */
export function validateInput(input: WritingInput, options: CompilerOptions): void {
  const { request, snapshot, document } = input;
  const checked = validateWritingRequest(request);
  if (!checked.success)
    fail(
      checked.issues.some((issue) => issue.code === "UNSUPPORTED_TARGET")
        ? "UNSUPPORTED_TARGET"
        : "INVALID_OUTPUT",
    );
  if (
    !input.threadId ||
    input.threadId.length > 512 ||
    !input.runId ||
    !input.prompt.id ||
    !input.prompt.version ||
    !input.prompt.systemInstruction ||
    input.prompt.systemInstruction.length > 32_000 ||
    !validateDocumentSnapshot(snapshot).success ||
    !checkSnapshotCompatibility(
      snapshot,
      options.compatibility ?? {
        schemaVersions: SUPPORTED_DOCUMENT_SCHEMA_VERSIONS,
        extensions: {},
      },
    ).writable
  )
    fail("UNSUPPORTED_TARGET");
  if (
    snapshot.generationId !== document.generationId ||
    snapshot.documentId !== document.documentId ||
    snapshot.durableSeq !== document.durableSeq ||
    !Number.isSafeInteger(snapshot.durableSeq) ||
    hashContent(snapshot.content) !== document.contentHash ||
    !Number.isSafeInteger(input.baseStructureRevision)
  )
    fail("TARGET_CONFLICT");
  if (
    !validateEvidenceBundle(input.evidence ?? { freshness: "current", sources: [], items: [] })
      .success
  )
    fail("INVALID_CITATION");
  validateTargetBaseline(request, snapshot);
  if (request.intent === "research" && !options.researchAvailable) fail("INSUFFICIENT_EVIDENCE");
}

function resolveArtifactId(
  resolver: CompilerOptions["artifactResolver"],
  evidenceId: string,
): string | undefined {
  if (!resolver) return undefined;
  if (typeof resolver === "string") return resolver;
  if (typeof resolver === "function") return resolver(evidenceId);
  return undefined;
}

/**
 * The single verbatim-citation rule shared by grounded answers and writing compilation:
 * every model citation must name registered evidence and quote it exactly; locators are
 * offset-shifted onto the stored slice. Fail-closed on any mismatch.
 */
export function resolveModelCitations(
  raw: readonly ModelCitation[],
  evidence: EvidenceBundle,
  options: CompilerOptions,
): Citation[] {
  return raw.map((citation, index) => {
    const item = evidence.items.find((candidate) => candidate.evidenceId === citation.evidenceId);
    if (!item || !item.text.includes(citation.quote)) throw fail("INVALID_CITATION");
    const evidenceArtifactId = resolveArtifactId(options.artifactResolver, citation.evidenceId);
    if (!evidenceArtifactId) throw fail("INVALID_CITATION");
    const offset = item.text.indexOf(citation.quote);
    let locator = item.locator;
    if (locator.kind !== "page")
      locator = {
        ...locator,
        start: locator.start + offset,
        end: locator.start + offset + citation.quote.length,
      };
    return {
      citationId: `citation_${index + 1}`,
      evidenceArtifactId,
      evidenceId: citation.evidenceId,
      locator,
      quote: citation.quote,
    };
  });
}

/** Deterministic Block IDs derived from the trusted thread and run identity. */
function blockIdFor(idSeed: string, index: number): string {
  return `block_${createHash("sha256").update(`${idSeed}:${index}`).digest("hex").slice(0, 48)}`;
}

function compileBlocks(
  output: WritingOutput,
  idSeed: string,
  supportsMath: boolean,
  maxBlocks: number,
  reuseIds?: readonly string[],
): DocumentBlock[] {
  const expandedBlocks = supportsMath ? output.blocks.flatMap(splitDisplayMath) : output.blocks;
  const draftBlocks = expandedBlocks.length <= maxBlocks ? expandedBlocks : output.blocks;
  return draftBlocks.map((block, index): DocumentBlock => {
    const blockId = reuseIds?.[index] ?? blockIdFor(idSeed, index);
    if (block.type === "blockMath")
      return { type: "blockMath", attrs: { blockId, latex: block.text } };
    const text = block.text ? [{ type: "text" as const, text: block.text }] : [];
    if (block.type === "codeBlock") {
      return { type: "codeBlock", attrs: { blockId, language: block.language }, content: text };
    }
    const content = supportsMath ? inlineContent(block.text) : text;
    return block.type === "heading"
      ? { type: "heading", attrs: { blockId, level: block.level }, content }
      : { type: "paragraph", attrs: { blockId }, content };
  });
}

function insertOperation(block: DocumentBlock, afterBlockId: string | null): Operation {
  return {
    type: "insert-block",
    parentBlockId: null,
    ...(afterBlockId ? { afterBlockId } : {}),
    block,
  };
}

/** rewrite-document: replace the shared head, delete extra old blocks, append the overflow. */
function replaceDocumentOperations(
  previous: readonly DocumentBlock[],
  blocks: readonly DocumentBlock[],
): Operation[] {
  const head: Operation[] = previous.map((old, index) => {
    const block = blocks[index];
    if (block) return { type: "replace-block", targetBlockId: old.attrs.blockId, block };
    return { type: "delete-block", targetBlockId: old.attrs.blockId };
  });
  const tail = blocks.slice(previous.length).map((block, index) => {
    const after = blocks[previous.length + index - 1];
    return insertOperation(block, after ? after.attrs.blockId : null);
  });
  return [...head, ...tail];
}

/** rewrite / translate: replace the single validated target block in place. */
function replaceBlockOperations(anchor: string, blocks: readonly DocumentBlock[]): Operation[] {
  return blocks.map((block) => ({ type: "replace-block", targetBlockId: anchor, block }));
}

/** document-end: chain inserts from the anchor; the cursor stays confined to this function. */
function insertOperations(anchor: string | null, blocks: readonly DocumentBlock[]): Operation[] {
  const operations: Operation[] = [];
  let after = anchor;
  for (const block of blocks) {
    operations.push(insertOperation(block, after));
    after = block.attrs.blockId;
  }
  return operations;
}

/** Sole source of the blocks anchor; validateWritingRequest admits only one-entry blocks targets. */
function blocksAnchor(
  target: Extract<WritingInput["request"]["target"], { kind: "blocks" }>,
): string {
  const anchor = target.blocks.at(-1)?.blockId;
  if (!anchor) throw fail("UNSUPPORTED_TARGET"); // unreachable past validation; defensive fail-closed
  return anchor;
}

/**
 * Block identity reuse per target kind: document keeps the previous ids in order,
 * blocks reuses the target id, document-end allocates fresh deterministic ids.
 */
function reuseIdsFor(
  target: WritingInput["request"]["target"],
  previous: readonly DocumentBlock[],
): readonly string[] | undefined {
  switch (target.kind) {
    case "document":
      return previous.map((block) => block.attrs.blockId);
    case "blocks":
      return [blocksAnchor(target)];
    case "document-end":
      return undefined;
  }
}

/**
 * Operations plan driven solely by the target discriminated union, which the
 * validateWritingRequest intent ↔ target matrix keeps in lockstep with intent:
 * rewrite / translate ↔ blocks (exactly one entry), rewrite-document ↔ document,
 * every other intent ↔ document-end.
 */
function planOperations(
  target: WritingInput["request"]["target"],
  previous: readonly DocumentBlock[],
  blocks: readonly DocumentBlock[],
): { preconditions: { blockId: string }[]; operations: Operation[] } {
  switch (target.kind) {
    case "document":
      return {
        preconditions: previous.map((block) => ({ blockId: block.attrs.blockId })),
        operations: replaceDocumentOperations(previous, blocks),
      };
    case "blocks": {
      const anchor = blocksAnchor(target);
      return {
        preconditions: [{ blockId: anchor }],
        operations: replaceBlockOperations(anchor, blocks),
      };
    }
    case "document-end":
      return {
        preconditions: target.afterBlockId ? [{ blockId: target.afterBlockId }] : [],
        operations: insertOperations(target.afterBlockId, blocks),
      };
  }
}

export function compileProposal(
  input: WritingInput,
  outputValue: unknown,
  evidence: EvidenceBundle,
  options: CompilerOptions = {},
): WritingProposalPayload {
  const checked = WritingOutputSchema.safeParse(outputValue);
  if (!checked.success) throw fail("INVALID_OUTPUT");
  const output = checked.data,
    { request } = input;
  if (
    output.blocks.length > (request.constraints?.maxBlocks ?? 256) ||
    output.blocks.reduce((sum, block) => sum + block.text.length, 0) >
      (request.constraints?.maxCharacters ?? 100_000)
  )
    throw fail("INVALID_OUTPUT");
  const citations = resolveModelCitations(output.citations, evidence, options);
  if (request.intent === "research" && citations.length === 0) throw fail("INSUFFICIENT_EVIDENCE");
  // The matrix admits rewrite / translate only with a single-entry blocks target.
  if (request.target.kind === "blocks" && output.blocks.length !== 1) throw fail("INVALID_OUTPUT");
  const supportsMath = input.snapshot.schemaVersion >= MATHEMATICS_DOCUMENT_SCHEMA_VERSION;
  const idSeed = hashContent([input.threadId, input.runId]).slice(7);
  const blocks = compileBlocks(
    output,
    idSeed,
    supportsMath && request.target.kind !== "blocks",
    request.constraints?.maxBlocks ?? 256,
    reuseIdsFor(request.target, input.snapshot.content.content),
  );
  const proposal: WritingProposalPayload = {
    document: structuredClone(input.document),
    baseStructureRevision: input.baseStructureRevision,
    target: structuredClone(request.target),
    operationBatch: {
      operationId: `op_${idSeed.slice(0, 48)}`,
      documentId: input.document.documentId,
      generationId: input.document.generationId,
      origin: "ai-accept",
      ...planOperations(request.target, input.snapshot.content.content, blocks),
    },
    summary: output.summary,
    citations,
  };
  const validation = validateWritingProposalPayload(proposal, {
    request,
    document: input.document,
    baseStructureRevision: input.baseStructureRevision,
    snapshot: input.snapshot,
    evidence,
    artifactResolver: options.artifactResolver,
  });
  if (!validation.success)
    fail(validation.issues[0]?.code === "INVALID_CITATION" ? "INVALID_CITATION" : "INVALID_OUTPUT");
  return proposal;
}

/**
 * Compile the immutable draft of a create-draft Run. Block identities are deterministic in
 * (threadId, runId) so retries reuse the exact same content; no document exists yet.
 */
export function compileDraft(
  input: DraftInput,
  outputValue: unknown,
  evidence: EvidenceBundle,
  options: CompilerOptions & { schemaVersion: number },
): WritingDraftPayload {
  const checked = WritingOutputSchema.safeParse(outputValue);
  if (!checked.success) throw fail("INVALID_OUTPUT");
  const output = checked.data;
  if (
    output.blocks.length > 256 ||
    output.blocks.reduce((sum, block) => sum + block.text.length, 0) > 100_000 ||
    !input.threadId ||
    input.threadId.length > 512 ||
    !input.runId
  )
    throw fail("INVALID_OUTPUT");
  if (!validateEvidenceBundle(evidence).success) throw fail("INVALID_CITATION");
  const citations = resolveModelCitations(output.citations, evidence, options);
  const supportsMath = options.schemaVersion >= MATHEMATICS_DOCUMENT_SCHEMA_VERSION;
  const idSeed = hashContent([input.threadId, input.runId]).slice(7);
  const blocks = compileBlocks(output, idSeed, supportsMath, 256);
  const firstHeading = output.blocks.find((block) => block.type === "heading");
  const title = (input.title ?? firstHeading?.text ?? "AI 草稿").slice(0, 200);
  const content: DocumentContent = { type: "doc", content: blocks };
  const draft: WritingDraftPayload = {
    title,
    schemaVersion: options.schemaVersion,
    content,
    summary: output.summary,
    citations,
  };
  const validation = validateWritingDraftPayload(draft, {
    evidence,
    artifactResolver: options.artifactResolver,
  });
  if (!validation.success)
    fail(validation.issues[0]?.code === "INVALID_CITATION" ? "INVALID_CITATION" : "INVALID_OUTPUT");
  return draft;
}
