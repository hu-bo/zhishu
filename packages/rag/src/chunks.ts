import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { canonicalJson, type EvidenceItem } from "@zhishu/ai-contracts";
import { normalizeSource } from "./documents.js";
import { imageAtoms } from "./markdown.js";
import type { DocumentParseOptions, RagDocumentSource } from "./inputs.js";

export interface IndexOptions {
  collectionName: string;
  embeddingFingerprint: string;
  dimensions: number;
  metric: "cosine";
  normalizerVersion: string;
  chunkerVersion: string;
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  /** Must be an upper bound for the configured embedding tokenizer. Defaults to UTF-8 bytes. */
  countTokens?: (text: string) => number;
  onExtractionIssue?: (issue: { blockId: string; code: "NO_TEXT" | "UNSUPPORTED_NODE" }) => void;
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export const conservativeTokenCount = (text: string): number => Buffer.byteLength(text, "utf8");
export function validateIndexOptions(options: IndexOptions): void {
  if (
    !options.collectionName ||
    !options.embeddingFingerprint ||
    !options.normalizerVersion ||
    !options.chunkerVersion ||
    options.metric !== "cosine" ||
    !Number.isSafeInteger(options.dimensions) ||
    options.dimensions < 1 ||
    !Number.isSafeInteger(options.targetTokens) ||
    !Number.isSafeInteger(options.maxTokens) ||
    !Number.isSafeInteger(options.overlapTokens) ||
    options.targetTokens < 16 ||
    options.targetTokens > options.maxTokens ||
    options.overlapTokens < 0 ||
    options.overlapTokens >= options.targetTokens
  )
    throw new Error("INVALID_INDEX_OPTIONS");
}
export function configurationFingerprint(options: IndexOptions): string {
  validateIndexOptions(options);
  return digest([
    "rag-parser-v2",
    options.collectionName,
    options.embeddingFingerprint,
    options.dimensions,
    options.metric,
    options.normalizerVersion,
    options.chunkerVersion,
    options.targetTokens,
    options.maxTokens,
    options.overlapTokens,
  ]);
}
export function sourceSnapshotId(source: RagDocumentSource): string {
  if ("durableSeq" in source && !Number.isSafeInteger(source.durableSeq))
    throw new Error("UNSAFE_DURABLE_SEQ");
  return `snapshot_${digest(source)}`;
}

class SourceTextSplitter extends RecursiveCharacterTextSplitter {
  constructor(
    fields: ConstructorParameters<typeof RecursiveCharacterTextSplitter>[0],
    private readonly atoms: readonly string[],
  ) {
    super(fields);
  }
  override splitOnSeparator(text: string, separator: string): string[] {
    const pieces = separator ? super.splitOnSeparator(text, separator) : Array.from(text);
    const ranges: { start: number; end: number }[] = [];
    for (const atom of this.atoms) {
      let from = 0,
        start: number;
      while ((start = text.indexOf(atom, from)) >= 0) {
        ranges.push({ start, end: start + atom.length });
        from = start + atom.length;
      }
    }
    if (!ranges.length) return pieces;
    const result: string[] = [];
    let pending = "",
      offset = 0;
    for (const piece of pieces) {
      pending += piece;
      offset += piece.length;
      if (ranges.some((range) => range.start < offset && offset < range.end)) continue;
      result.push(pending);
      pending = "";
    }
    if (pending) result.push(pending);
    return result;
  }
}

/** Normalize once, upload/replace images, then split. Keep the returned blocks for exact source reads. */
export async function prepareDocument(
  source: RagDocumentSource,
  options: IndexOptions,
  parsing: DocumentParseOptions = {},
) {
  validateIndexOptions(options);
  const normalized = await normalizeSource(source, parsing, options.onExtractionIssue);
  const baseSnapshotId = sourceSnapshotId(source);
  const snapshotId = normalized.images.length
    ? `snapshot_${digest([baseSnapshotId, normalized.images])}`
    : baseSnapshotId;
  const count = (text: string): number => {
    const value = (options.countTokens ?? conservativeTokenCount)(text);
    if (!Number.isSafeInteger(value) || value < 0 || (text.length > 0 && value === 0))
      throw new Error("INVALID_TOKEN_COUNT");
    return value;
  };
  const chunks: EvidenceItem[] = [];
  for (const block of normalized.blocks) {
    parsing.signal?.throwIfAborted();
    const atoms = block.kind === "code" ? [] : imageAtoms(block.text);
    let title = Array.from(block.titlePath.join(" / ")).slice(0, 256).join("");
    while (title && count(`${title}\n`) > Math.min(128, Math.floor(options.maxTokens / 3)))
      title = Array.from(title).slice(0, -1).join("");
    const reserved = count(title ? `${title}\n` : "");
    const chunkSize = Math.min(options.targetTokens, options.maxTokens - reserved);
    if (chunkSize < 4) throw new Error("CONTEXT_BUDGET_EXCEEDED");
    if (atoms.some((atom) => count(atom) > chunkSize))
      throw new Error("IMAGE_EXCEEDS_CHUNK_BUDGET");
    const splitter = new SourceTextSplitter(
      {
        chunkSize,
        chunkOverlap: Math.min(options.overlapTokens, chunkSize - 1),
        lengthFunction: count,
        keepSeparator: true,
        separators:
          block.kind === "code" || block.kind === "table"
            ? ["\n", " ", ""]
            : ["\n\n", "\n", "。", "！", "？", "；", " ", ""],
      },
      atoms,
    );
    let previousStart = -1;
    for (const part of await splitter.splitText(block.text)) {
      const start = block.text.indexOf(part, previousStart + 1),
        end = start + part.length;
      if (
        start < 0 ||
        count(part) + reserved > options.maxTokens ||
        (start > 0 && /[\uDC00-\uDFFF]/.test(block.text[start]!)) ||
        /[\uD800-\uDBFF]/.test(block.text[end - 1]!)
      )
        throw new Error("UNMAPPABLE_CHUNK");
      previousStart = start;
      chunks.push({
        evidenceId: `ev_${digest([snapshotId, block.id, start, end])}`,
        source: {
          sourceId: normalized.sourceId,
          snapshotId,
          locator:
            block.locatorKind === "block"
              ? { kind: "block", blockId: block.id, start, end }
              : { kind: "section", sectionId: block.id, start, end },
        },
        title,
        text: part,
      });
    }
  }
  parsing.signal?.throwIfAborted();
  return {
    sourceId: normalized.sourceId,
    snapshotId,
    text: normalized.blocks.map((block) => block.text).join("\n\n"),
    blocks: normalized.blocks.map(({ id, locatorKind, text }) => ({ id, locatorKind, text })),
    chunks: chunks as readonly EvidenceItem[],
    images: normalized.images,
  };
}

export async function prepareDocumentChunks(
  source: RagDocumentSource,
  options: IndexOptions,
  parsing?: DocumentParseOptions,
): Promise<readonly EvidenceItem[]> {
  return (await prepareDocument(source, options, parsing)).chunks;
}
