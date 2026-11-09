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
} from "@zhishu/document-contracts";
import {
  canonicalJson,
  validateAiTaskRequest,
  validateAuthoringProposal,
  validateEvidenceBundle,
  type AuthoringProposal,
  type EvidenceBundle,
  type SourceCitation,
} from "@zhishu/ai-contracts";
import type { WritingInput, CompilerOptions } from "./types.js";
import { fail } from "../errors.js";

export const hashContent = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
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
export const AuthoringOutputSchema = z
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
export type AuthoringOutput = z.infer<typeof AuthoringOutputSchema>;

type OutputBlock = AuthoringOutput["blocks"][number];
type DraftBlock = OutputBlock | { type: "blockMath"; text: string };
type Paragraph = Extract<DocumentBlock, { type: "paragraph" }>;

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

export function validateInput(input: WritingInput, options: CompilerOptions): void {
  const { request, snapshot } = input;
  const checked = validateAiTaskRequest(request);
  if (!checked.success)
    fail(
      checked.issues.some((issue) => issue.code === "UNSUPPORTED_TARGET")
        ? "UNSUPPORTED_TARGET"
        : "INVALID_OUTPUT",
    );
  if (
    !input.threadId ||
    input.threadId.length > 512 ||
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
    !("generationId" in snapshot) ||
    snapshot.generationId !== request.document.generationId ||
    snapshot.documentId !== request.document.documentId ||
    snapshot.durableSeq !== request.document.durableSeq ||
    !Number.isSafeInteger(snapshot.durableSeq) ||
    hashContent(snapshot.content) !== request.document.contentHash ||
    input.structureRevision !== request.baseStructureRevision ||
    !Number.isSafeInteger(input.structureRevision)
  )
    fail("TARGET_CONFLICT");
  if (!validateEvidenceBundle(input.evidence ?? { freshness: "current", items: [] }).success)
    fail("INVALID_CITATION");
  if (request.target.kind === "selection") fail("UNSUPPORTED_TARGET");
  if (request.target.kind === "document") {
    if (request.intent !== "rewrite-document" || snapshot.content.content.length > 256)
      fail("UNSUPPORTED_TARGET");
  } else if (request.target.kind === "document-end") {
    if ((snapshot.content.content.at(-1)?.attrs.blockId ?? null) !== request.target.afterBlockId)
      fail("TARGET_CONFLICT");
  } else {
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
    if (
      ["rewrite", "translate"].includes(request.intent) &&
      !["paragraph", "heading"].includes(snapshot.content.content[previous]!.type)
    )
      fail("UNSUPPORTED_TARGET");
  }
  if (request.intent === "research" && !options.researchAvailable) fail("INSUFFICIENT_EVIDENCE");
}
export function compileProposal(
  input: WritingInput,
  outputValue: unknown,
  evidence: EvidenceBundle,
): AuthoringProposal {
  const checked = AuthoringOutputSchema.safeParse(outputValue);
  if (!checked.success) fail("INVALID_OUTPUT");
  const output = checked.data,
    { request } = input;
  if (
    output.blocks.length > (request.constraints?.maxBlocks ?? 256) ||
    output.blocks.reduce((sum, block) => sum + block.text.length, 0) >
      (request.constraints?.maxCharacters ?? 100_000)
  )
    fail("INVALID_OUTPUT");
  const evidenceById = new Map(evidence.items.map((item) => [item.evidenceId, item]));
  const citations: SourceCitation[] = output.citations.map((citation, index) => {
    const item = evidenceById.get(citation.evidenceId);
    if (!item || !item.text.includes(citation.quote)) fail("INVALID_CITATION");
    const source = structuredClone(item.source);
    if (source.locator.kind !== "page") {
      source.locator.start += item.text.indexOf(citation.quote);
      source.locator.end = source.locator.start + citation.quote.length;
    }
    return { citationId: `citation_${index + 1}`, source, quote: citation.quote };
  });
  if (request.intent === "research" && citations.length === 0) fail("INSUFFICIENT_EVIDENCE");
  const replacing = request.intent === "rewrite" || request.intent === "translate";
  const replacingDocument = request.intent === "rewrite-document";
  if (replacing && output.blocks.length !== 1) fail("INVALID_OUTPUT");
  const supportsMath = input.snapshot.schemaVersion >= MATHEMATICS_DOCUMENT_SCHEMA_VERSION;
  const expandedBlocks =
    supportsMath && !replacing ? output.blocks.flatMap(splitDisplayMath) : output.blocks;
  const draftBlocks =
    expandedBlocks.length <= (request.constraints?.maxBlocks ?? 256)
      ? expandedBlocks
      : output.blocks;
  if (request.target.kind === "selection") fail("UNSUPPORTED_TARGET");
  let afterBlockId =
    request.target.kind === "document"
      ? null
      : request.target.kind === "document-end"
        ? request.target.afterBlockId
        : request.target.blocks.at(-1)!.blockId;
  const anchor = afterBlockId;
  const idSeed = hashContent([input.threadId, request.requestId]).slice(7);
  const blocks = draftBlocks.map((block, index): DocumentBlock => {
    const blockId =
      replacingDocument && input.snapshot.content.content[index]
        ? input.snapshot.content.content[index]!.attrs.blockId
        : replacing
          ? anchor!
          : `block_${createHash("sha256").update(`${idSeed}:${index}`).digest("hex").slice(0, 48)}`;
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
  const proposal: AuthoringProposal = {
    proposalId: `proposal_${idSeed.slice(0, 48)}`,
    requestId: request.requestId,
    document: structuredClone(request.document),
    target: structuredClone(request.target),
    baseStructureRevision: request.baseStructureRevision,
    operationBatch: {
      operationId: `op_${idSeed.slice(0, 48)}`,
      documentId: request.document.documentId,
      generationId: request.document.generationId,
      origin: "ai-accept",
      preconditions: replacingDocument
        ? input.snapshot.content.content.map((block) => ({ blockId: block.attrs.blockId }))
        : anchor
          ? [{ blockId: anchor }]
          : [],
      operations: replacingDocument
        ? [
            ...input.snapshot.content.content.map((old, index) => {
              const block = blocks[index];
              return block
                ? { type: "replace-block" as const, targetBlockId: old.attrs.blockId, block }
                : { type: "delete-block" as const, targetBlockId: old.attrs.blockId };
            }),
            ...blocks.slice(input.snapshot.content.content.length).map((block, index) => {
              const previous = blocks[input.snapshot.content.content.length + index - 1];
              return {
                type: "insert-block" as const,
                parentBlockId: null,
                ...(previous ? { afterBlockId: previous.attrs.blockId } : {}),
                block,
              };
            }),
          ]
        : blocks.map((block) => {
            if (replacing) return { type: "replace-block" as const, targetBlockId: anchor!, block };
            const operation = {
              type: "insert-block" as const,
              parentBlockId: null,
              ...(afterBlockId ? { afterBlockId } : {}),
              block,
            };
            afterBlockId = block.attrs.blockId;
            return operation;
          }),
    },
    summary: output.summary,
    citations,
  };
  if (!validateAuthoringProposal(proposal, { request, snapshot: input.snapshot, evidence }).success)
    fail("INVALID_OUTPUT");
  return proposal;
}
