import { parse as parseCsv } from "csv-parse/sync";
import {
  DOCUMENT_STATUS_LABELS,
  validateDocumentSnapshot,
  type DocumentSnapshot,
} from "@zhishu/document-contracts";
import type { Root, RootContent, Table } from "mdast";
import { createImageProcessor } from "./images.js";
import { parseHtml, parseMarkdown, replaceMarkdownImages, serializeMarkdown } from "./markdown.js";
import {
  parseLimits,
  type DocumentParseOptions,
  type NormalizedBlock,
  type NormalizedDocument,
  type RagDocumentSource,
} from "./inputs.js";

type NativeNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: NativeNode[];
};
const inlineText = (node: NativeNode): string =>
  node.type === "text"
    ? (node.text ?? "")
    : node.type === "hardBreak"
      ? "\n"
      : node.type === "statusTag"
        ? (DOCUMENT_STATUS_LABELS[node.attrs?.status as keyof typeof DOCUMENT_STATUS_LABELS] ?? "")
        : (node.content ?? []).map(inlineText).join("");
const mdastText = (node: RootContent): string =>
  "value" in node
    ? String(node.value)
    : "alt" in node
      ? (node.alt ?? "")
      : "children" in node
        ? node.children.map((child) => mdastText(child as RootContent)).join(" ")
        : "";
const serialize = (node: RootContent): string =>
  serializeMarkdown({ type: "root", children: [node] });
function tableNode(rows: readonly (readonly string[])[]): Table {
  return {
    type: "table",
    children: rows.map((row) => ({
      type: "tableRow",
      children: row.map((value) => ({
        type: "tableCell",
        children: [{ type: "text", value: value.replace(/\r?\n/g, " ⏎ ") }],
      })),
    })),
  };
}

function nativeTable(node: NativeNode): Table {
  const grid: string[][] = [];
  for (const [rowIndex, row] of (node.content ?? []).entries()) {
    grid[rowIndex] ??= [];
    let column = 0;
    for (const cell of row.content ?? []) {
      while (grid[rowIndex]![column] !== undefined) column++;
      const value = (cell.content ?? []).map(inlineText).join("\n");
      const rowSpan = Number(cell.attrs?.rowspan ?? 1),
        colSpan = Number(cell.attrs?.colspan ?? 1);
      for (let r = 0; r < rowSpan; r++) {
        grid[rowIndex + r] ??= [];
        for (let c = 0; c < colSpan; c++) grid[rowIndex + r]![column + c] = value;
      }
      column += colSpan;
    }
  }
  if (!node.content?.[0]?.content?.some((cell) => cell.type === "tableHeader"))
    grid.unshift(grid[0]!.map((_cell, index) => `列 ${index + 1}`));
  return tableNode(grid);
}

export async function normalizeSource(
  source: RagDocumentSource,
  options: DocumentParseOptions,
  onIssue?: (issue: { blockId: string; code: "NO_TEXT" | "UNSUPPORTED_NODE" }) => void,
): Promise<NormalizedDocument> {
  const limits = parseLimits(options),
    signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(source)) > limits.maxInputBytes)
    throw new Error("DOCUMENT_TOO_LARGE");
  const sourceId = "format" in source ? source.sourceId : source.documentId;
  if (
    typeof sourceId !== "string" ||
    !sourceId ||
    sourceId.length > 160 ||
    ("format" in source &&
      (typeof source.content !== "string" || (source.title && source.title.length > 512)))
  )
    throw new Error("INVALID_DOCUMENT_SOURCE");
  const processor = createImageProcessor(sourceId, { ...options, signal }),
    blocks: NormalizedBlock[] = [];
  const headings: string[] = [];
  const append = (block: NormalizedBlock): void => {
    if (block.text.trim()) blocks.push(block);
    else onIssue?.({ blockId: block.id, code: "NO_TEXT" });
  };
  if (!("format" in source)) {
    if (
      !validateDocumentSnapshot(source).success ||
      ("durableSeq" in source && !Number.isSafeInteger(source.durableSeq))
    )
      throw new Error("INVALID_SNAPSHOT");
    const visit = async (node: NativeNode, context: string[], depth = 0): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 64) throw new Error("DOCUMENT_TOO_DEEP");
      const blockId = node.attrs?.blockId;
      if (node.type === "table" && typeof blockId === "string") {
        const table = nativeTable(node);
        const headers = table.children[0]!.children.map(mdastText).join(" | ");
        append({
          id: blockId,
          locatorKind: "block",
          kind: "table",
          titlePath: [...headings.filter(Boolean), ...context, `表头：${headers}`],
          text: serialize(table),
        });
        return;
      }
      if (
        typeof blockId === "string" &&
        [
          "paragraph",
          "heading",
          "codeBlock",
          "taskItem",
          "image",
          "pdfAttachment",
          "horizontalRule",
        ].includes(node.type)
      ) {
        let text =
          node.type === "image"
            ? String(node.attrs?.alt ?? "")
            : node.type === "pdfAttachment"
              ? String(node.attrs?.fileName ?? "")
              : node.type === "horizontalRule"
                ? String(node.attrs?.label ?? "")
                : inlineText(node);
        if (node.type === "image" && options.imageStorage) {
          const assetId = String(node.attrs?.assetId ?? "");
          const url = await processor.replace(`asset:${assetId}`, assetId);
          text = serialize({ type: "paragraph", children: [{ type: "image", url, alt: text }] });
        }
        if (node.type === "heading") {
          const level = Number(node.attrs?.level ?? 1);
          headings.splice(level - 1);
          headings[level - 1] = text;
        }
        append({
          id: blockId,
          locatorKind: "block",
          kind: node.type === "codeBlock" ? "code" : node.type === "image" ? "image" : "text",
          titlePath: [...headings.filter(Boolean), ...context],
          text,
        });
        return;
      }
      const next =
        node.type === "orderedList"
          ? [...context, "有序列表"]
          : node.type === "bulletList"
            ? [...context, "无序列表"]
            : context;
      if (!node.content?.length && typeof blockId === "string")
        onIssue?.({ blockId, code: "UNSUPPORTED_NODE" });
      for (const child of node.content ?? []) await visit(child, next, depth + 1);
    };
    for (const node of (source as DocumentSnapshot).content.content)
      await visit(node as NativeNode, []);
  } else {
    let tree: Root;
    if (source.format === "csv") {
      if (
        source.delimiter !== undefined &&
        (source.delimiter.length !== 1 || ["\r", "\n", '"', "\0"].includes(source.delimiter))
      )
        throw new Error("INVALID_CSV_DELIMITER");
      let rowCount = 0;
      let rows: string[][];
      try {
        rows = parseCsv(source.content, {
          bom: true,
          delimiter: source.delimiter ?? ",",
          columns: false,
          skip_empty_lines: true,
          max_record_size: Math.min(limits.maxInputBytes, 1_048_576),
          on_record(record: string[]) {
            if (++rowCount > limits.maxRows || record.length > limits.maxColumns)
              throw new Error("CSV_LIMIT_EXCEEDED");
            return record;
          },
        }) as string[][];
      } catch (error) {
        if (error instanceof Error && error.message === "CSV_LIMIT_EXCEEDED") throw error;
        throw new Error("INVALID_CSV");
      }
      if (!rows.length) return { sourceId, blocks: [], images: [] };
      if (source.hasHeader === false)
        rows.unshift(rows[0]!.map((_cell, index) => `列 ${index + 1}`));
      tree = { type: "root", children: [tableNode(rows)] };
      // Image markup embedded in a CSV cell is parsed before the table serializer escapes it.
      for (const row of (tree.children[0] as Table).children) {
        for (const cell of row.children) {
          const raw = mdastText(cell),
            parsed = parseMarkdown(raw);
          await replaceMarkdownImages(parsed, processor);
          const paragraph = parsed.children[0];
          if (parsed.children.length === 1 && paragraph?.type === "paragraph")
            cell.children = paragraph.children;
        }
      }
    } else
      tree =
        source.format === "markdown"
          ? parseMarkdown(source.content)
          : source.format === "html"
            ? parseHtml(source.content)
            : (() => {
                throw new Error("UNSUPPORTED_DOCUMENT_FORMAT");
              })();
    if (source.format !== "csv") await replaceMarkdownImages(tree, processor);
    for (const [index, node] of tree.children.entries()) {
      signal.throwIfAborted();
      if (node.type === "definition") continue;
      if (node.type === "heading") {
        headings.splice(node.depth - 1);
        headings[node.depth - 1] = mdastText(node);
      }
      const table = node.type === "table";
      append({
        id: `section_${index + 1}`,
        locatorKind: "section",
        kind: table ? "table" : node.type === "code" ? "code" : "text",
        titlePath: [
          source.title ?? "",
          ...headings.filter(Boolean),
          ...(table ? [`表头：${node.children[0]!.children.map(mdastText).join(" | ")}`] : []),
        ].filter(Boolean),
        text: serialize(node),
      });
    }
  }
  signal.throwIfAborted();
  return { sourceId, blocks, images: processor.images };
}
