import { getSchema, type Extensions, type JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { validateDocumentContent } from "@zhishu/document-contracts";
import type { ContentIssue, DocumentContent } from "@zhishu/document-contracts";
import { createBaseEditorExtensions, type BaseEditorExtensionsOptions } from "./extensions.js";

export interface EditorSchemaOptions extends BaseEditorExtensionsOptions {
  extensions?: Extensions;
}

export type EditorContentValidationResult =
  { success: true; content: DocumentContent } | { success: false; issues: ContentIssue[] };

/** Removes Tiptap's empty/default JSON attributes without changing document semantics. */
export function normalizeTiptapDocumentJSON(input: unknown): unknown {
  let normalized: unknown;
  try {
    normalized = structuredClone(input);
  } catch {
    return input;
  }
  const pending: unknown[] = [normalized];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (
      record.type === "codeBlock" &&
      typeof record.attrs === "object" &&
      record.attrs !== null &&
      !Array.isArray(record.attrs) &&
      (record.attrs as Record<string, unknown>).language === null
    ) {
      delete (record.attrs as Record<string, unknown>).language;
    }
    if (
      record.type === "image" &&
      typeof record.attrs === "object" &&
      record.attrs !== null &&
      !Array.isArray(record.attrs)
    ) {
      const attrs = record.attrs as Record<string, unknown>;
      if (attrs.width === null) delete attrs.width;
      if (attrs.height === null) delete attrs.height;
    }
    if (Array.isArray(record.marks)) {
      for (const mark of record.marks) {
        if (typeof mark !== "object" || mark === null || Array.isArray(mark)) continue;
        const attrs = (mark as Record<string, unknown>).attrs;
        if (
          typeof attrs === "object" &&
          attrs !== null &&
          !Array.isArray(attrs) &&
          Object.keys(attrs).length === 0
        ) {
          delete (mark as Record<string, unknown>).attrs;
        }
      }
    }
    if (Array.isArray(record.content)) pending.push(...record.content);
  }
  return normalized;
}

export function createEditorSchema(options: EditorSchemaOptions = {}): Schema {
  const extensions = createBaseEditorExtensions({
    additionalExtensions: [...(options.additionalExtensions ?? []), ...(options.extensions ?? [])],
    onLinkClick: options.onLinkClick,
    collaborative: options.collaborative,
  });
  return getSchema(extensions);
}

export function validateContentForEditor(
  input: unknown,
  schema: Schema = createEditorSchema(),
): EditorContentValidationResult {
  const validation = validateDocumentContent(input);
  if (!validation.success) return validation;
  try {
    schema.nodeFromJSON(validation.data as JSONContent).check();
    return { success: true, content: validation.data };
  } catch {
    return {
      success: false,
      issues: [
        {
          code: "invalid-content",
          path: "$",
          message: "Content does not match the registered editor extensions.",
          recoverable: true,
        },
      ],
    };
  }
}

export function createEmptyDocumentContent(): DocumentContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", attrs: { blockId: `block_${crypto.randomUUID()}` } }],
  };
}
