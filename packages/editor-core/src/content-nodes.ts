import { Node, type NodeViewRenderer } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import {
  CALLOUT_THEMES,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
} from "@zhishu/document-contracts";

export function createCalloutExtension(renderer?: NodeViewRenderer) {
  return Node.create({
    name: "callout",
    group: "block",
    content: "block+",
    defining: true,
    isolating: true,
    addAttributes() {
      return {
        theme: {
          default: "info",
          parseHTML: (element: HTMLElement) => {
            const value = element.getAttribute("data-callout-theme");
            return CALLOUT_THEMES.find((theme) => theme === value) ?? "info";
          },
        },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-callout-theme]", contentElement: "[data-callout-content]" }];
    },
    renderHTML({ node }) {
      return [
        "div",
        { "data-callout-theme": node.attrs.theme, "data-blockid": node.attrs.blockId },
        ["div", { "data-callout-content": "" }, 0],
      ];
    },
    addNodeView() {
      return renderer ?? null;
    },
  });
}

export function createStatusTagExtension(renderer?: NodeViewRenderer) {
  return Node.create({
    name: "statusTag",
    group: "inline",
    inline: true,
    atom: true,
    addProseMirrorPlugins() {
      return [
        new Plugin({
          appendTransaction(transactions, _oldState, state) {
            if (!transactions.some((transaction) => transaction.docChanged)) return null;
            const transaction = state.tr;
            state.doc.descendants((node, position) => {
              if (node.type.name === "statusTag" && node.marks.length)
                transaction.removeMark(position, position + node.nodeSize);
            });
            return transaction.steps.length ? transaction : null;
          },
        }),
      ];
    },
    addAttributes() {
      return {
        status: {
          default: "todo",
          parseHTML: (element: HTMLElement) => {
            const value = element.getAttribute("data-status-tag");
            return DOCUMENT_STATUSES.find((status) => status === value) ?? "todo";
          },
        },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-status-tag]" }];
    },
    renderHTML({ node }) {
      const status = DOCUMENT_STATUSES.find((value) => value === node.attrs.status) ?? "todo";
      return [
        "span",
        { "data-status-tag": status, contenteditable: "false" },
        DOCUMENT_STATUS_LABELS[status],
      ];
    },
    renderText({ node }) {
      const status = DOCUMENT_STATUSES.find((value) => value === node.attrs.status) ?? "todo";
      return DOCUMENT_STATUS_LABELS[status];
    },
    addNodeView() {
      return renderer ?? null;
    },
  });
}

export function createDividerExtension(renderer?: NodeViewRenderer) {
  return Node.create({
    name: "horizontalRule",
    group: "block",
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        label: {
          default: "",
          parseHTML: (element: HTMLElement) =>
            (element.getAttribute("data-divider-label") ?? "").slice(0, 80),
        },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-divider-label]" }, { tag: "hr" }];
    },
    renderHTML({ node }) {
      const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
      if (!label) return ["hr", { "data-blockid": node.attrs.blockId }];
      return [
        "div",
        { "data-divider-label": label, "data-blockid": node.attrs.blockId },
        ["hr"],
        ["span", {}, label],
        ["hr"],
      ];
    },
    addCommands() {
      return {
        setHorizontalRule:
          () =>
          ({ chain }) =>
            chain().insertContent({ type: "horizontalRule" }).run(),
      };
    },
    addNodeView() {
      return renderer ?? null;
    },
  });
}
