import type { JSONContent } from "@tiptap/core";
import { DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS } from "@zhishu/document-contracts";

export interface DocumentStatistics {
  /** Word-like segments from Intl.Segmenter, with a Unicode fallback. */
  wordCount: number;
  /** Non-whitespace grapheme clusters, including emoji and code. */
  characterCount: number;
  /** Rounded up using the configured word-per-minute estimate. */
  readingTimeMinutes: number;
}

export interface DocumentStatisticsOptions {
  wordsPerMinute?: number;
  locale?: string;
}

type SegmenterConstructor = new (
  locales?: string | readonly string[],
  options?: { granularity: "word" | "grapheme" },
) => {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
};

const inlineNodeTypes = new Set(["link", "hardBreak"]);
const segmenterCache = new Map<string, InstanceType<SegmenterConstructor>>();

function getSegmenter(
  locale: string,
  granularity: "word" | "grapheme",
): InstanceType<SegmenterConstructor> | undefined {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (!Segmenter) return undefined;
  const key = `${locale}:${granularity}`;
  const cached = segmenterCache.get(key);
  if (cached) return cached;
  const segmenter = new Segmenter(locale, { granularity });
  segmenterCache.set(key, segmenter);
  return segmenter;
}

function collectText(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectText(child, output);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  const node = value as {
    type?: unknown;
    text?: unknown;
    content?: unknown;
    attrs?: Record<string, unknown>;
  };
  if (node.type === "statusTag") {
    const status = DOCUMENT_STATUSES.find((entry) => entry === node.attrs?.status) ?? "todo";
    output.push(DOCUMENT_STATUS_LABELS[status]);
    return;
  }
  if (node.type === "horizontalRule" && typeof node.attrs?.label === "string") {
    output.push(`\n${node.attrs.label}\n`);
    return;
  }
  if (node.type === "text" && typeof node.text === "string") {
    output.push(node.text);
    return;
  }
  if (node.type === "hardBreak") {
    output.push("\n");
    return;
  }

  if (!Array.isArray(node.content)) return;
  const isBlock = typeof node.type === "string" && !inlineNodeTypes.has(node.type);
  if (isBlock) output.push("\n");
  collectText(node.content, output);
  if (isBlock) output.push("\n");
}

function countCharacters(text: string, locale: string): number {
  const segmenter = getSegmenter(locale, "grapheme");
  if (segmenter) {
    let count = 0;
    for (const { segment } of segmenter.segment(text)) {
      if (!/^\s+$/u.test(segment)) count += 1;
    }
    return count;
  }

  return Array.from(text).filter((character) => !/^\s+$/u.test(character)).length;
}

function countWords(text: string, locale: string): number {
  const segmenter = getSegmenter(locale, "word");
  if (segmenter) {
    let count = 0;
    for (const segment of segmenter.segment(text)) {
      if (segment.isWordLike) count += 1;
    }
    return count;
  }

  return Array.from(
    text.matchAll(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu,
    ),
  ).length;
}

export function calculateDocumentStatistics(
  content: unknown,
  options: DocumentStatisticsOptions = {},
): DocumentStatistics {
  const locale = options.locale ?? "zh-Hans";
  const wordsPerMinute = options.wordsPerMinute ?? 300;
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) {
    throw new RangeError("wordsPerMinute must be a positive finite number.");
  }

  const textParts: string[] = [];
  const document = content as JSONContent | undefined;
  collectText(document?.content ?? content, textParts);
  const text = textParts.join("");
  const wordCount = countWords(text, locale);

  return {
    wordCount,
    characterCount: countCharacters(text, locale),
    readingTimeMinutes: wordCount === 0 ? 0 : Math.ceil(wordCount / wordsPerMinute),
  };
}
