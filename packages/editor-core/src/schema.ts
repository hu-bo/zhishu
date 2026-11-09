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
      (record.type === "paragraph" || record.type === "heading") &&
      typeof record.attrs === "object" &&
      record.attrs !== null &&
      !Array.isArray(record.attrs) &&
      (record.attrs as Record<string, unknown>).align === null
    ) {
      delete (record.attrs as Record<string, unknown>).align;
      if (Object.keys(record.attrs as Record<string, unknown>).length === 0) delete record.attrs;
    }
    if (
      record.type === "horizontalRule" &&
      typeof record.attrs === "object" &&
      record.attrs !== null &&
      !Array.isArray(record.attrs) &&
      (record.attrs as Record<string, unknown>).label === ""
    ) {
      delete (record.attrs as Record<string, unknown>).label;
    }
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
    if (
      (record.type === "tableCell" || record.type === "tableHeader") &&
      typeof record.attrs === "object" &&
      record.attrs !== null &&
      !Array.isArray(record.attrs)
    ) {
      const attrs = record.attrs as Record<string, unknown>;
      if (attrs.colspan === 1) delete attrs.colspan;
      if (attrs.rowspan === 1) delete attrs.rowspan;
      if (attrs.colwidth === null) delete attrs.colwidth;
      if (attrs.align === null) delete attrs.align;
      if (Object.keys(attrs).length === 0) delete record.attrs;
    }
    if (Array.isArray(record.marks)) {
      for (const mark of record.marks) {
        if (typeof mark !== "object" || mark === null || Array.isArray(mark)) continue;
        const markRecord = mark as Record<string, unknown>;
        const attrs = markRecord.attrs;
        if (typeof attrs === "object" && attrs !== null && !Array.isArray(attrs)) {
          if (markRecord.type === "link" && "href" in attrs) {
            // The document contract stores the URL. Tiptap adds attributes for rendering.
            markRecord.attrs = { href: attrs.href };
          } else if (Object.keys(attrs).length === 0) {
            delete markRecord.attrs;
          }
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
    placeholder: options.placeholder,
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
    // Empty persisted documents acquire an editable paragraph when mounted.
    const editorContent =
      validation.data.content.length === 0 ? createEmptyDocumentContent() : validation.data;
    schema.nodeFromJSON(editorContent as JSONContent).check();
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
