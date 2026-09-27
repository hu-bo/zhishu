import { Extension, Node, flattenExtensions, type Extensions } from "@tiptap/core";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import UniqueID from "@tiptap/extension-unique-id";
import StarterKit from "@tiptap/starter-kit";
import { createBlockId } from "@zhishu/document-contracts";
import { createBlockIndexExtension } from "./index-plugin.js";
import type { EditorLimitExceededReason } from "./index-plugin.js";

const blockTypes = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "horizontalRule",
  "image",
];

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

export interface BaseEditorExtensionsOptions {
  additionalExtensions?: Extensions;
  onLinkClick?: (href: string) => void;
  onLimitExceeded?: (reason: EditorLimitExceededReason) => void;
  collaborative?: boolean;
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
      ...(options.collaborative ? { undoRedo: false } : {}),
    }),
    imageBlock,
    uniqueIds,
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
