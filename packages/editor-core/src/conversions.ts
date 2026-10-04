import { DOMParser as ProseMirrorDOMParser, DOMSerializer, type Schema } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import {
  createBlockId,
  HIGHLIGHT_COLORS,
  CALLOUT_THEMES,
  CALLOUT_THEME_LABELS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  normalizeDocumentContent,
  TEXT_ALIGNMENTS,
  validateDocumentContent,
} from "@zhishu/document-contracts";
import type { ContentIssue, DocumentContent } from "@zhishu/document-contracts";
import { normalizeTiptapDocumentJSON } from "./schema.js";

const maxImportBytes = 2 * 1024 * 1024;
const addressableBlockTypes = new Set([
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
  "input",
  "i",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "colgroup",
  "col",
  "span",
  "strong",
  "ul",
  "u",
]);
const rejectedHtmlTags = new Set([
  "audio",
  "embed",
  "form",
  "iframe",
  "math",
  "object",
  "script",
  "source",
  "style",
  "svg",
  "video",
]);
const highlightColorSet = new Set<string>(HIGHLIGHT_COLORS);
const textAlignmentSet = new Set<string>(TEXT_ALIGNMENTS);

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
        if (node.type === "statusTag") {
          const attrs = node.attrs as Record<string, unknown> | undefined;
          const status = DOCUMENT_STATUSES.find((value) => value === attrs?.status) ?? "todo";
          return DOCUMENT_STATUS_LABELS[status];
        }
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

function blockPlainText(node: Record<string, unknown>, report: MutableReport, depth = 0): string {
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
    const label = (node.attrs as { label?: string } | undefined)?.label;
    return label ? `--- ${label} ---` : "---";
  }
  if (type === "image") {
    addIssue(report.degraded, "image-to-alt-text", "Images are represented by alternative text.");
    const attrs = node.attrs as Record<string, unknown> | undefined;
    return typeof attrs?.alt === "string" ? attrs.alt : "";
  }
  if (type === "pdfAttachment") {
    addIssue(report.degraded, "pdf-attachment-to-text", "PDF attachments are represented by name.");
    const attrs = node.attrs as Record<string, unknown> | undefined;
    const fileName = typeof attrs?.fileName === "string" ? attrs.fileName : "PDF attachment";
    return `[PDF: ${fileName}]`;
  }
  if (type === "table") {
    addIssue(
      report.degraded,
      "table-to-text",
      "Table structure is represented as tab-separated rows in plain text.",
    );
    return children
      .map((row) => {
        const cells = Array.isArray(row.content) ? (row.content as Record<string, unknown>[]) : [];
        return cells
          .map((cell) => {
            const paragraphs = Array.isArray(cell.content)
              ? (cell.content as Record<string, unknown>[])
              : [];
            return paragraphs.map((paragraph) => blockPlainText(paragraph, report)).join("\n");
          })
          .join("\t");
      })
      .join("\n");
  }
  if (type === "blockquote" || type === "callout") {
    addIssue(
      report.degraded,
      `${type}-to-text`,
      "Quote or callout formatting is lost in plain text.",
    );
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
  if (type === "listItem")
    return children.map((child) => blockPlainText(child, report, depth)).join("\n");
  if (type === "taskList") {
    addIssue(
      report.degraded,
      "task-list-to-text",
      "Task list structure is represented with indentation.",
    );
    return children
      .map((child) =>
        child.type === "taskList"
          ? blockPlainText(child, report, depth + 1)
          : `${"  ".repeat(depth)}${blockPlainText(child, report, depth)}`,
      )
      .join("\n");
  }
  if (type === "taskItem") {
    addIssue(
      report.degraded,
      "task-item-to-text",
      "Task list status is represented with a text prefix.",
    );
    const attrs = node.attrs as Record<string, unknown> | undefined;
    return `${"  ".repeat(depth)}${attrs?.checked === true ? "- [x] " : "- [ ] "}${inlineText(children)}`;
  }
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

function markdownEscape(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+.!|~<>-])/gu, "\\$1");
}

function markdownInline(nodes: readonly JSONContent[], report: MutableReport): string {
  return nodes
    .map((node) => {
      if (node.type === "hardBreak") return "  \n";
      let raw = node.text ?? "";
      if (node.type === "statusTag") {
        const status = DOCUMENT_STATUSES.find((value) => value === node.attrs?.status) ?? "todo";
        addIssue(
          report.degraded,
          "markdown-status-tag",
          "Markdown 将状态标签转换为文字，不能继续切换状态。",
        );
        raw = DOCUMENT_STATUS_LABELS[status];
      }
      if (node.type !== "text" && node.type !== "statusTag") return "";
      const marks = node.marks ?? [];
      let text = markdownEscape(raw);
      if (marks.some((mark) => mark.type === "code")) {
        const longest = Math.max(0, ...(raw.match(/`+/gu) ?? []).map((run) => run.length));
        const fence = "`".repeat(longest + 1);
        const pad = /^[` ]|[` ]$/u.test(raw) ? " " : "";
        text = `${fence}${pad}${raw}${pad}${fence}`;
      }
      for (const mark of marks) {
        if (mark.type === "bold" || mark.type === "italic" || mark.type === "strike") {
          const token = mark.type === "bold" ? "**" : mark.type === "italic" ? "*" : "~~";
          text = text.replace(
            /^(\s*)([\s\S]*?)(\s*)$/u,
            (_match: string, before: string, body: string, after: string) =>
              body ? `${before}${token}${body}${token}${after}` : text,
          );
        } else if (mark.type === "link") {
          const href = String(mark.attrs?.href ?? (mark as { href?: string }).href ?? "");
          text = `[${text}](<${href.replace(/>/gu, "%3E")}>)`;
        } else if (mark.type === "underline" || mark.type === "highlight") {
          addIssue(
            report.degraded,
            `markdown-${mark.type}`,
            mark.type === "underline" ? "Markdown 不保留下划线。" : "Markdown 不保留高亮颜色。",
          );
        }
      }
      return text;
    })
    .join("");
}

function markdownBlock(node: JSONContent, report: MutableReport): string {
  const children = node.content ?? [];
  if (node.attrs?.align && node.attrs.align !== "left")
    addIssue(report.degraded, "markdown-alignment", "Markdown 不保留段落和标题对齐方式。");
  switch (node.type) {
    case "paragraph":
      return markdownInline(children, report);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level ?? 1))} ${markdownInline(children, report)}`;
    case "horizontalRule":
      if (node.attrs?.label) {
        addIssue(
          report.degraded,
          "markdown-divider-label",
          "Markdown 将分隔线标签放在分隔线上方。",
        );
        return `${markdownEscape(String(node.attrs.label))}\n\n---`;
      }
      return "---";
    case "callout": {
      const theme = CALLOUT_THEMES.find((value) => value === node.attrs?.theme) ?? "info";
      addIssue(
        report.degraded,
        "markdown-callout",
        "Markdown 将提示块转换为引用文字，不能保留主题样式。",
      );
      return [
        `**${CALLOUT_THEME_LABELS[theme]}**`,
        ...children.map((child) => markdownBlock(child, report)),
      ]
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }
    case "codeBlock": {
      const text = children.map((child) => child.text ?? "").join("");
      const fence = "`".repeat(
        Math.max(3, ...(text.match(/`+/gu) ?? []).map((run) => run.length + 1)),
      );
      const language = String(node.attrs?.language ?? "").replace(/[^a-zA-Z0-9_+-]/gu, "");
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case "blockquote":
      return children
        .map((child) => markdownBlock(child, report))
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "bulletList":
    case "orderedList":
      return children
        .map((item, index) => {
          const prefix =
            node.type === "orderedList" ? `${Number(node.attrs?.start ?? 1) + index}. ` : "- ";
          const body = (item.content ?? [])
            .map((child) => markdownBlock(child, report))
            .join("\n\n");
          return body
            .split("\n")
            .map((line, lineIndex) =>
              lineIndex === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`,
            )
            .join("\n");
        })
        .join("\n");
    case "taskList":
      return children
        .map((child) =>
          child.type === "taskList"
            ? markdownBlock(child, report)
                .split("\n")
                .map((line) => `  ${line}`)
                .join("\n")
            : `- [${child.attrs?.checked ? "x" : " "}] ${markdownInline(child.content ?? [], report)}`,
        )
        .join("\n");
    case "table": {
      if (children[0]?.content?.some((cell) => cell.type !== "tableHeader"))
        addIssue(report.degraded, "markdown-table-header", "Markdown 将表格第一行用作表头。");
      const rows = children.map((row) =>
        (row.content ?? []).flatMap((cell) => {
          if (
            (cell.content?.length ?? 0) > 1 ||
            cell.content?.some((block) => block.type !== "paragraph")
          )
            addIssue(
              report.degraded,
              "markdown-table-blocks",
              "Markdown 表格中的多段落和块布局降级为行内内容。",
            );
          if (Number(cell.attrs?.colspan ?? 1) > 1 || Number(cell.attrs?.rowspan ?? 1) > 1)
            addIssue(
              report.degraded,
              "markdown-table-merge",
              "Markdown 不保留合并单元格；内容按行展开。",
            );
          const cellText = (cell.content ?? [])
            .map((block) => markdownBlock(block, report).replace(/\n/gu, "<br>"))
            .join("<br>");
          // GFM splits table cells before parsing inline code, including code pipes.
          let escapedCell = "";
          let backslashes = 0;
          for (const character of cellText) {
            if (character === "|" && backslashes % 2 === 0) escapedCell += "\\";
            escapedCell += character;
            backslashes = character === "\\" ? backslashes + 1 : 0;
          }
          return [
            escapedCell,
            ...Array.from({ length: Math.max(0, Number(cell.attrs?.colspan ?? 1) - 1) }, () => ""),
          ];
        }),
      );
      const width = Math.max(0, ...rows.map((row) => row.length));
      const lines = rows.map(
        (row) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`,
      );
      lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
      return lines.join("\n");
    }
    case "image":
    case "pdfAttachment": {
      addIssue(
        report.degraded,
        "markdown-private-asset",
        "私有附件只导出名称和替代文本，不包含文件或临时授权链接。",
      );
      const label = String(
        node.type === "image" ? node.attrs?.alt || "图片" : node.attrs?.fileName || "PDF 附件",
      );
      return `[${markdownEscape(label)}（私有附件）]`;
    }
    default:
      return children.map((child) => markdownBlock(child, report)).join("\n\n");
  }
}

/** Exports CommonMark with GFM task lists, tables and strikethrough. */
export function exportDocumentMarkdown(content: unknown): ConversionResult<string> {
  const report = createReport();
  report.supported.add("markdown-commonmark-gfm");
  const validated = toContentResult(content, report);
  if (!validated.success) return validated;
  const value =
    validated.value.content
      .map((block) => markdownBlock(block as JSONContent, report))
      .join("\n\n") + "\n";
  return { success: true, value, report: finalizeReport(report) };
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

/** Self-contained reading/printing document; the title is host-owned metadata. */
export function exportStandaloneDocumentHtml(
  content: unknown,
  schema: Schema,
  title: string,
): ConversionResult<string> {
  const converted = exportDocumentHtml(content, schema);
  if (!converted.success) return converted;
  const escapedTitle = escapeHtmlText(title);
  const body = document.createElement("div");
  body.innerHTML = converted.value;
  for (const table of body.querySelectorAll("table")) {
    const firstRow = table.querySelector("tr");
    if (
      firstRow &&
      firstRow.cells.length &&
      [...firstRow.cells].every((cell) => cell.tagName === "TH") &&
      !table.querySelector("thead")
    ) {
      const head = document.createElement("thead");
      head.append(firstRow);
      table.prepend(head);
    }
  }
  return {
    ...converted,
    value: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapedTitle}</title><style>
body{max-width:896px;margin:48px auto;padding:0 24px;color:#0f172a;background:white;font:16px/1.8 Inter,"PingFang SC",system-ui,sans-serif;overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{line-height:1.35;margin:1.5em 0 .6em;break-after:avoid}p{margin:1em 0}a{color:#4f46e5}blockquote{border-left:3px solid #cbd5e1;margin:1em 0;padding-left:1em;color:#475569}
pre{padding:16px;background:#f1f5f9;border-radius:8px;overflow:auto;white-space:pre}code{font-family:"Fira Code",monospace;font-size:.9em}.tableWrapper{max-width:100%;overflow:auto}table{border-collapse:collapse;width:100%;margin:1em 0}th,td{border:1px solid #cbd5e1;padding:8px;vertical-align:top}th{background:#f8fafc}hr{border:0;border-top:1px solid #cbd5e1;margin:2em 0}img{max-width:100%}
mark[data-highlight-color="yellow"]{background:#fef08a}mark[data-highlight-color="green"]{background:#bbf7d0}mark[data-highlight-color="blue"]{background:#bfdbfe}mark[data-highlight-color="pink"]{background:#fbcfe8}mark[data-highlight-color="purple"]{background:#e9d5ff}
div[data-type="taskList"]{padding-left:0}div[data-type="taskList"] div[data-type="taskList"]{padding-left:1.5em}div[data-type="taskItem"]{display:flex;align-items:baseline;gap:.5em}div[data-type="taskItem"][data-checked="true"]{text-decoration:line-through;color:#64748b}
div[data-callout-theme]{border-left:3px solid #6366f1;background:#eef2ff;padding:12px 16px;margin:1em 0;border-radius:6px}div[data-callout-theme="tip"]{border-color:#7c3aed;background:#f5f3ff}div[data-callout-theme="warning"]{border-color:#d97706;background:#fffbeb}div[data-callout-theme="success"]{border-color:#059669;background:#ecfdf5}div[data-callout-theme="danger"]{border-color:#e11d48;background:#fff1f2}div[data-divider-label]{display:flex;gap:12px;align-items:center;margin:2em 0}div[data-divider-label] hr{flex:1;margin:0}span[data-status-tag]{display:inline-block;background:#e2e8f0;border:1px solid #cbd5e1;border-radius:5px;padding:0 6px;font-size:.85em}
@page{margin:18mm}@media print{body{margin:0;padding:0;max-width:none;font-size:11pt}pre{white-space:pre-wrap;overflow:visible;overflow-wrap:anywhere}.tableWrapper{overflow:visible}table{width:100%!important;min-width:0!important;table-layout:fixed}col{width:auto!important;min-width:0!important}thead{display:table-header-group}tr,img{break-inside:avoid}a{color:inherit}h1,h2,h3{break-after:avoid}}
</style></head><body><main><h1>${escapedTitle}</h1>${body.innerHTML}</main></body></html>`,
  };
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
    const inTaskItem = Boolean(element.closest('div[data-type="taskItem"]'));
    const passiveTaskCheckbox =
      tag === "input" &&
      inTaskItem &&
      element.getAttribute("type") === "checkbox" &&
      element.hasAttribute("disabled");
    if (tag === "input" && !passiveTaskCheckbox) {
      addIssue(report.rejected, "active-html-removed", "The <input> element was removed.");
      element.remove();
      continue;
    }
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
      } else if (
        (tag === "div" &&
          name === "data-callout-theme" &&
          CALLOUT_THEMES.some((value) => value === attribute.value)) ||
        (tag === "div" &&
          name === "data-callout-content" &&
          element.closest("div[data-callout-theme]")) ||
        (tag === "span" &&
          name === "data-status-tag" &&
          DOCUMENT_STATUSES.some((value) => value === attribute.value)) ||
        (tag === "div" && name === "data-divider-label" && attribute.value.length <= 80)
      ) {
        continue;
      } else if (
        tag === "code" &&
        name === "class" &&
        /^language-[A-Za-z0-9_+-]{1,32}$/.test(attribute.value)
      ) {
        continue;
      } else if (
        name === "data-type" &&
        (attribute.value === "taskItem" || attribute.value === "taskList") &&
        tag === "div"
      ) {
        continue;
      } else if (
        name === "data-checked" &&
        /^(true|false)$/.test(attribute.value) &&
        tag === "div" &&
        element.dataset.type === "taskItem"
      ) {
        continue;
      } else if (
        name === "data-task-content" &&
        tag === "span" &&
        element.closest('div[data-type="taskItem"]')
      ) {
        continue;
      } else if (
        tag === "input" &&
        inTaskItem &&
        ((name === "type" && attribute.value === "checkbox") ||
          name === "disabled" ||
          (name === "checked" && element.hasAttribute("checked")))
      ) {
        continue;
      } else if (tag === "ol" && name === "start" && /^[1-9][0-9]{0,6}$/.test(attribute.value)) {
        continue;
      } else if (
        (tag === "td" || tag === "th") &&
        name === "colspan" &&
        /^[1-9][0-9]{0,1}$/.test(attribute.value) &&
        Number(attribute.value) <= 20
      ) {
        continue;
      } else if (
        (tag === "td" || tag === "th") &&
        name === "rowspan" &&
        /^[1-9][0-9]{0,2}$/.test(attribute.value) &&
        Number(attribute.value) <= 100
      ) {
        continue;
      } else if (
        (tag === "td" || tag === "th") &&
        name === "align" &&
        /^(left|center|right)$/i.test(attribute.value)
      ) {
        continue;
      } else if (
        (tag === "td" || tag === "th") &&
        name === "style" &&
        /^text-align:\s*(left|center|right);?$/i.test(attribute.value.trim())
      ) {
        continue;
      } else if (
        ["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag) &&
        name === "data-text-align" &&
        textAlignmentSet.has(attribute.value.toLowerCase())
      ) {
        continue;
      } else if (
        ["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag) &&
        name === "style" &&
        /^text-align:\s*(left|center|right);?$/i.test(attribute.value.trim())
      ) {
        continue;
      } else if (tag === "mark" && name === "data-highlight-color") {
        if (highlightColorSet.has(attribute.value)) continue;
        addIssue(
          report.degraded,
          "highlight-color-defaulted",
          "An unsupported highlight color was changed to yellow.",
        );
        element.removeAttribute(attribute.name);
      } else if (
        tag === "table" &&
        name === "style" &&
        /^(?:min-width:\s*|width:\s*)(?:[1-9][0-9]{0,5}px|100%);?$/i.test(attribute.value.trim()) &&
        (attribute.value.trim() === "width: 100%" ||
          Number(attribute.value.match(/[1-9][0-9]*/)?.[0] ?? 0) <= 655_360)
      ) {
        continue;
      } else if (
        tag === "col" &&
        name === "style" &&
        /^(?:min-width:\s*|width:\s*)[1-9][0-9]{0,4}px;?$/i.test(attribute.value.trim()) &&
        Number(attribute.value.match(/[1-9][0-9]*/)?.[0] ?? 0) <= 32_768
      ) {
        continue;
      } else if (tag === "div" && name === "class" && attribute.value === "tableWrapper") {
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
    const parsedJson = parsed.toJSON() as JSONContent;
    const pending = [parsedJson];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "statusTag" && node.marks?.length) {
        delete node.marks;
        addIssue(
          report.degraded,
          "status-tag-formatting",
          "状态标签使用固定外观，不保留套用的文字格式。",
        );
      }
      if (node.content) pending.push(...node.content);
    }
    const json: unknown = normalizeTiptapDocumentJSON(parsedJson);
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
    if (validated.value.content.length > 0) doc.check();
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
    const pdfBlocks = wrapper.querySelectorAll<HTMLAnchorElement>("a[data-pdf-asset-id]");
    if (pdfBlocks.length > 0) {
      addIssue(
        report.degraded,
        "pdf-attachment-to-text",
        "PDF attachments are exported as file names without access URLs.",
      );
      for (const block of pdfBlocks) {
        const fileName = block.getAttribute("data-file-name")?.trim() || block.textContent?.trim();
        block.replaceWith(document.createTextNode(fileName ? `[PDF: ${fileName}]` : "[PDF]"));
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
