import { DOMParser as ProseMirrorDOMParser, DOMSerializer, type Schema } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import {
  createBlockId,
  normalizeDocumentContent,
  validateDocumentContent,
} from "@zhishu/document-contracts";
import type { ContentIssue, DocumentContent } from "@zhishu/document-contracts";

const maxImportBytes = 2 * 1024 * 1024;
const addressableBlockTypes = new Set([
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
const supportedHtmlTags = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "ul",
]);
const rejectedHtmlTags = new Set([
  "audio",
  "embed",
  "form",
  "iframe",
  "input",
  "math",
  "object",
  "script",
  "source",
  "style",
  "svg",
  "video",
]);

export interface ConversionIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ConversionReport {
  status: "supported" | "degraded" | "rejected";
  supported: string[];
  degraded: ConversionIssue[];
  rejected: ConversionIssue[];
}

export type ConversionResult<T> =
  | { success: true; value: T; report: ConversionReport }
  | { success: false; error: ConversionIssue; report: ConversionReport };

interface MutableReport {
  supported: Set<string>;
  degraded: ConversionIssue[];
  rejected: ConversionIssue[];
}

function createReport(): MutableReport {
  return { supported: new Set(), degraded: [], rejected: [] };
}

function finalizeReport(report: MutableReport): ConversionReport {
  return {
    status:
      report.rejected.length > 0
        ? "rejected"
        : report.degraded.length > 0
          ? "degraded"
          : "supported",
    supported: [...report.supported].sort(),
    degraded: report.degraded,
    rejected: report.rejected,
  };
}

function addIssue(target: ConversionIssue[], code: string, message: string, path?: string): void {
  if (!target.some((entry) => entry.code === code && entry.path === path)) {
    target.push(path === undefined ? { code, message } : { code, message, path });
  }
}

function reportValidationIssues(report: MutableReport, issues: readonly ContentIssue[]): void {
  for (const issue of issues) {
    addIssue(report.rejected, issue.code, issue.message, issue.path);
  }
}

function fail<T>(error: ConversionIssue, report: MutableReport): ConversionResult<T> {
  return { success: false, error, report: finalizeReport(report) };
}

function toContentResult(
  content: unknown,
  report: MutableReport,
): ConversionResult<DocumentContent> {
  const validation = validateDocumentContent(content);
  if (!validation.success) {
    reportValidationIssues(report, validation.issues);
    const firstIssue = validation.issues[0];
    return fail(
      firstIssue
        ? { code: firstIssue.code, message: firstIssue.message, path: firstIssue.path }
        : { code: "invalid-content", message: "Imported content is invalid." },
      report,
    );
  }
  return {
    success: true,
    value: normalizeDocumentContent(validation.data),
    report: finalizeReport(report),
  };
}

export function importDocumentJson(source: string): ConversionResult<DocumentContent> {
  const report = createReport();
  report.supported.add("json-v1");
  if (new TextEncoder().encode(source).byteLength > maxImportBytes) {
    const error = { code: "limit-exceeded", message: "JSON input exceeds 2 MiB." };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    const error = { code: "invalid-json", message: "Input is not valid JSON." };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }
  return toContentResult(parsed, report);
}

export function exportDocumentJson(content: unknown): ConversionResult<string> {
  const report = createReport();
  report.supported.add("json-v1");
  const validated = toContentResult(content, report);
  if (!validated.success) return validated;
  return {
    success: true,
    value: JSON.stringify(validated.value),
    report: validated.report,
  };
}

export function importPlainText(source: string): ConversionResult<DocumentContent> {
  const report = createReport();
  report.supported.add("plain-text-lines");
  if (new TextEncoder().encode(source).byteLength > maxImportBytes) {
    const error = { code: "limit-exceeded", message: "Text input exceeds 2 MiB." };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }

  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const content = {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      attrs: { blockId: createBlockId() },
      ...(line.length > 0 ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
  return toContentResult(content, report);
}

function inlineText(nodes: readonly Record<string, unknown>[] | undefined): string {
  return (
    nodes
      ?.map((node) => {
        if (node.type === "text") return typeof node.text === "string" ? node.text : "";
        if (node.type === "hardBreak") return "\n";
        return "";
      })
      .join("") ?? ""
  );
}

function collectMarks(value: unknown, report: MutableReport): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const child of value) collectMarks(child, report);
    return;
  }
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.marks)) {
    for (const mark of node.marks) {
      if (typeof mark !== "object" || mark === null) continue;
      const type = (mark as Record<string, unknown>).type;
      if (type === "link") {
        addIssue(report.degraded, "link-url-omitted", "Link URLs are omitted from plain text.");
      } else if (typeof type === "string") {
        addIssue(
          report.degraded,
          `inline-${type}-to-text`,
          `The ${type} mark is lost in plain text.`,
        );
      }
    }
  }
  if (Array.isArray(node.content)) collectMarks(node.content, report);
}

function blockPlainText(node: Record<string, unknown>, report: MutableReport): string {
  const type = node.type;
  const children = Array.isArray(node.content) ? (node.content as Record<string, unknown>[]) : [];
  if (type === "paragraph") return inlineText(children);
  if (type === "heading") {
    addIssue(report.degraded, "heading-to-text", "Heading level is lost in plain text.");
    return inlineText(children);
  }
  if (type === "codeBlock") {
    addIssue(report.degraded, "code-block-to-text", "Code block formatting is lost in plain text.");
    return inlineText(children);
  }
  if (type === "horizontalRule") {
    addIssue(
      report.degraded,
      "horizontal-rule-to-text",
      "A horizontal rule becomes three hyphens.",
    );
    return "---";
  }
  if (type === "image") {
    addIssue(report.degraded, "image-to-alt-text", "Images are represented by alternative text.");
    const attrs = node.attrs as Record<string, unknown> | undefined;
    return typeof attrs?.alt === "string" ? attrs.alt : "";
  }
  if (type === "blockquote") {
    addIssue(report.degraded, "blockquote-to-text", "Quote formatting is lost in plain text.");
    return children
      .map((child) => blockPlainText(child, report))
      .join("\n")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (type === "bulletList" || type === "orderedList") {
    addIssue(report.degraded, "list-to-text", "List formatting is represented with text prefixes.");
    return children
      .map((item, index) => {
        const itemContent = Array.isArray(item.content)
          ? (item.content as Record<string, unknown>[])
          : [];
        const text = itemContent.map((child) => blockPlainText(child, report)).join("\n");
        const prefix = type === "orderedList" ? `${index + 1}. ` : "- ";
        return text
          .split("\n")
          .map((line, lineIndex) => (lineIndex === 0 ? `${prefix}${line}` : `  ${line}`))
          .join("\n");
      })
      .join("\n");
  }
  if (type === "listItem") return children.map((child) => blockPlainText(child, report)).join("\n");
  return "";
}

export function exportPlainText(content: unknown): ConversionResult<string> {
  const report = createReport();
  report.supported.add("plain-text");
  const validated = toContentResult(content, report);
  if (!validated.success) return validated;

  const doc = validated.value as unknown as { content: Record<string, unknown>[] };
  const value = doc.content.map((block) => blockPlainText(block, report)).join("\n");
  collectMarks(validated.value, report);
  return { success: true, value, report: finalizeReport(report) };
}

function assignFreshBlockIds(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const node = value as { type?: unknown; attrs?: unknown; content?: unknown };
  if (typeof node.type === "string" && addressableBlockTypes.has(node.type)) {
    const attrs =
      typeof node.attrs === "object" && node.attrs !== null
        ? (node.attrs as Record<string, unknown>)
        : {};
    attrs.blockId = createBlockId();
    node.attrs = attrs;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) assignFreshBlockIds(child);
  }
}

function isSafeLinkHref(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "mailto:") return url.pathname.length > 0 && !/\s/.test(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function sanitizeHtmlBody(body: HTMLElement, report: MutableReport): void {
  const elements = [...body.querySelectorAll<HTMLElement>("*")];
  for (const element of elements) {
    if (!body.contains(element)) continue;
    const tag = element.localName.toLowerCase();
    if (rejectedHtmlTags.has(tag)) {
      addIssue(report.rejected, "active-html-removed", `The <${tag}> element was removed.`);
      element.remove();
      continue;
    }
    if (tag === "img") {
      const alt = element.getAttribute("alt")?.trim();
      addIssue(report.degraded, "image-alt-only", "Images are replaced by alternative text.");
      if (alt) element.replaceWith(element.ownerDocument.createTextNode(alt));
      else element.remove();
      continue;
    }
    if (!supportedHtmlTags.has(tag)) {
      addIssue(report.degraded, "unsupported-html-element", `<${tag}> formatting was discarded.`);
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (tag === "a" && name === "href") {
        if (isSafeLinkHref(attribute.value)) continue;
        addIssue(report.rejected, "unsafe-url-removed", "An unsafe link URL was removed.");
        element.removeAttribute(attribute.name);
      } else if (tag === "ol" && name === "start" && /^[1-9][0-9]{0,6}$/.test(attribute.value)) {
        continue;
      } else if (name === "data-blockid") {
        addIssue(
          report.degraded,
          "block-ids-regenerated",
          "Imported HTML Block IDs are regenerated.",
        );
        element.removeAttribute(attribute.name);
      } else if (name.startsWith("on")) {
        addIssue(report.rejected, "event-handler-removed", "An HTML event handler was removed.");
        element.removeAttribute(attribute.name);
      } else {
        addIssue(report.degraded, "html-attribute-removed", `The ${name} attribute was removed.`);
        element.removeAttribute(attribute.name);
      }
    }
    report.supported.add(tag);
  }
}

export function importDocumentHtml(
  source: string,
  schema: Schema,
): ConversionResult<DocumentContent> {
  const report = createReport();
  report.supported.add("html-basic");
  if (new TextEncoder().encode(source).byteLength > maxImportBytes) {
    const error = { code: "limit-exceeded", message: "HTML input exceeds 2 MiB." };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }
  if (typeof DOMParser === "undefined") {
    const error = { code: "dom-unavailable", message: "HTML import requires a browser DOM." };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }

  const htmlDocument = new DOMParser().parseFromString(source, "text/html");
  sanitizeHtmlBody(htmlDocument.body, report);
  try {
    const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(htmlDocument.body);
    const json: unknown = parsed.toJSON();
    assignFreshBlockIds(json);
    const validation = toContentResult(json, report);
    if (!validation.success) return validation;
    schema.nodeFromJSON(validation.value as JSONContent).check();
    return validation;
  } catch {
    const error = {
      code: "invalid-html-content",
      message: "Sanitized HTML does not match the registered editor schema.",
    };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }
}

export function exportDocumentHtml(content: unknown, schema: Schema): ConversionResult<string> {
  const report = createReport();
  report.supported.add("html-basic");
  const validated = toContentResult(content, report);
  if (!validated.success) return validated;
  if (typeof document === "undefined") {
    const error = { code: "dom-unavailable", message: "HTML export requires a browser DOM." };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }

  try {
    const doc = schema.nodeFromJSON(validated.value as JSONContent);
    doc.check();
    const wrapper = document.createElement("div");
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
    wrapper.appendChild(fragment);
    const imageBlocks = wrapper.querySelectorAll<HTMLElement>("figure[data-asset-id]");
    if (imageBlocks.length > 0) {
      addIssue(
        report.degraded,
        "image-to-alt-text",
        "Images are exported as alternative text only.",
      );
      for (const block of imageBlocks) {
        const image = block.querySelector("img[alt]");
        const alt = image?.getAttribute("alt")?.trim();
        block.replaceWith(document.createTextNode(alt ? `[Image: ${alt}]` : "[Image]"));
      }
    }
    return { success: true, value: wrapper.innerHTML, report: finalizeReport(report) };
  } catch {
    const error = {
      code: "invalid-html-content",
      message: "Document content does not match the registered editor schema.",
    };
    addIssue(report.rejected, error.code, error.message);
    return fail(error, report);
  }
}
