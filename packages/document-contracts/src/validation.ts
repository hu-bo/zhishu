import { Value } from "@sinclair/typebox/value";
import { DocumentBlockSchema, DocumentContentSchema } from "./schema.js";
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
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "horizontalRule",
  "image",
]);
const blockContentTypes = new Set([...blockTypes].filter((type) => type !== "listItem"));
const allowedTypes = new Set(["doc", ...blockTypes, "text", "hardBreak"]);
const blockChildren: Record<string, ReadonlySet<string>> = {
  doc: blockContentTypes,
  blockquote: blockContentTypes,
  bulletList: new Set(["listItem"]),
  orderedList: new Set(["listItem"]),
  listItem: new Set([...blockTypes].filter((type) => type !== "listItem")),
};
const inlineParents = new Set(["paragraph", "heading"]);

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
          inlineParents.has(parentType) && ["text", "hardBreak"].includes(record.type);
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

  const references = [DocumentBlockSchema];
  if (!Value.Check(DocumentContentSchema, references, input)) {
    const schemaIssues = [...Value.Errors(DocumentContentSchema, references, input)].map((error) =>
      issue("invalid-content", error.path || "$", error.message),
    );
    return { success: false, issues: schemaIssues };
  }

  return { success: true, data: input as DocumentContent };
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
    }
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return content;
}
