import { Value } from "@sinclair/typebox/value";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  CALLOUT_DOCUMENT_SCHEMA_VERSION,
  DocumentBlockSchema,
  DocumentContentSchema,
  SUPPORTED_DOCUMENT_SCHEMA_VERSIONS,
  TABLE_DOCUMENT_SCHEMA_VERSION,
  TASK_LIST_DOCUMENT_SCHEMA_VERSION,
  TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION,
  TableCellSchema,
  TableHeaderSchema,
  TableRowSchema,
  TableSchema,
  TaskListSchema,
} from "./schema.js";
import type { DocumentContent } from "./schema.js";

export type ContentIssueCode =
  "invalid-content" | "unknown-extension" | "duplicate-block-id" | "limit-exceeded";

export interface ContentIssue {
  code: ContentIssueCode;
  path: string;
  message: string;
  recoverable: boolean;
}

export type ContentValidationResult =
  { success: true; data: DocumentContent } | { success: false; issues: ContentIssue[] };

export interface ContentLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

const defaultLimits: Required<ContentLimits> = {
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 20_000,
};

const blockTypes = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "callout",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "horizontalRule",
  "image",
  "pdfAttachment",
  "table",
]);
const blockContentTypes = new Set([...blockTypes].filter((type) => type !== "listItem"));
const tableTypes = new Set(["table", "tableRow", "tableCell", "tableHeader"]);
const allowedTypes = new Set([
  "doc",
  ...blockTypes,
  ...tableTypes,
  "text",
  "hardBreak",
  "statusTag",
]);
const blockChildren: Record<string, ReadonlySet<string>> = {
  doc: blockContentTypes,
  blockquote: blockContentTypes,
  callout: blockContentTypes,
  bulletList: new Set(["listItem"]),
  orderedList: new Set(["listItem"]),
  listItem: new Set([...blockTypes].filter((type) => type !== "listItem")),
  taskList: new Set(["taskItem", "taskList"]),
  table: new Set(["tableRow"]),
  tableRow: new Set(["tableCell", "tableHeader"]),
  tableCell: new Set(["paragraph"]),
  tableHeader: new Set(["paragraph"]),
};
const inlineParents = new Set(["paragraph", "heading", "taskItem"]);

function issue(
  code: ContentIssueCode,
  path: string,
  message: string,
  recoverable = true,
): ContentIssue {
  return { code, path, message, recoverable };
}

function preflight(input: unknown, limits: Required<ContentLimits>): ContentIssue[] {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return [issue("invalid-content", "$", "Content must be JSON serializable.")];
  }
  if (serialized === undefined)
    return [issue("invalid-content", "$", "Content must be a JSON value.")];
  if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes)
    return [issue("limit-exceeded", "$", `Content exceeds ${limits.maxBytes} bytes.`)];

  const issues: ContentIssue[] = [];
  const seenBlockIds = new Set<string>();
  const stack: Array<{
    value: unknown;
    path: string;
    depth: number;
    parentType?: string;
  }> = [{ value: input, path: "$", depth: 0 }];
  let nodeCount = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { value, path, depth, parentType } = current;
    if (depth > limits.maxDepth) {
      issues.push(issue("limit-exceeded", path, `Content exceeds depth ${limits.maxDepth}.`));
      break;
    }
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], path: `${path}/${index}`, depth: depth + 1, parentType });
      }
      continue;
    }

    const record = value as Record<string, unknown>;
    if (typeof record.type === "string") {
      nodeCount += 1;
      if (!allowedTypes.has(record.type)) {
        issues.push(
          issue("unknown-extension", `${path}/type`, `Unsupported node type "${record.type}".`),
        );
      }
      if (parentType) {
        const validBlockChild = blockChildren[parentType]?.has(record.type) ?? false;
        const validInlineChild =
          inlineParents.has(parentType) && ["text", "hardBreak", "statusTag"].includes(record.type);
        const validCodeChild = parentType === "codeBlock" && record.type === "text";
        if (!validBlockChild && !validInlineChild && !validCodeChild) {
          issues.push(
            issue(
              "invalid-content",
              path,
              `Node "${record.type}" is not allowed inside "${parentType}".`,
            ),
          );
        }
      }
      if (record.type === "codeBlock" && Array.isArray(record.content)) {
        for (const child of record.content) {
          if (
            typeof child === "object" &&
            child !== null &&
            "marks" in child &&
            (child as { marks?: unknown }).marks !== undefined
          ) {
            issues.push(
              issue("invalid-content", `${path}/content`, "Code text cannot have marks."),
            );
          }
        }
      }
      if (record.type === "table" && Array.isArray(record.content)) {
        const rows = record.content;
        const boundedRowCount = Math.min(rows.length, 100);
        const occupied = Array.from({ length: boundedRowCount }, () => [] as boolean[]);
        let invalidTableShape = rows.length === 0 || rows.length > 100;

        for (let rowIndex = 0; rowIndex < boundedRowCount; rowIndex += 1) {
          const row = rows[rowIndex];
          if (typeof row !== "object" || row === null || Array.isArray(row)) {
            invalidTableShape = true;
            continue;
          }
          const cells = (row as Record<string, unknown>).content;
          if (!Array.isArray(cells) || cells.length === 0 || cells.length > 20) {
            invalidTableShape = true;
            continue;
          }

          let columnIndex = 0;
          for (const cell of cells) {
            if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
              invalidTableShape = true;
              continue;
            }
            const cellRecord = cell as Record<string, unknown>;
            if (cellRecord.type !== "tableCell" && cellRecord.type !== "tableHeader") {
              invalidTableShape = true;
              continue;
            }
            while (occupied[rowIndex]?.[columnIndex] === true) columnIndex += 1;

            const attrs =
              typeof cellRecord.attrs === "object" &&
              cellRecord.attrs !== null &&
              !Array.isArray(cellRecord.attrs)
                ? (cellRecord.attrs as Record<string, unknown>)
                : {};
            const colspan = attrs.colspan ?? 1;
            const rowspan = attrs.rowspan ?? 1;
            const colwidth = attrs.colwidth;
            if (
              !Number.isSafeInteger(colspan) ||
              !Number.isSafeInteger(rowspan) ||
              (colwidth !== null &&
                colwidth !== undefined &&
                (!Array.isArray(colwidth) || colwidth.length !== colspan))
            ) {
              invalidTableShape = true;
              continue;
            }

            const spanColumns = colspan as number;
            const spanRows = rowspan as number;
            if (
              spanColumns < 1 ||
              spanColumns > 20 ||
              spanRows < 1 ||
              spanRows > 100 ||
              rowIndex + spanRows > boundedRowCount ||
              columnIndex + spanColumns > 20
            ) {
              invalidTableShape = true;
              continue;
            }

            for (let spanRow = rowIndex; spanRow < rowIndex + spanRows; spanRow += 1) {
              const rowSlots = occupied[spanRow];
              if (!rowSlots) {
                invalidTableShape = true;
                break;
              }
              for (
                let spanColumn = columnIndex;
                spanColumn < columnIndex + spanColumns;
                spanColumn += 1
              ) {
                if (rowSlots[spanColumn]) invalidTableShape = true;
                rowSlots[spanColumn] = true;
              }
            }
            columnIndex += spanColumns;
          }
        }

        const columnCount = occupied.reduce(
          (maximum, rowSlots) => Math.max(maximum, rowSlots.length),
          0,
        );
        if (
          columnCount < 1 ||
          columnCount > 20 ||
          occupied.some(
            (rowSlots) =>
              rowSlots.length !== columnCount || rowSlots.some((occupiedCell) => !occupiedCell),
          )
        ) {
          invalidTableShape = true;
        }
        if (invalidTableShape) {
          issues.push(
            issue(
              "invalid-content",
              `${path}/content`,
              "Tables must form a rectangular grid with 1 to 100 rows and 1 to 20 columns.",
            ),
          );
        }
      }
      if (
        blockTypes.has(record.type) &&
        typeof record.attrs === "object" &&
        record.attrs !== null
      ) {
        const id = (record.attrs as Record<string, unknown>).blockId;
        if (typeof id === "string") {
          if (seenBlockIds.has(id))
            issues.push(
              issue("duplicate-block-id", `${path}/attrs/blockId`, "Block IDs must be unique."),
            );
          seenBlockIds.add(id);
        }
      }
    }

    if (nodeCount > limits.maxNodes) {
      issues.push(issue("limit-exceeded", path, `Content exceeds ${limits.maxNodes} nodes.`));
      break;
    }
    if (Array.isArray(record.content)) {
      const type = typeof record.type === "string" ? record.type : undefined;
      for (let index = record.content.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: record.content[index],
          path: `${path}/content/${index}`,
          depth: depth + 1,
          parentType: type,
        });
      }
    }
  }
  return issues;
}

export function validateDocumentContent(
  input: unknown,
  overrides: ContentLimits = {},
): ContentValidationResult {
  const limits = { ...defaultLimits, ...overrides };
  const preflightIssues = preflight(input, limits);
  if (preflightIssues.length > 0) return { success: false, issues: preflightIssues };

  const references = [
    DocumentBlockSchema,
    TaskListSchema,
    TableSchema,
    TableRowSchema,
    TableCellSchema,
    TableHeaderSchema,
  ];
  if (!Value.Check(DocumentContentSchema, references, input)) {
    const schemaIssues = [...Value.Errors(DocumentContentSchema, references, input)].map((error) =>
      issue("invalid-content", error.path || "$", error.message),
    );
    return { success: false, issues: schemaIssues };
  }

  return { success: true, data: input as DocumentContent };
}

export function validateDocumentContentForSchemaVersion(
  input: unknown,
  schemaVersion: number,
  overrides: ContentLimits = {},
): ContentValidationResult {
  if (!SUPPORTED_DOCUMENT_SCHEMA_VERSIONS.some((version) => version === schemaVersion)) {
    return {
      success: false,
      issues: [
        issue(
          "invalid-content",
          "$/schemaVersion",
          `Unsupported document schema version ${schemaVersion}.`,
          false,
        ),
      ],
    };
  }

  const validation = validateDocumentContent(input, overrides);
  if (!validation.success || schemaVersion === CURRENT_DOCUMENT_SCHEMA_VERSION) return validation;

  const pending: Array<{ value: unknown; path: string }> = [{ value: input, path: "$" }];
  const issues: ContentIssue[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const { value, path } = current;
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((child, index) => pending.push({ value: child, path: `${path}/${index}` }));
      continue;
    }

    const record = value as Record<string, unknown>;
    const attrs =
      typeof record.attrs === "object" && record.attrs !== null && !Array.isArray(record.attrs)
        ? (record.attrs as Record<string, unknown>)
        : undefined;
    if (
      schemaVersion < CALLOUT_DOCUMENT_SCHEMA_VERSION &&
      (record.type === "callout" ||
        record.type === "statusTag" ||
        (record.type === "horizontalRule" &&
          typeof attrs?.label === "string" &&
          attrs.label.length > 0))
    ) {
      issues.push(
        issue(
          "unknown-extension",
          path,
          `Callouts, status tags, and labeled dividers require document schema version ${CALLOUT_DOCUMENT_SCHEMA_VERSION}.`,
        ),
      );
    }
    if (schemaVersion < TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION) {
      if (
        (record.type === "paragraph" || record.type === "heading") &&
        attrs?.align !== undefined
      ) {
        issues.push(
          issue(
            "unknown-extension",
            `${path}/attrs/align`,
            `Text alignment requires document schema version ${TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION}.`,
            false,
          ),
        );
      }
      if (Array.isArray(record.marks)) {
        record.marks.forEach((mark, index) => {
          if (typeof mark !== "object" || mark === null || Array.isArray(mark)) return;
          const markType = (mark as Record<string, unknown>).type;
          if (markType === "underline" || markType === "highlight") {
            issues.push(
              issue(
                "unknown-extension",
                `${path}/marks/${index}/type`,
                `${markType} formatting requires document schema version ${TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION}.`,
                false,
              ),
            );
          }
        });
      }
    }
    if (record.type === "taskList" && schemaVersion < TASK_LIST_DOCUMENT_SCHEMA_VERSION) {
      issues.push(
        issue(
          "unknown-extension",
          `${path}/type`,
          `Task lists require document schema version ${TASK_LIST_DOCUMENT_SCHEMA_VERSION}.`,
          false,
        ),
      );
    }
    if (
      typeof record.type === "string" &&
      tableTypes.has(record.type) &&
      schemaVersion < TABLE_DOCUMENT_SCHEMA_VERSION
    ) {
      issues.push(
        issue(
          "unknown-extension",
          `${path}/type`,
          `Tables require document schema version ${TABLE_DOCUMENT_SCHEMA_VERSION}.`,
          false,
        ),
      );
    }
    if (Array.isArray(record.content)) {
      record.content.forEach((child, index) =>
        pending.push({ value: child, path: `${path}/content/${index}` }),
      );
    }
  }
  return issues.length > 0 ? { success: false, issues } : validation;
}

export function assertDocumentContent(input: unknown): asserts input is DocumentContent {
  const result = validateDocumentContent(input);
  if (!result.success) {
    const firstIssue = result.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid document content.",
    );
  }
}

export function normalizeDocumentContent(input: unknown): DocumentContent {
  const result = validateDocumentContent(input);
  if (!result.success) {
    const firstIssue = result.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid document content.",
    );
  }

  const content = structuredClone(result.data);
  const stack: unknown[] = [content];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    const attrs = node.attrs;
    if (typeof attrs === "object" && attrs !== null) {
      const mutableAttrs = attrs as Record<string, unknown>;
      if (node.type === "heading" && mutableAttrs.level === undefined) mutableAttrs.level = 1;
      if (node.type === "orderedList" && mutableAttrs.start === undefined) mutableAttrs.start = 1;
      if (node.type === "taskItem" && mutableAttrs.checked === undefined)
        mutableAttrs.checked = false;
    }
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.map((mark) => {
        if (typeof mark !== "object" || mark === null || Array.isArray(mark)) return mark;
        const inlineMark = mark as Record<string, unknown>;
        if (
          inlineMark.type !== "link" ||
          typeof inlineMark.href !== "string" ||
          inlineMark.attrs !== undefined
        ) {
          return mark;
        }
        const { href, ...legacyLink } = inlineMark;
        return { ...legacyLink, attrs: { href } };
      });
    }
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return content;
}
