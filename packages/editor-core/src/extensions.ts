import {
  Extension,
  Mark,
  Node,
  flattenExtensions,
  type Extensions,
  type NodeViewRenderer,
} from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, type Transaction } from "@tiptap/pm/state";
import UniqueID from "@tiptap/extension-unique-id";
import { Table } from "@tiptap/extension-table/table";
import { TableCell } from "@tiptap/extension-table/cell";
import { TableHeader } from "@tiptap/extension-table/header";
import { TableRow } from "@tiptap/extension-table/row";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import Placeholder from "@tiptap/extension-placeholder";
import { createBlockId, HIGHLIGHT_COLORS, TEXT_ALIGNMENTS } from "@zhishu/document-contracts";
import { createBlockIndexExtension } from "./index-plugin.js";
import type { EditorLimitExceededReason } from "./index-plugin.js";
import {
  createCalloutExtension,
  createDividerExtension,
  createStatusTagExtension,
} from "./content-nodes.js";

export const EDITOR_TASK_COMPLETED_EVENT = "zhishu-task-completed";

const blockTypes = [
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
];

const tableCell = TableCell.extend({ content: "paragraph+" });
const tableHeader = TableHeader.extend({ content: "paragraph+" });

function parseImageDimension(element: HTMLElement, name: "width" | "height"): number | null {
  const value = element.querySelector("img")?.getAttribute(name);
  if (!value || !/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const dimension = Number(value);
  return dimension <= 32_768 ? dimension : null;
}

const imageBlock = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-asset-id"),
      },
      mediaType: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-media-type"),
      },
      alt: {
        default: "",
        parseHTML: (element: HTMLElement) =>
          element.querySelector("img")?.getAttribute("alt") ?? "",
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => parseImageDimension(element, "width"),
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => parseImageDimension(element, "height"),
      },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-asset-id]" }];
  },
  renderHTML({ node }) {
    const attrs: Record<string, string> = {
      "data-blockid": String(node.attrs.blockId),
      "data-asset-id": String(node.attrs.assetId),
      "data-media-type": String(node.attrs.mediaType),
    };
    const imageAttrs: Record<string, string | number> = {
      "data-asset-id": String(node.attrs.assetId),
      alt: String(node.attrs.alt ?? ""),
    };
    if (typeof node.attrs.width === "number") imageAttrs.width = node.attrs.width;
    if (typeof node.attrs.height === "number") imageAttrs.height = node.attrs.height;
    return ["figure", attrs, ["img", imageAttrs]];
  },
});

const pdfAttachmentBlock = Node.create({
  name: "pdfAttachment",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-asset-id"),
      },
      mediaType: {
        default: "application/pdf",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-media-type"),
      },
      fileName: {
        default: "document.pdf",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-file-name"),
      },
    };
  },
  parseHTML() {
    return [{ tag: "a[data-pdf-asset-id]" }];
  },
  renderHTML({ node }) {
    const fileName = String(node.attrs.fileName ?? "document.pdf");
    return [
      "a",
      {
        "data-blockid": String(node.attrs.blockId),
        "data-asset-id": String(node.attrs.assetId),
        "data-pdf-asset-id": String(node.attrs.assetId),
        "data-media-type": "application/pdf",
        "data-file-name": fileName,
        "aria-label": `PDF 附件：${fileName}`,
        target: "_blank",
        rel: "noopener noreferrer",
      },
      fileName,
    ];
  },
});

const taskListBlock = Node.create({
  name: "taskList",
  group: "block",
  content: "(taskItem | taskList)+",
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-type="taskList"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", { ...HTMLAttributes, "data-type": "taskList" }, 0];
  },
});

const highlightColorSet = new Set<string>(HIGHLIGHT_COLORS);
const alignmentSet = new Set<string>(TEXT_ALIGNMENTS);

export interface EditorPlaceholderOptions {
  emptyDocument?: string;
  emptyParagraph?: string;
  showInReadOnly?: boolean;
}

function parseTextAlignment(element: HTMLElement): string | null {
  const value = (element.getAttribute("data-text-align") ?? element.style.textAlign).toLowerCase();
  return alignmentSet.has(value) ? value : null;
}

const highlightMark = Mark.create({
  name: "highlight",
  addAttributes() {
    return {
      color: {
        default: "yellow",
        parseHTML: (element: HTMLElement) => {
          const color = element.getAttribute("data-highlight-color") ?? "yellow";
          return highlightColorSet.has(color) ? color : "yellow";
        },
        renderHTML: (attributes: { color?: unknown }) => {
          const color = typeof attributes.color === "string" ? attributes.color : "yellow";
          return { "data-highlight-color": highlightColorSet.has(color) ? color : "yellow" };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "mark[data-highlight-color]" }, { tag: "mark" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", HTMLAttributes, 0];
  },
});

const highlightKeyboardShortcuts = Extension.create({
  name: "zhishuHighlightKeyboardShortcuts",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        props: {
          handleKeyDown: (view, event) => {
            if (
              !editor.isEditable ||
              view.composing ||
              event.isComposing ||
              event.keyCode === 229 ||
              !(event.metaKey || event.ctrlKey) ||
              !event.shiftKey ||
              event.altKey ||
              event.key.toLowerCase() !== "h"
            ) {
              return false;
            }
            event.preventDefault();
            return editor.isActive("highlight")
              ? editor.commands.unsetMark("highlight")
              : editor.commands.setMark("highlight", { color: "yellow" });
          },
        },
      }),
    ];
  },
});

const textAlignment = Extension.create({
  name: "zhishuTextAlignment",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          align: {
            default: null,
            parseHTML: parseTextAlignment,
            renderHTML: (attributes: { align?: unknown }) => {
              const align = typeof attributes.align === "string" ? attributes.align : "";
              return alignmentSet.has(align)
                ? { "data-text-align": align, style: `text-align: ${align};` }
                : {};
            },
          },
        },
      },
    ];
  },
});

const taskItemBlock = Node.create({
  name: "taskItem",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return {
      checked: {
        default: false,
        parseHTML: (element: HTMLElement) => element.dataset.checked === "true",
        renderHTML: (attributes: { checked?: unknown }) => ({
          "data-checked": String(attributes.checked === true),
        }),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="taskItem"]',
        contentElement: "[data-task-content]",
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      { ...HTMLAttributes, "data-type": "taskItem", "data-checked": String(node.attrs.checked) },
      [
        "input",
        {
          type: "checkbox",
          disabled: "disabled",
          "aria-label": node.textContent.slice(0, 255) || "任务完成状态",
          ...(node.attrs.checked === true ? { checked: "checked" } : {}),
        },
      ],
      ["span", { "data-task-content": "" }, 0],
    ];
  },
  addNodeView() {
    return ({ node, view, getPos }) => {
      const dom = document.createElement("div");
      dom.dataset.type = "taskItem";
      dom.dataset.blockid = String(node.attrs.blockId ?? "");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      const contentDOM = document.createElement("span");
      contentDOM.dataset.taskContent = "";
      dom.append(checkbox, contentDOM);

      const syncAttributes = (current: ProseMirrorNode) => {
        dom.dataset.blockid = String(current.attrs.blockId ?? "");
        dom.dataset.checked = String(current.attrs.checked === true);
        checkbox.checked = current.attrs.checked === true;
        checkbox.disabled = !view.editable;
        checkbox.setAttribute("aria-label", current.textContent.slice(0, 255) || "任务完成状态");
      };
      syncAttributes(node);
      checkbox.addEventListener("change", (event) => {
        if (!view.editable || typeof getPos !== "function") return;
        const position = getPos();
        if (typeof position !== "number") return;
        const current = view.state.doc.nodeAt(position);
        if (!current || current.type.name !== "taskItem") return;
        view.dispatch(
          view.state.tr
            .setNodeMarkup(position, undefined, { ...current.attrs, checked: checkbox.checked })
            .setMeta("zhishu-origin", "host-command"),
        );
        const updated = view.state.doc.nodeAt(position);
        if (
          event.isTrusted &&
          current.attrs.checked !== true &&
          updated?.attrs.checked === true &&
          updated.attrs.blockId === current.attrs.blockId
        ) {
          dom.dispatchEvent(new CustomEvent(EDITOR_TASK_COMPLETED_EVENT, { bubbles: true }));
        }
      });

      return {
        dom,
        contentDOM,
        update(current: ProseMirrorNode) {
          if (current.type.name !== "taskItem") return false;
          syncAttributes(current);
          return true;
        },
        stopEvent(event: Event) {
          return event.target === checkbox;
        },
      };
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        view(view) {
          const syncCheckboxes = () => {
            for (const checkbox of view.dom.querySelectorAll<HTMLInputElement>(
              'div[data-type="taskItem"] > input[type="checkbox"]',
            )) {
              checkbox.disabled = !view.editable;
            }
          };
          syncCheckboxes();
          return { update: syncCheckboxes };
        },
      }),
    ];
  },
});

export interface BaseEditorExtensionsOptions {
  additionalExtensions?: Extensions;
  codeBlockNodeView?: NodeViewRenderer;
  calloutNodeView?: NodeViewRenderer;
  dividerNodeView?: NodeViewRenderer;
  statusTagNodeView?: NodeViewRenderer;
  onLinkClick?: (href: string) => void;
  onLimitExceeded?: (reason: EditorLimitExceededReason) => void;
  collaborative?: boolean;
  placeholder?: EditorPlaceholderOptions | false;
  collaborationStructure?: {
    mode: "disabled";
    isRemoteTransaction: (transaction: Transaction) => boolean;
    onRejected?: () => void;
  };
}

function blockStructure(document: ProseMirrorNode): string[] {
  const structure: string[] = [];
  const visit = (node: ProseMirrorNode, path: number[]) => {
    if (node.isBlock && node.type.name !== "doc") {
      structure.push(JSON.stringify([path, node.type.name, node.attrs.blockId ?? null]));
    }
    if (node.type.name === "table") return;
    node.forEach((child, _offset, index) => visit(child, [...path, index]));
  };
  document.forEach((child, _offset, index) => visit(child, [index]));
  return structure;
}

function hasSameBlockStructure(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  const left = blockStructure(before);
  const right = blockStructure(after);
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function hasOnlyGeneratedBlockIds(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  const collect = (document: ProseMirrorNode) => {
    const blocks: Array<{ path: string; type: string; blockId: unknown }> = [];
    const visit = (node: ProseMirrorNode, path: number[]) => {
      if (node.isBlock && node.type.name !== "doc") {
        blocks.push({
          path: JSON.stringify(path),
          type: node.type.name,
          blockId: node.attrs.blockId,
        });
      }
      if (node.type.name === "table") return;
      node.forEach((child, _offset, index) => visit(child, [...path, index]));
    };
    document.forEach((child, _offset, index) => visit(child, [index]));
    return blocks;
  };
  const left = collect(before);
  const right = collect(after);
  if (left.length !== right.length) return false;
  const ids = new Set<string>();
  for (let index = 0; index < left.length; index += 1) {
    const current = left[index];
    const next = right[index];
    if (!current || !next || current.path !== next.path || current.type !== next.type) return false;
    if (typeof next.blockId !== "string" || !/^block_[A-Za-z0-9_-]{1,64}$/u.test(next.blockId)) {
      return false;
    }
    if (ids.has(next.blockId)) return false;
    ids.add(next.blockId);
    if (current.blockId === next.blockId) continue;
    if (current.blockId !== null && current.blockId !== undefined) return false;
  }
  return true;
}

function collectBlockIds(node: ProseMirrorNode): string[] {
  const ids: string[] = [];
  const visit = (current: ProseMirrorNode) => {
    if (current.isBlock && blockTypes.includes(current.type.name)) {
      const blockId = current.attrs.blockId;
      if (typeof blockId === "string") ids.push(blockId);
    }
    current.forEach(visit);
  };
  visit(node);
  return ids;
}

function collectBlockIdsFromDragTarget(target: EventTarget | null): string[] {
  if (typeof Element === "undefined" || !(target instanceof Element)) return [];
  const root = target.closest<HTMLElement>("[data-blockid]");
  if (!root) return [];
  return [root, ...root.querySelectorAll<HTMLElement>("[data-blockid]")]
    .map((element) => element.dataset.blockid)
    .filter((blockId): blockId is string => typeof blockId === "string");
}

function restoreBlockIds(slice: Slice, ids: readonly string[]): Slice {
  let index = 0;
  const restoreNode = (node: ProseMirrorNode): ProseMirrorNode => {
    if (node.isText) return node;
    const content = Fragment.fromArray(
      Array.from({ length: node.childCount }, (_, childIndex) =>
        restoreNode(node.child(childIndex)),
      ),
    );
    if (node.isBlock && blockTypes.includes(node.type.name)) {
      const blockId = ids[index++];
      if (blockId) return node.type.create({ ...node.attrs, blockId }, content, node.marks);
    }
    return node.copy(content);
  };
  const content = Fragment.fromArray(
    Array.from({ length: slice.content.childCount }, (_, childIndex) =>
      restoreNode(slice.content.child(childIndex)),
    ),
  );
  return new Slice(content, slice.openStart, slice.openEnd);
}

function createInternalBlockMoveIdentityExtension(): Extension {
  return Extension.create({
    name: "zhishuInternalBlockMoveIdentity",
    addProseMirrorPlugins() {
      const drag = { blockIds: [] as string[], startedHere: false, restoreIds: false };
      return [
        new Plugin({
          props: {
            handleDOMEvents: {
              dragstart: (view, event) => {
                const selection = view.state.selection;
                drag.startedHere = true;
                drag.blockIds =
                  selection instanceof NodeSelection
                    ? collectBlockIds(selection.node)
                    : collectBlockIdsFromDragTarget(event.target);
                drag.restoreIds = false;
                return false;
              },
              dragend: () => {
                drag.blockIds = [];
                drag.startedHere = false;
                drag.restoreIds = false;
                return false;
              },
              drop: (_view, event) => {
                const move =
                  event.dataTransfer?.dropEffect === "move" ||
                  (event.dataTransfer?.dropEffect === "none" && !event.ctrlKey);
                drag.restoreIds = drag.startedHere && move && drag.blockIds.length > 0;
                drag.startedHere = false;
                return false;
              },
            },
            transformPasted: (slice) => {
              if (!drag.restoreIds) return slice;
              drag.restoreIds = false;
              const restored = restoreBlockIds(slice, drag.blockIds);
              drag.blockIds = [];
              return restored;
            },
          },
        }),
      ];
    },
  });
}

export function createBaseEditorExtensions(options: BaseEditorExtensionsOptions = {}): Extensions {
  const link = {
    openOnClick: false,
    protocols: ["mailto"],
    isAllowedUri: (url: string, context: { defaultValidate: (value: string) => boolean }) =>
      /^(https?:\/\/|mailto:)[^\s]+$/i.test(url) && context.defaultValidate(url),
  };

  const uniqueIds = UniqueID.configure({
    types: blockTypes,
    attributeName: "blockId",
    generateID: () => createBlockId(),
  });

  const placeholderOptions = options.placeholder === false ? undefined : options.placeholder;
  const placeholder =
    options.placeholder === false
      ? undefined
      : Placeholder.configure({
          emptyEditorClass: "is-editor-empty",
          emptyNodeClass: "is-empty",
          placeholder: ({ editor, node, pos }) => {
            if (!node.isTextblock || node.content.size > 0) return "";
            const isEmptyDocument = editor.state.doc.childCount === 1 && pos === 0;
            return isEmptyDocument
              ? (placeholderOptions?.emptyDocument ?? "开始写作，输入 / 查看编辑命令")
              : (placeholderOptions?.emptyParagraph ?? "继续写作，输入 / 打开插入菜单");
          },
          showOnlyWhenEditable: placeholderOptions?.showInReadOnly !== true,
        });

  const linkClickHandler = options.onLinkClick
    ? Extension.create({
        name: "zhishuLinkClick",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              props: {
                handleClick: (_view, _position, event) => {
                  const target = event.target;
                  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
                  const anchor = target.closest("a[href]");
                  if (anchor?.matches("[data-pdf-asset-id]")) return false;
                  const href = anchor?.getAttribute("href");
                  if (!href) return false;
                  options.onLinkClick?.(href);
                  return true;
                },
              },
            }),
          ];
        },
      })
    : undefined;

  const collaborationStructureGuard = options.collaborationStructure
    ? Extension.create({
        name: "zhishuCollaborationStructureGuard",
        addProseMirrorPlugins() {
          const policy = options.collaborationStructure;
          if (!policy) return [];
          return [
            new Plugin({
              filterTransaction: (transaction, state) => {
                if (!transaction.docChanged || policy.isRemoteTransaction(transaction)) return true;
                if (
                  hasSameBlockStructure(state.doc, transaction.doc) ||
                  hasOnlyGeneratedBlockIds(state.doc, transaction.doc)
                ) {
                  return true;
                }
                policy.onRejected?.();
                return false;
              },
            }),
          ];
        },
      })
    : undefined;

  const extensions: Extensions = [
    StarterKit.configure({
      link,
      codeBlock: false,
      horizontalRule: false,
      ...(options.collaborative ? { undoRedo: false } : {}),
    }),
    CodeBlock.extend({
      addNodeView() {
        return options.codeBlockNodeView ?? null;
      },
    }),
    createCalloutExtension(options.calloutNodeView),
    createDividerExtension(options.dividerNodeView),
    createStatusTagExtension(options.statusTagNodeView),
    ...(placeholder ? [placeholder] : []),
    highlightMark,
    highlightKeyboardShortcuts,
    textAlignment,
    imageBlock,
    pdfAttachmentBlock,
    Table.configure({ resizable: true, renderWrapper: true, handleWidth: 8, cellMinWidth: 96 }),
    TableRow,
    tableCell,
    tableHeader,
    taskListBlock,
    taskItemBlock,
    uniqueIds,
    createInternalBlockMoveIdentityExtension(),
    createBlockIndexExtension(options.onLimitExceeded),
    ...(options.additionalExtensions ?? []),
    ...(linkClickHandler ? [linkClickHandler] : []),
    ...(collaborationStructureGuard ? [collaborationStructureGuard] : []),
  ];
  const names = new Set<string>();
  const duplicates = new Set<string>();
  for (const extension of flattenExtensions(extensions)) {
    if (names.has(extension.name)) duplicates.add(extension.name);
    names.add(extension.name);
  }
  if (duplicates.size > 0) {
    throw new TypeError(`Duplicate editor extension names: ${[...duplicates].sort().join(", ")}.`);
  }
  return extensions;
}
