import { Editor, getSchema } from "@tiptap/core";
import type { Extensions, JSONContent } from "@tiptap/core";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { closeHistory } from "@tiptap/pm/history";
import {
  applyOperationBatch,
  createBlockId,
  HIGHLIGHT_COLORS,
  CALLOUT_THEMES,
  DOCUMENT_STATUSES,
  normalizeDocumentContent,
  TEXT_ALIGNMENTS,
  validateDocumentContent,
} from "@zhishu/document-contracts";
import type {
  ApplyOperationContext,
  ApplyOperationResult,
  DocumentBlock,
  DocumentContent,
  DocumentOperation,
  OperationBatch,
} from "@zhishu/document-contracts";
import { createCodeBlockHighlightingExtension } from "./code-block-highlighting.js";
import { createBaseEditorExtensions } from "./extensions.js";
import type { BaseEditorExtensionsOptions } from "./extensions.js";
import { findIndexedBlock, getIndexedHeadings } from "./index-plugin.js";
import type { EditorLimitExceededReason, IndexedBlock } from "./index-plugin.js";
import {
  createEmptyDocumentContent,
  normalizeTiptapDocumentJSON,
  validateContentForEditor,
} from "./schema.js";

export const editorOriginMeta = "zhishu-origin";
export const editorOperationMeta = "zhishu-operation-id";

export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];
export type CalloutTheme = (typeof CALLOUT_THEMES)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export type EditorTableCommand =
  | "addRowBefore"
  | "addRowAfter"
  | "deleteRow"
  | "addColumnBefore"
  | "addColumnAfter"
  | "deleteColumn"
  | "toggleHeaderRow"
  | "mergeCells"
  | "splitCell";

type EditorAttributeSource =
  Record<string, string> | ((state: EditorState) => Record<string, string>) | undefined;

export interface EditorTransactionEvent {
  origin: string | undefined;
  operationId: string | undefined;
  docChanged: boolean;
  selectionChanged: boolean;
}

export type EditorStructureAction =
  | { type: "insert-image"; assetId: string; mediaType: string; alt: string; afterBlockId?: string }
  | { type: "insert-pdf-attachment"; assetId: string; fileName: string; afterBlockId?: string }
  | { type: "insert-table"; targetBlockId: string; expectedText: string }
  | { type: "make-task-item"; targetBlockId: string }
  | { type: "insert-nested-task-list"; parentBlockId: string }
  | { type: "duplicate-block"; targetBlockId: string }
  | { type: "delete-block"; targetBlockId: string }
  | { type: "wrap-callout"; targetBlockIds: string[]; theme: CalloutTheme }
  | { type: "set-callout-theme"; targetBlockId: string; theme: CalloutTheme }
  | { type: "unwrap-callout"; targetBlockId: string }
  | { type: "set-divider-label"; targetBlockId: string; label: string }
  | { type: "make-divider"; targetBlockId: string; expectedText: string; label: string }
  | {
      type: "change-block-type";
      targetBlockId: string;
      blockType: "paragraph" | "heading" | "codeBlock";
      options?: { level?: number; language?: string };
    }
  | {
      type: "move-block";
      targetBlockId: string;
      parentBlockId: string | null;
      position?: { beforeBlockId?: string; afterBlockId?: string };
    };

export type PreparedStructureOperation =
  | {
      success: true;
      batch: OperationBatch;
      result: Extract<ApplyOperationResult, { success: true }>;
    }
  | { success: false; result: Extract<ApplyOperationResult, { success: false }> };

function resolveTransactionOrigin(transaction: Transaction): string | undefined {
  const explicitOrigin = transaction.getMeta(editorOriginMeta);
  if (typeof explicitOrigin === "string") return explicitOrigin;
  const uiEvent = transaction.getMeta("uiEvent");
  if (uiEvent === "input") return "user-input";
  if (uiEvent === "paste") return "paste";
  if (uiEvent === "cut") return "cut";
  if (transaction.getMeta("history$")) return "history";
  if (transaction.getMeta("composition") !== undefined) return "composition";
  return !transaction.docChanged && transaction.selectionSet ? "selection" : undefined;
}

export type EditorTransactionListener = (event: EditorTransactionEvent) => void;
export type EditorCommand =
  "write" | "undo" | "redo" | "copy" | "block-structure" | "table-structure";

export interface EditorCapability {
  allowed: boolean;
  reason?:
    | "read-only"
    | "empty-history"
    | "destroyed"
    | "collaboration-structure-disabled"
    | "not-in-table";
}

export interface CreateEditorOptions {
  element?: HTMLElement | null;
  content?: unknown;
  documentId?: string;
  generationId?: string;
  editable?: boolean;
  readOnlyReason?: string;
  placeholder?: BaseEditorExtensionsOptions["placeholder"];
  codeBlockHighlighting?: boolean;
  codeBlockNodeView?: BaseEditorExtensionsOptions["codeBlockNodeView"];
  calloutNodeView?: BaseEditorExtensionsOptions["calloutNodeView"];
  dividerNodeView?: BaseEditorExtensionsOptions["dividerNodeView"];
  statusTagNodeView?: BaseEditorExtensionsOptions["statusTagNodeView"];
  extensions?: Extensions;
  onLinkClick?: (href: string) => void;
  onLimitExceeded?: (reason: EditorLimitExceededReason) => void;
  hashBlock?: ApplyOperationContext["hashBlock"];
  collaborative?: boolean;
  collaborationStructure?: BaseEditorExtensionsOptions["collaborationStructure"];
}

function prepareContent(input: unknown, schema: Editor["schema"]): DocumentContent {
  const validated = validateDocumentContent(input);
  if (!validated.success) {
    const firstIssue = validated.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid document content.",
    );
  }

  const normalized = normalizeDocumentContent(validated.data);
  const content = normalized.content.length > 0 ? normalized : createEmptyDocumentContent();
  const editorValidation = validateContentForEditor(content, schema);
  if (!editorValidation.success) {
    const firstIssue = editorValidation.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid editor content.",
    );
  }
  return content;
}

interface BlockLocation {
  block: DocumentBlock;
  parentBlockId: string | null;
  siblings: unknown[];
  index: number;
}

function locateBlock(content: DocumentContent, targetId: string): BlockLocation | undefined {
  const pending: Array<{ siblings: unknown[]; parentBlockId: string | null }> = [
    { siblings: content.content as unknown as unknown[], parentBlockId: null },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (let index = current.siblings.length - 1; index >= 0; index -= 1) {
      const value = current.siblings[index];
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const node = value as {
        type?: unknown;
        attrs?: { blockId?: unknown };
        content?: unknown[];
      };
      const blockId = node.attrs?.blockId;
      if (typeof blockId !== "string") continue;
      if (blockId === targetId) {
        return {
          block: value as DocumentBlock,
          parentBlockId: current.parentBlockId,
          siblings: current.siblings,
          index,
        };
      }
      if (Array.isArray(node.content))
        pending.push({ siblings: node.content, parentBlockId: blockId });
    }
  }
  return undefined;
}

function makeOperationId(): string {
  return `op_${crypto.randomUUID()}`;
}

function cloneAddressableBlock(block: unknown): unknown {
  const copy = structuredClone(block) as unknown as Record<string, unknown>;
  const ids = new Set<string>();
  const pending: unknown[] = [copy];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    if (
      typeof node.type === "string" &&
      typeof node.attrs === "object" &&
      node.attrs !== null &&
      typeof (node.attrs as Record<string, unknown>).blockId === "string"
    ) {
      const id = createBlockId();
      if (ids.has(id)) throw new TypeError(`Generated Block ID ${id} is not unique.`);
      ids.add(id);
      (node.attrs as Record<string, unknown>).blockId = id;
    }
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return copy;
}

function operationFailure(
  operationId: string,
  code: "target-missing" | "invalid-operation" | "collaboration-structure-disabled",
  message: string,
): Extract<ApplyOperationResult, { success: false }> {
  return {
    success: false,
    operationId,
    error: { code, path: "$", message, recoverable: true },
  };
}

export interface EditorTextMatch {
  blockId: string;
  from: number;
  to: number;
  excerpt: string;
}

function foldWithOffsets(value: string): {
  folded: string;
  starts: number[];
  ends: number[];
} {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    const nextOffset = offset + character.length;
    const part = character.toLowerCase();
    folded += part;
    for (let index = 0; index < part.length; index += 1) {
      starts.push(offset);
      ends.push(nextOffset);
    }
    offset = nextOffset;
  }
  return { folded, starts, ends };
}

function splitInlineContent(
  content: readonly Record<string, unknown>[],
  offset: number,
): [Record<string, unknown>[], Record<string, unknown>[]] | undefined {
  let remaining = offset;
  const before: Record<string, unknown>[] = [];
  const after: Record<string, unknown>[] = [];
  for (const child of content) {
    if (child.type === "text" && typeof child.text === "string") {
      const text = child.text;
      if (remaining >= text.length) {
        before.push(structuredClone(child));
        remaining -= text.length;
      } else if (remaining <= 0) {
        after.push(structuredClone(child));
      } else {
        before.push({ ...structuredClone(child), text: text.slice(0, remaining) });
        after.push({ ...structuredClone(child), text: text.slice(remaining) });
        remaining = 0;
      }
    } else if (child.type === "hardBreak") {
      if (remaining > 0) {
        before.push(structuredClone(child));
        remaining -= 1;
      } else {
        after.push(structuredClone(child));
      }
    } else return undefined;
  }
  return remaining === 0 ? [before, after] : undefined;
}

export class EditorController {
  readonly editor: Editor;
  private readonly documentId?: string;
  private readonly generationId?: string;
  private readonly hashBlock?: ApplyOperationContext["hashBlock"];
  private readonly collaborationStructureDisabled: boolean;
  private readonly baseEditorAttributes: EditorAttributeSource;
  private readonly listeners = new Set<EditorTransactionListener>();
  private readonly removedEditorAttributes = new Set<string>();
  private managedEditorAttributes: Record<string, string> = {};
  private readonly transactionHandler: (payload: { transaction: Transaction }) => void;
  private readonly beforeInputHandler: EventListener;
  private trackedInputElement?: HTMLElement;
  private pendingInputOrigin?: string;
  private pendingInputClearTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private readOnlyReason?: string;

  constructor(options: CreateEditorOptions = {}) {
    if (options.collaborative && options.content !== undefined)
      throw new TypeError(
        "Collaborative editors read initial content from the synchronized Y.Doc.",
      );
    const collaborationStructure =
      options.collaborationStructure ??
      (options.collaborative
        ? { mode: "disabled" as const, isRemoteTransaction: () => false }
        : undefined);
    const extensions = createBaseEditorExtensions({
      additionalExtensions: [
        ...(options.extensions ?? []),
        ...(options.codeBlockHighlighting === false
          ? []
          : [createCodeBlockHighlightingExtension()]),
      ],
      onLinkClick: options.onLinkClick,
      onLimitExceeded: options.onLimitExceeded,
      collaborative: options.collaborative,
      collaborationStructure,
      placeholder: options.placeholder,
      codeBlockNodeView: options.codeBlockNodeView,
      calloutNodeView: options.calloutNodeView,
      dividerNodeView: options.dividerNodeView,
      statusTagNodeView: options.statusTagNodeView,
    });
    const schema = getSchema(extensions);
    const initialContent = options.collaborative
      ? undefined
      : options.content === undefined
        ? createEmptyDocumentContent()
        : prepareContent(options.content, schema);
    const editor = new Editor({
      ...(options.element ? { element: null } : {}),
      extensions,
      editable: options.editable ?? true,
      ...(initialContent ? { content: initialContent as JSONContent } : {}),
      enableContentCheck: true,
    });
    try {
      if (options.element) editor.mount(options.element);
    } catch (error) {
      editor.destroy();
      throw error;
    }

    this.editor = editor;
    this.baseEditorAttributes = editor.options.editorProps.attributes;
    this.documentId = options.documentId;
    this.generationId = options.generationId;
    this.hashBlock = options.hashBlock;
    this.collaborationStructureDisabled =
      options.collaborative === true || collaborationStructure?.mode === "disabled";
    this.readOnlyReason = options.readOnlyReason;
    this.beforeInputHandler = (event) => {
      const inputEvent = event as InputEvent;
      const inputType = typeof inputEvent.inputType === "string" ? inputEvent.inputType : "";
      if (inputType === "historyUndo" || inputType === "historyRedo") return;
      if (!inputType.startsWith("insert") && !inputType.startsWith("delete")) return;

      if (this.pendingInputClearTimer) clearTimeout(this.pendingInputClearTimer);
      this.pendingInputOrigin =
        inputEvent.isComposing || inputType.toLowerCase().includes("composition")
          ? "composition"
          : "user-input";
      this.pendingInputClearTimer = setTimeout(() => {
        this.pendingInputOrigin = undefined;
        this.pendingInputClearTimer = undefined;
      }, 0);
    };
    this.attachInputTracking();
    this.transactionHandler = ({ transaction }) => {
      const pendingInputOrigin = transaction.docChanged
        ? this.consumePendingInputOrigin()
        : undefined;
      const event: EditorTransactionEvent = {
        origin:
          resolveTransactionOrigin(transaction) ??
          pendingInputOrigin ??
          (transaction.docChanged ? "editor-command" : undefined),
        operationId: transaction.getMeta(editorOperationMeta) as string | undefined,
        docChanged: transaction.docChanged,
        selectionChanged: transaction.selectionSet,
      };
      for (const listener of this.listeners) listener(event);
    };
    editor.on("transaction", this.transactionHandler);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get isEditable(): boolean {
    return !this.destroyed && this.editor.isEditable;
  }

  get readonlyReason(): string | undefined {
    return this.readOnlyReason;
  }

  getSnapshot(): DocumentContent {
    this.assertActive();
    const result = validateDocumentContent(normalizeTiptapDocumentJSON(this.editor.getJSON()));
    if (!result.success) {
      const firstIssue = result.issues[0];
      throw new TypeError(
        firstIssue
          ? `${firstIssue.path}: ${firstIssue.message}`
          : "Editor contains invalid content.",
      );
    }
    return result.data;
  }

  applyOperations(batch: OperationBatch): ApplyOperationResult {
    this.assertActive();
    if (this.collaborationStructureDisabled) {
      return operationFailure(
        batch.operationId,
        "collaboration-structure-disabled",
        "Collaborative Block structure operations are disabled until their conflict rules pass validation.",
      );
    }
    const result = applyOperationBatch(this.getSnapshot(), batch, {
      documentId: this.documentId ?? batch.documentId,
      generationId: this.generationId,
      readOnly: !this.editor.isEditable,
      hashBlock: this.hashBlock,
    });
    if (!result.success) return result;

    const persistedContent =
      result.content.content.length > 0 ? result.content : createEmptyDocumentContent();
    const nextNode = this.editor.schema.nodeFromJSON(persistedContent as JSONContent);
    nextNode.check();
    const transaction = this.editor.state.tr.replaceWith(
      0,
      this.editor.state.doc.content.size,
      nextNode.content,
    );
    transaction.setMeta(editorOriginMeta, batch.origin);
    transaction.setMeta(editorOperationMeta, batch.operationId);
    this.editor.view.dispatch(closeHistory(transaction));
    this.editor.view.dispatch(closeHistory(this.editor.state.tr));
    return persistedContent === result.content
      ? result
      : {
          ...result,
          content: persistedContent,
          createdBlockIds: [
            ...result.createdBlockIds,
            ...persistedContent.content.map((block) => block.attrs.blockId),
          ],
        };
  }

  /** Builds and validates the exact OperationBatch used for an async server-side structure action. */
  prepareStructureAction(
    action: EditorStructureAction,
    operationId = makeOperationId(),
  ): PreparedStructureOperation {
    this.assertActive();
    const content = this.getSnapshot();
    let operations: DocumentOperation[];

    if (action.type === "insert-image") {
      const blocks = content.content as unknown as Array<{ attrs?: { blockId?: string } }>;
      const lastBlockId = action.afterBlockId ?? blocks.at(-1)?.attrs?.blockId;
      operations = [
        {
          type: "insert-block",
          parentBlockId: null,
          ...(lastBlockId ? { afterBlockId: lastBlockId } : {}),
          block: {
            type: "image",
            attrs: {
              blockId: createBlockId(),
              assetId: action.assetId,
              mediaType: action.mediaType,
              alt: action.alt,
            },
          } as DocumentBlock,
        },
      ];
    } else if (action.type === "insert-pdf-attachment") {
      const blocks = content.content as unknown as Array<{ attrs?: { blockId?: string } }>;
      const lastBlockId = action.afterBlockId ?? blocks.at(-1)?.attrs?.blockId;
      operations = [
        {
          type: "insert-block",
          parentBlockId: null,
          ...(lastBlockId ? { afterBlockId: lastBlockId } : {}),
          block: {
            type: "pdfAttachment",
            attrs: {
              blockId: createBlockId(),
              assetId: action.assetId,
              mediaType: "application/pdf",
              fileName: action.fileName.slice(0, 255),
            },
          } as DocumentBlock,
        },
      ];
    } else if (action.type === "insert-table") {
      const location = locateBlock(content, action.targetBlockId);
      const paragraph = location?.block as unknown as Record<string, unknown> | undefined;
      const paragraphContent = Array.isArray(paragraph?.content)
        ? (paragraph.content as Array<Record<string, unknown>>)
        : [];
      const paragraphText =
        paragraphContent.length > 0
          ? paragraphContent
              .map((node) => {
                if (node.type === "text" && typeof node.text === "string") return node.text;
                return "\uFFFC";
              })
              .join("")
          : "";
      if (
        !location ||
        location.block.type !== "paragraph" ||
        paragraphText !== action.expectedText
      ) {
        return {
          success: false,
          result: operationFailure(
            operationId,
            location ? "invalid-operation" : "target-missing",
            location
              ? "A table can replace a paragraph containing only its slash command."
              : "Target Block does not exist.",
          ),
        };
      }
      const rows = Array.from({ length: 3 }, (_, rowIndex) => ({
        type: "tableRow",
        content: Array.from({ length: 3 }, () => ({
          type: rowIndex === 0 ? "tableHeader" : "tableCell",
          content: [{ type: "paragraph", attrs: { blockId: createBlockId() } }],
        })),
      }));
      operations = [
        {
          type: "replace-block",
          targetBlockId: action.targetBlockId,
          block: {
            type: "table",
            attrs: { blockId: action.targetBlockId },
            content: rows,
          } as unknown as DocumentBlock,
        },
      ];
    } else if (action.type === "make-task-item") {
      const location = locateBlock(content, action.targetBlockId);
      if (!location || location.block.type !== "paragraph") {
        return {
          success: false,
          result: operationFailure(
            operationId,
            location ? "invalid-operation" : "target-missing",
            location ? "Only a paragraph can become a task item." : "Target Block does not exist.",
          ),
        };
      }
      const paragraph = location.block as unknown as Record<string, unknown>;
      operations = [
        {
          type: "replace-block",
          targetBlockId: action.targetBlockId,
          block: {
            type: "taskItem",
            attrs: { blockId: action.targetBlockId, checked: false },
            ...(Array.isArray(paragraph.content)
              ? { content: structuredClone(paragraph.content) }
              : {}),
          } as DocumentBlock,
        },
      ];
    } else if (action.type === "insert-nested-task-list") {
      const location = locateBlock(content, action.parentBlockId);
      if (!location || location.block.type !== "taskItem") {
        return {
          success: false,
          result: operationFailure(
            operationId,
            location ? "invalid-operation" : "target-missing",
            location
              ? "A nested task list must be inserted into a task item."
              : "Target task item does not exist.",
          ),
        };
      }
      const nestedItem: DocumentBlock = {
        type: "taskItem",
        attrs: { blockId: createBlockId(), checked: false },
      };
      const nestedList: DocumentBlock = {
        type: "taskList",
        attrs: { blockId: createBlockId() },
        content: [nestedItem],
      };
      const nextSibling = location.siblings[location.index + 1] as
        { type?: unknown; attrs?: { blockId?: unknown } } | undefined;
      const parent = location.parentBlockId
        ? locateBlock(content, location.parentBlockId)
        : undefined;
      if (parent?.block.type === "taskList" && nextSibling?.type === "taskList") {
        const childListId = nextSibling.attrs?.blockId;
        if (typeof childListId !== "string") {
          return {
            success: false,
            result: operationFailure(
              operationId,
              "invalid-operation",
              "Nested task lists must have a Block ID.",
            ),
          };
        }
        operations = [{ type: "insert-block", parentBlockId: childListId, block: nestedItem }];
      } else if (parent?.block.type === "taskList") {
        operations = [
          {
            type: "insert-block",
            parentBlockId: location.parentBlockId,
            afterBlockId: action.parentBlockId,
            block: nestedList,
          },
        ];
      } else {
        operations = [
          {
            type: "wrap-block",
            targetBlockId: action.parentBlockId,
            wrapper: {
              type: "taskList",
              attrs: { blockId: createBlockId() },
              content: [nestedList],
            } as DocumentBlock,
          },
        ];
      }
    } else if (action.type === "wrap-callout") {
      const locations = action.targetBlockIds.map((id) => locateBlock(content, id));
      const first = locations[0];
      if (
        !first ||
        !CALLOUT_THEMES.includes(action.theme) ||
        locations.some(
          (location, index) =>
            !location ||
            location.siblings !== first.siblings ||
            location.index !== first.index + index ||
            ["taskItem", "listItem"].includes(location.block.type),
        )
      ) {
        return {
          success: false,
          result: operationFailure(
            operationId,
            "invalid-operation",
            "Select adjacent blocks that can be wrapped in a callout.",
          ),
        };
      }
      const calloutId = createBlockId();
      operations = [
        {
          type: "wrap-block",
          targetBlockId: action.targetBlockIds[0]!,
          wrapper: {
            type: "callout",
            attrs: { blockId: calloutId, theme: action.theme },
            content: [],
          },
        },
      ];
      for (let index = 1; index < action.targetBlockIds.length; index++) {
        operations.push({
          type: "move-block",
          targetBlockId: action.targetBlockIds[index]!,
          parentBlockId: calloutId,
          afterBlockId: action.targetBlockIds[index - 1]!,
        });
      }
    } else if (action.type === "unwrap-callout") {
      const location = locateBlock(content, action.targetBlockId);
      if (!location || location.block.type !== "callout") {
        return {
          success: false,
          result: operationFailure(operationId, "target-missing", "The callout no longer exists."),
        };
      }
      operations = location.block.content.map((block) => ({
        type: "move-block" as const,
        targetBlockId: block.attrs.blockId,
        parentBlockId: location.parentBlockId,
        beforeBlockId: action.targetBlockId,
      }));
      operations.push({ type: "delete-block", targetBlockId: action.targetBlockId });
    } else if (action.type === "set-callout-theme" || action.type === "set-divider-label") {
      const location = locateBlock(content, action.targetBlockId);
      const expectedType = action.type === "set-callout-theme" ? "callout" : "horizontalRule";
      if (!location || location.block.type !== expectedType) {
        return {
          success: false,
          result: operationFailure(
            operationId,
            "target-missing",
            "The content block no longer exists.",
          ),
        };
      }
      const block = structuredClone(location.block);
      block.attrs = {
        ...block.attrs,
        ...(action.type === "set-callout-theme"
          ? { theme: action.theme }
          : { label: action.label }),
      };
      operations = [{ type: "replace-block", targetBlockId: action.targetBlockId, block }];
    } else if (action.type === "make-divider") {
      const location = locateBlock(content, action.targetBlockId);
      const nodes = location?.block.type === "paragraph" ? (location.block.content ?? []) : [];
      const text = nodes.map((node) => (node.type === "text" ? node.text : "\uFFFC")).join("");
      if (
        !location ||
        location.block.type !== "paragraph" ||
        text !== action.expectedText ||
        (text !== "" && !/^\/\S*$/u.test(text))
      ) {
        return {
          success: false,
          result: operationFailure(
            operationId,
            "invalid-operation",
            "A divider can replace only an empty paragraph or its slash command.",
          ),
        };
      }
      operations = [
        {
          type: "replace-block",
          targetBlockId: action.targetBlockId,
          block: {
            type: "horizontalRule",
            attrs: { blockId: action.targetBlockId, label: action.label },
          },
        },
      ];
    } else if (action.type === "duplicate-block") {
      const location = locateBlock(content, action.targetBlockId);
      if (!location) {
        return {
          success: false,
          result: operationFailure(operationId, "target-missing", "Target Block does not exist."),
        };
      }
      const block = cloneAddressableBlock(location.block);
      if ((location.block as unknown as { type: string }).type === "listItem") {
        if (!location.parentBlockId) {
          return {
            success: false,
            result: operationFailure(
              operationId,
              "invalid-operation",
              "A list item has no parent list.",
            ),
          };
        }
        const parent = locateBlock(content, location.parentBlockId);
        if (!parent || !["bulletList", "orderedList"].includes(parent.block.type)) {
          return {
            success: false,
            result: operationFailure(
              operationId,
              "invalid-operation",
              "A list item must belong to a list.",
            ),
          };
        }
        const list = structuredClone(parent.block) as unknown as Record<string, unknown>;
        const items = Array.isArray(list.content) ? list.content : [];
        items.splice(location.index + 1, 0, block);
        list.content = items;
        operations = [
          {
            type: "replace-block",
            targetBlockId: location.parentBlockId,
            block: list as unknown as DocumentBlock,
          },
        ];
      } else {
        operations = [
          {
            type: "insert-block",
            parentBlockId: location.parentBlockId,
            afterBlockId: action.targetBlockId,
            block: block as DocumentBlock,
          },
        ];
      }
    } else if (action.type === "delete-block") {
      operations = [{ type: "delete-block", targetBlockId: action.targetBlockId }];
    } else if (action.type === "move-block") {
      operations = [
        {
          type: "move-block",
          targetBlockId: action.targetBlockId,
          parentBlockId: action.parentBlockId,
          ...(action.position?.beforeBlockId
            ? { beforeBlockId: action.position.beforeBlockId }
            : {}),
          ...(action.position?.afterBlockId ? { afterBlockId: action.position.afterBlockId } : {}),
        },
      ];
    } else {
      const location = locateBlock(content, action.targetBlockId);
      if (!location) {
        return {
          success: false,
          result: operationFailure(operationId, "target-missing", "Target Block does not exist."),
        };
      }
      if (!["paragraph", "heading", "codeBlock"].includes(location.block.type)) {
        return {
          success: false,
          result: operationFailure(
            operationId,
            "invalid-operation",
            "Only paragraph, heading, or code Blocks can be converted.",
          ),
        };
      }
      const oldNode = location.block as unknown as Record<string, unknown>;
      const oldAttrs =
        typeof oldNode.attrs === "object" && oldNode.attrs !== null
          ? (oldNode.attrs as Record<string, unknown>)
          : {};
      const attrs: Record<string, unknown> = { blockId: action.targetBlockId };
      if (action.blockType === "heading") {
        const level =
          action.options?.level ?? (typeof oldAttrs.level === "number" ? oldAttrs.level : 1);
        if (!Number.isInteger(level) || level < 1 || level > 6) {
          return {
            success: false,
            result: operationFailure(
              operationId,
              "invalid-operation",
              "Heading level must be 1 through 6.",
            ),
          };
        }
        attrs.level = level;
      }
      if (action.blockType === "codeBlock") {
        const language = action.options?.language ?? oldAttrs.language;
        if (typeof language === "string") attrs.language = language;
      }
      const block: Record<string, unknown> = {
        type: action.blockType,
        attrs,
        ...(Array.isArray(oldNode.content) ? { content: structuredClone(oldNode.content) } : {}),
      };
      if (action.blockType === "codeBlock" && Array.isArray(block.content)) {
        block.content = block.content.map((item) => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
          const textNode = { ...(item as Record<string, unknown>) };
          delete textNode.marks;
          return textNode;
        });
      }
      operations = [
        {
          type: "replace-block",
          targetBlockId: action.targetBlockId,
          block: block as unknown as DocumentBlock,
        },
      ];
    }

    const batch = this.createOperationBatch(operationId, operations);
    let result = applyOperationBatch(content, batch, {
      documentId: this.documentId ?? batch.documentId,
      generationId: this.generationId,
      readOnly: !this.editor.isEditable,
      hashBlock: this.hashBlock,
    });
    if (result.success && result.content.content.length === 0) {
      batch.operations.push({
        type: "insert-block",
        parentBlockId: null,
        block: { type: "paragraph", attrs: { blockId: createBlockId() } },
      });
      result = applyOperationBatch(content, batch, {
        documentId: this.documentId ?? batch.documentId,
        generationId: this.generationId,
        readOnly: !this.editor.isEditable,
        hashBlock: this.hashBlock,
      });
    }
    return result.success ? { success: true, batch, result } : { success: false, result };
  }

  deleteBlock(targetBlockId: string, operationId = makeOperationId()): ApplyOperationResult {
    if (!locateBlock(this.getSnapshot(), targetBlockId)) {
      return operationFailure(operationId, "target-missing", "Target Block does not exist.");
    }
    return this.applyOperations(
      this.createOperationBatch(operationId, [{ type: "delete-block", targetBlockId }]),
    );
  }

  duplicateBlock(targetBlockId: string, operationId = makeOperationId()): ApplyOperationResult {
    const content = this.getSnapshot();
    const location = locateBlock(content, targetBlockId);
    if (!location) {
      return operationFailure(operationId, "target-missing", "Target Block does not exist.");
    }
    const targetType = (location.block as unknown as { type: string }).type;
    const block = cloneAddressableBlock(location.block);
    if (targetType === "listItem") {
      if (!location.parentBlockId) {
        return operationFailure(
          operationId,
          "invalid-operation",
          "A list item has no parent list.",
        );
      }
      const parent = locateBlock(content, location.parentBlockId);
      if (!parent || !["bulletList", "orderedList"].includes(parent.block.type)) {
        return operationFailure(
          operationId,
          "invalid-operation",
          "A list item must belong to a list.",
        );
      }
      const list = structuredClone(parent.block) as unknown as Record<string, unknown>;
      const items = Array.isArray(list.content) ? list.content : [];
      items.splice(location.index + 1, 0, block);
      list.content = items;
      return this.applyOperations(
        this.createOperationBatch(operationId, [
          {
            type: "replace-block",
            targetBlockId: location.parentBlockId,
            block: list as unknown as DocumentBlock,
          },
        ]),
      );
    }
    return this.applyOperations(
      this.createOperationBatch(operationId, [
        {
          type: "insert-block",
          parentBlockId: location.parentBlockId,
          afterBlockId: targetBlockId,
          block: block as DocumentBlock,
        },
      ]),
    );
  }

  splitBlock(
    targetBlockId: string,
    textOffset: number,
    operationId = makeOperationId(),
  ): ApplyOperationResult {
    const location = locateBlock(this.getSnapshot(), targetBlockId);
    if (!location) {
      return operationFailure(operationId, "target-missing", "Target Block does not exist.");
    }
    if (
      !Number.isSafeInteger(textOffset) ||
      textOffset < 0 ||
      !["paragraph", "heading", "codeBlock"].includes(location.block.type)
    ) {
      return operationFailure(
        operationId,
        "invalid-operation",
        "Only paragraph, heading, and code Blocks can be split at a text offset.",
      );
    }
    const block = location.block as unknown as Record<string, unknown>;
    const inlineContent = Array.isArray(block.content)
      ? (block.content as Record<string, unknown>[])
      : [];
    const split = splitInlineContent(inlineContent, textOffset);
    if (!split) {
      return operationFailure(
        operationId,
        "invalid-operation",
        "Text offset is outside the Block.",
      );
    }

    const left = structuredClone(block);
    const right = structuredClone(block);
    const rightAttrs = {
      ...(typeof right.attrs === "object" && right.attrs !== null
        ? (right.attrs as Record<string, unknown>)
        : {}),
      blockId: createBlockId(),
    };
    left.content = split[0].length > 0 ? split[0] : undefined;
    right.content = split[1].length > 0 ? split[1] : undefined;
    left.attrs = structuredClone(block.attrs);
    right.attrs = rightAttrs;
    if (left.content === undefined) delete left.content;
    if (right.content === undefined) delete right.content;

    return this.applyOperations(
      this.createOperationBatch(operationId, [
        {
          type: "replace-block",
          targetBlockId,
          block: left as unknown as DocumentBlock,
        },
        {
          type: "insert-block",
          parentBlockId: location.parentBlockId,
          afterBlockId: targetBlockId,
          block: right as unknown as DocumentBlock,
        },
      ]),
    );
  }

  mergeBlocks(
    firstBlockId: string,
    secondBlockId: string,
    operationId = makeOperationId(),
  ): ApplyOperationResult {
    const content = this.getSnapshot();
    const first = locateBlock(content, firstBlockId);
    const second = locateBlock(content, secondBlockId);
    if (!first || !second) {
      return operationFailure(operationId, "target-missing", "Both Blocks must exist to merge.");
    }
    if (
      first.parentBlockId !== second.parentBlockId ||
      first.siblings !== second.siblings ||
      second.index !== first.index + 1 ||
      first.block.type !== second.block.type ||
      !["paragraph", "heading", "codeBlock"].includes(first.block.type)
    ) {
      return operationFailure(
        operationId,
        "invalid-operation",
        "Only adjacent paragraph, heading, or code Blocks can be merged.",
      );
    }
    const firstNode = first.block as unknown as Record<string, unknown>;
    const secondNode = second.block as unknown as Record<string, unknown>;
    const merged = structuredClone(firstNode);
    merged.content = [
      ...(Array.isArray(firstNode.content) ? firstNode.content : []),
      ...(Array.isArray(secondNode.content) ? secondNode.content : []),
    ];
    if ((merged.content as unknown[]).length === 0) delete merged.content;

    return this.applyOperations(
      this.createOperationBatch(operationId, [
        {
          type: "replace-block",
          targetBlockId: firstBlockId,
          block: merged as unknown as DocumentBlock,
        },
        { type: "delete-block", targetBlockId: secondBlockId },
      ]),
    );
  }

  moveBlock(
    targetBlockId: string,
    parentBlockId: string | null,
    position: { beforeBlockId?: string; afterBlockId?: string } = {},
    operationId = makeOperationId(),
  ): ApplyOperationResult {
    const operation: DocumentOperation = {
      type: "move-block",
      targetBlockId,
      parentBlockId,
      ...(position.beforeBlockId ? { beforeBlockId: position.beforeBlockId } : {}),
      ...(position.afterBlockId ? { afterBlockId: position.afterBlockId } : {}),
    };
    return this.applyOperations(this.createOperationBatch(operationId, [operation]));
  }

  changeBlockType(
    targetBlockId: string,
    type: "paragraph" | "heading" | "codeBlock" | "taskItem",
    options: { level?: number; language?: string } = {},
    operationId = makeOperationId(),
  ): ApplyOperationResult {
    const location = locateBlock(this.getSnapshot(), targetBlockId);
    if (!location) {
      return operationFailure(operationId, "target-missing", "Target Block does not exist.");
    }
    if (!["paragraph", "heading", "codeBlock", "taskItem"].includes(location.block.type)) {
      return operationFailure(
        operationId,
        "invalid-operation",
        "Only paragraph, heading, and code Blocks can be converted.",
      );
    }
    const oldNode = location.block as unknown as Record<string, unknown>;
    const oldAttrs =
      typeof oldNode.attrs === "object" && oldNode.attrs !== null
        ? (oldNode.attrs as Record<string, unknown>)
        : {};
    const attrs: Record<string, unknown> = { blockId: targetBlockId };
    if (type === "heading") {
      const level = options.level ?? (typeof oldAttrs.level === "number" ? oldAttrs.level : 1);
      if (!Number.isInteger(level) || level < 1 || level > 6) {
        return operationFailure(
          operationId,
          "invalid-operation",
          "Heading level must be 1 through 6.",
        );
      }
      attrs.level = level;
    }
    if (type === "codeBlock") {
      const language = options.language ?? oldAttrs.language;
      if (typeof language === "string") attrs.language = language;
    }
    if (type === "taskItem") attrs.checked = false;
    if (
      location.block.type === "taskItem" &&
      type !== "taskItem" &&
      Array.isArray(oldNode.content) &&
      oldNode.content.some(
        (child) =>
          typeof child === "object" &&
          child !== null &&
          "type" in child &&
          child.type === "taskList",
      )
    ) {
      return operationFailure(
        operationId,
        "invalid-operation",
        "A task item with nested tasks cannot be converted to a text block.",
      );
    }
    const converted: Record<string, unknown> = {
      type,
      attrs,
      ...(Array.isArray(oldNode.content) ? { content: structuredClone(oldNode.content) } : {}),
    };
    if (type === "codeBlock" && Array.isArray(converted.content)) {
      converted.content = converted.content.map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
        const textNode = { ...(item as Record<string, unknown>) };
        delete textNode.marks;
        return textNode;
      });
    }

    return this.applyOperations(
      this.createOperationBatch(operationId, [
        {
          type: "replace-block",
          targetBlockId,
          block: converted as unknown as DocumentBlock,
        },
      ]),
    );
  }

  indentListItem(targetBlockId: string): boolean {
    return this.changeListIndent(targetBlockId, "indent");
  }

  outdentListItem(targetBlockId: string): boolean {
    return this.changeListIndent(targetBlockId, "outdent");
  }

  setEditable(editable: boolean, reason?: string): void {
    this.assertActive();
    this.readOnlyReason = editable ? undefined : reason;
    this.editor.setEditable(editable);
    this.updateEditorAttributes({ "aria-readonly": String(!editable) });
  }

  setAriaLabel(label: string, describedBy?: string): void {
    this.assertActive();
    const attributes: Record<string, string> = {
      role: "textbox",
      "aria-label": label,
      "aria-multiline": "true",
      "aria-readonly": String(!this.editor.isEditable),
    };
    if (describedBy) attributes["aria-describedby"] = describedBy;
    this.updateEditorAttributes(attributes, describedBy ? [] : ["aria-describedby"]);
  }

  canExecute(command: EditorCommand): EditorCapability {
    if (this.destroyed) return { allowed: false, reason: "destroyed" };
    if (command === "copy") return { allowed: true };
    if (!this.editor.isEditable) return { allowed: false, reason: "read-only" };
    if (command === "block-structure") {
      return this.collaborationStructureDisabled
        ? { allowed: false, reason: "collaboration-structure-disabled" }
        : { allowed: true };
    }
    if (command === "table-structure") {
      return this.getTableDimensions()
        ? { allowed: true }
        : { allowed: false, reason: "not-in-table" };
    }
    if (command === "undo")
      return this.editor.can().undo()
        ? { allowed: true }
        : { allowed: false, reason: "empty-history" };
    if (command === "redo")
      return this.editor.can().redo()
        ? { allowed: true }
        : { allowed: false, reason: "empty-history" };
    return { allowed: true };
  }

  getTableDimensions(): { rows: number; columns: number } | null {
    const { $from } = this.editor.state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name !== "table") continue;
      const map = TableMap.get(node);
      return { rows: map.height, columns: map.width };
    }
    return null;
  }

  canRunTableCommand(command: EditorTableCommand): boolean {
    if (!this.canExecute("table-structure").allowed) return false;
    const dimensions = this.getTableDimensions();
    if (!dimensions) return false;
    if ((command === "addRowBefore" || command === "addRowAfter") && dimensions.rows >= 100) {
      return false;
    }
    if (
      (command === "addColumnBefore" || command === "addColumnAfter") &&
      dimensions.columns >= 20
    ) {
      return false;
    }
    return this.editor.can()[command]();
  }

  runTableCommand(command: EditorTableCommand): boolean {
    if (!this.canRunTableCommand(command)) return false;
    const chain = this.editor.chain().focus().setMeta(editorOriginMeta, "host-command");
    return chain[command]().run();
  }

  toggleBold(): boolean {
    return (
      this.canExecute("write").allowed &&
      this.editor.chain().focus().setMeta(editorOriginMeta, "host-command").toggleBold().run()
    );
  }

  toggleItalic(): boolean {
    return (
      this.canExecute("write").allowed &&
      this.editor.chain().focus().setMeta(editorOriginMeta, "host-command").toggleItalic().run()
    );
  }

  toggleStrike(): boolean {
    return (
      this.canExecute("write").allowed &&
      this.editor.chain().focus().setMeta(editorOriginMeta, "host-command").toggleStrike().run()
    );
  }

  toggleUnderline(): boolean {
    return (
      this.canExecute("write").allowed &&
      this.editor
        .chain()
        .focus()
        .setMeta(editorOriginMeta, "host-command")
        .toggleMark("underline")
        .run()
    );
  }

  setHighlightColor(color: HighlightColor): boolean {
    return (
      this.canExecute("write").allowed &&
      HIGHLIGHT_COLORS.includes(color) &&
      this.editor
        .chain()
        .focus()
        .setMeta(editorOriginMeta, "host-command")
        .setMark("highlight", { color })
        .run()
    );
  }

  unsetHighlight(): boolean {
    return (
      this.canExecute("write").allowed &&
      this.editor
        .chain()
        .focus()
        .setMeta(editorOriginMeta, "host-command")
        .unsetMark("highlight")
        .run()
    );
  }

  setTextAlignment(alignment: TextAlignment): boolean {
    return (
      this.canExecute("write").allowed &&
      TEXT_ALIGNMENTS.includes(alignment) &&
      this.editor
        .chain()
        .focus()
        .setMeta(editorOriginMeta, "host-command")
        .updateAttributes("paragraph", { align: alignment })
        .updateAttributes("heading", { align: alignment })
        .run()
    );
  }

  clearFormatting(): boolean {
    if (!this.canExecute("write").allowed) return false;
    return this.editor
      .chain()
      .focus()
      .setMeta(editorOriginMeta, "host-command")
      .unsetAllMarks()
      .updateAttributes("paragraph", { align: null })
      .updateAttributes("heading", { align: null })
      .run();
  }

  setParagraph(): boolean {
    return this.changeCurrentBlockType("paragraph");
  }

  setHeading(level: number): boolean {
    if (!Number.isInteger(level) || level < 1 || level > 6) return false;
    return this.changeCurrentBlockType("heading", { level });
  }

  toggleBulletList(): boolean {
    return this.runBlockCommand((chain) => chain.toggleBulletList().run());
  }

  toggleOrderedList(): boolean {
    return this.runBlockCommand((chain) => chain.toggleOrderedList().run());
  }

  toggleBlockquote(): boolean {
    return this.runBlockCommand((chain) => chain.toggleBlockquote().run());
  }

  setCodeBlock(language?: string): boolean {
    if (language !== undefined && !/^[A-Za-z0-9_+-]{1,32}$/.test(language)) return false;
    return this.runBlockCommand((chain) =>
      chain.setCodeBlock(language ? { language } : undefined).run(),
    );
  }

  setHorizontalRule(): boolean {
    return this.runBlockCommand((chain) => chain.setHorizontalRule().run());
  }

  makeTaskItem(targetBlockId?: string): boolean {
    const blockId = targetBlockId ?? this.editor.state.selection.$from.parent.attrs.blockId;
    if (typeof blockId !== "string" || !this.canExecute("block-structure").allowed) return false;
    return this.applyStructureAction({ type: "make-task-item", targetBlockId: blockId });
  }

  insertNestedTaskList(parentBlockId?: string): boolean {
    let blockId = parentBlockId;
    if (!blockId) {
      const { $from } = this.editor.state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        if ($from.node(depth).type.name !== "taskItem") continue;
        const candidate = $from.node(depth).attrs.blockId;
        if (typeof candidate === "string") blockId = candidate;
        break;
      }
    }
    if (!blockId || !this.canExecute("block-structure").allowed) return false;
    return this.applyStructureAction({ type: "insert-nested-task-list", parentBlockId: blockId });
  }

  toggleCode(): boolean {
    return (
      this.canExecute("write").allowed &&
      this.editor.chain().focus().setMeta(editorOriginMeta, "host-command").toggleCode().run()
    );
  }

  undo(): boolean {
    return (
      this.canExecute("undo").allowed &&
      this.editor.chain().focus().setMeta(editorOriginMeta, "undo").undo().run()
    );
  }

  redo(): boolean {
    return (
      this.canExecute("redo").allowed &&
      this.editor.chain().focus().setMeta(editorOriginMeta, "redo").redo().run()
    );
  }

  findBlock(id: string): IndexedBlock | undefined {
    this.assertActive();
    return findIndexedBlock(this.editor, id);
  }

  focusBlock(id: string, options: { scrollIntoView?: boolean } = {}): boolean {
    this.assertActive();
    const block = findIndexedBlock(this.editor, id);
    if (!block) return false;
    const position = Math.min(block.position + 1, this.editor.state.doc.content.size);
    const selection = TextSelection.near(this.editor.state.doc.resolve(position), 1);
    const scrollIntoView = options.scrollIntoView ?? true;
    const transaction = this.editor.state.tr.setSelection(selection);
    if (scrollIntoView) transaction.scrollIntoView();
    this.editor.view.dispatch(transaction);
    this.editor.commands.focus(undefined, { scrollIntoView });
    return true;
  }

  findText(query: string, options: { caseSensitive?: boolean } = {}): EditorTextMatch[] {
    this.assertActive();
    if (query.length === 0) return [];
    const caseSensitive = options.caseSensitive ?? false;
    const foldedQuery = caseSensitive ? query : query.toLowerCase();
    if (foldedQuery.length === 0) return [];
    const matches: EditorTextMatch[] = [];
    let text = "";
    const sourceStarts: number[] = [];
    const sourceEnds: number[] = [];
    const sourceBlockIds: string[] = [];
    let previousTextBlockEnd: number | undefined;
    let previousTextBlockId: string | undefined;
    this.editor.state.doc.descendants((node, position) => {
      if (!node.isTextblock) return true;
      const blockId = node.attrs.blockId;
      if (typeof blockId !== "string") return false;

      let blockText = "";
      const blockStarts: number[] = [];
      const blockEnds: number[] = [];
      node.forEach((child, childOffset) => {
        const childPosition = position + 1 + childOffset;
        if (child.isText) {
          const value = child.text ?? "";
          blockText += value;
          let localOffset = 0;
          for (const character of value) {
            const nextOffset = localOffset + character.length;
            for (let index = localOffset; index < nextOffset; index += 1) {
              blockStarts.push(childPosition + localOffset);
              blockEnds.push(childPosition + nextOffset);
            }
            localOffset = nextOffset;
          }
          return;
        }

        const value = child.type.name === "hardBreak" ? "\n" : child.isInline ? "\uFFFC" : "";
        if (value.length > 0) {
          blockText += value;
          for (let index = 0; index < value.length; index += 1) {
            blockStarts.push(childPosition);
            blockEnds.push(childPosition + child.nodeSize);
          }
        }
      });
      if (previousTextBlockEnd !== undefined) {
        text += "\n";
        sourceStarts.push(previousTextBlockEnd);
        sourceEnds.push(position + 1);
        sourceBlockIds.push(previousTextBlockId ?? blockId);
      }
      text += blockText;
      for (let index = 0; index < blockStarts.length; index += 1) {
        sourceStarts.push(blockStarts[index]!);
        sourceEnds.push(blockEnds[index]!);
        sourceBlockIds.push(blockId);
      }
      previousTextBlockEnd = position + node.nodeSize - 1;
      previousTextBlockId = blockId;
      return false;
    });
    if (text.length === 0 || foldedQuery.includes("\uFFFC")) return matches;

    const folded = caseSensitive ? { folded: text, starts: [], ends: [] } : foldWithOffsets(text);
    let cursor = 0;
    while (cursor <= folded.folded.length - foldedQuery.length) {
      const index = folded.folded.indexOf(foldedQuery, cursor);
      if (index < 0) break;
      const localFrom = caseSensitive ? index : folded.starts[index];
      const last = index + foldedQuery.length - 1;
      const localToExclusive = caseSensitive ? index + foldedQuery.length : folded.ends[last];
      const absoluteFrom = localFrom === undefined ? undefined : sourceStarts[localFrom];
      const absoluteTo =
        localToExclusive === undefined ? undefined : sourceEnds[localToExclusive - 1];
      if (
        localFrom !== undefined &&
        localToExclusive !== undefined &&
        absoluteFrom !== undefined &&
        absoluteTo !== undefined
      ) {
        const excerptFrom = Math.max(0, localFrom - 24);
        const excerptTo = Math.min(text.length, localToExclusive + 24);
        const blockId = sourceBlockIds[localFrom];
        if (blockId) {
          matches.push({
            blockId,
            from: absoluteFrom,
            to: absoluteTo,
            excerpt: text.slice(excerptFrom, excerptTo).replaceAll("\uFFFC", "…"),
          });
        }
      }
      cursor = index + 1;
    }
    return matches;
  }

  focusTextRange(from: number, to: number): boolean {
    this.assertActive();
    const doc = this.editor.state.doc;
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > doc.content.size
    ) {
      return false;
    }
    const selection = TextSelection.between(doc.resolve(from), doc.resolve(to));
    this.editor.view.dispatch(this.editor.state.tr.setSelection(selection).scrollIntoView());
    this.editor.commands.focus();
    return true;
  }

  getOutline(): Array<{ blockId: string; level: number; text: string; position: number }> {
    this.assertActive();
    return getIndexedHeadings(this.editor).map((block) => {
      const json = block.json as unknown as {
        attrs?: { level?: unknown };
        content?: Array<{ text?: unknown }>;
      };
      return {
        blockId: block.id,
        level: typeof json.attrs?.level === "number" ? json.attrs.level : 1,
        text:
          json.content?.map((node) => (typeof node.text === "string" ? node.text : "")).join("") ??
          "",
        position: block.position,
      };
    });
  }

  subscribe(listener: EditorTransactionListener): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mount(element: HTMLElement): void {
    this.assertActive();
    if (this.editor.view.dom === element) return;
    this.detachInputTracking();
    this.editor.unmount();
    this.editor.mount(element);
    this.applyManagedEditorAttributes();
    this.attachInputTracking();
  }

  focus(): void {
    this.assertActive();
    this.editor.commands.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.editor.off("transaction", this.transactionHandler);
    this.detachInputTracking();
    this.consumePendingInputOrigin();
    this.listeners.clear();
    this.editor.destroy();
  }

  private assertActive(): void {
    if (this.destroyed) throw new Error("Editor has been destroyed.");
  }

  private createOperationBatch(
    operationId: string,
    operations: DocumentOperation[],
  ): OperationBatch {
    return {
      operationId,
      documentId: this.documentId ?? "doc_local",
      ...(this.generationId ? { generationId: this.generationId } : {}),
      origin: "user",
      operations,
    };
  }

  private changeListIndent(targetBlockId: string, direction: "indent" | "outdent"): boolean {
    if (!this.canExecute("write").allowed || !this.canExecute("block-structure").allowed)
      return false;
    const block = findIndexedBlock(this.editor, targetBlockId);
    if (!block || block.type !== "listItem") return false;
    const position = Math.min(block.position + 1, this.editor.state.doc.content.size);
    const selection = TextSelection.near(this.editor.state.doc.resolve(position), 1);
    const chain = this.editor.chain().focus().setTextSelection(selection.from);
    const command =
      direction === "indent" ? chain.sinkListItem("listItem") : chain.liftListItem("listItem");
    return command.setMeta(editorOriginMeta, "host-command").run();
  }

  private changeCurrentBlockType(
    blockType: "paragraph" | "heading" | "codeBlock",
    options?: { level?: number },
  ): boolean {
    if (!this.canExecute("write").allowed || !this.canExecute("block-structure").allowed) {
      return false;
    }
    const blockId = this.editor.state.selection.$from.parent.attrs.blockId;
    if (typeof blockId !== "string") return false;
    return this.applyStructureAction({
      type: "change-block-type",
      targetBlockId: blockId,
      blockType,
      ...(options ? { options } : {}),
    });
  }

  private applyStructureAction(action: EditorStructureAction): boolean {
    if (!this.canExecute("write").allowed || !this.canExecute("block-structure").allowed) {
      return false;
    }
    const prepared = this.prepareStructureAction(action);
    return prepared.success && this.applyOperations(prepared.batch).success;
  }

  getSelectedBlockIds(): string[] {
    this.assertActive();
    const { selection, doc } = this.editor.state;
    if (selection.$from.parent === selection.$to.parent && selection.$from.parent.isTextblock) {
      const id = selection.$from.parent.attrs.blockId;
      return typeof id === "string" ? [id] : [];
    }
    const ids: string[] = [];
    doc.nodesBetween(selection.from, selection.to, (node) => {
      if (!node.isBlock || typeof node.attrs.blockId !== "string") return;
      ids.push(node.attrs.blockId);
      return false;
    });
    return ids;
  }

  wrapSelectionInCallout(theme: CalloutTheme = "info"): boolean {
    return this.applyStructureAction({
      type: "wrap-callout",
      targetBlockIds: this.getSelectedBlockIds(),
      theme,
    });
  }

  insertStatusTag(status: DocumentStatus = "todo"): boolean {
    if (
      !this.canExecute("write").allowed ||
      !DOCUMENT_STATUSES.includes(status) ||
      !this.editor.state.selection.$from.parent.inlineContent ||
      this.editor.state.selection.$from.parent.type.name === "codeBlock"
    )
      return false;
    return this.editor
      .chain()
      .focus()
      .insertContent({ type: "statusTag", attrs: { status } })
      .setMeta(editorOriginMeta, "host-command")
      .run();
  }

  updateStatusTag(
    position: number,
    expectedStatus: DocumentStatus,
    status: DocumentStatus,
  ): boolean {
    if (!this.canExecute("write").allowed || !DOCUMENT_STATUSES.includes(status)) return false;
    const node = this.editor.state.doc.nodeAt(position);
    if (node?.type.name !== "statusTag" || node.attrs.status !== expectedStatus) return false;
    this.editor.view.dispatch(
      this.editor.state.tr
        .setNodeMarkup(position, undefined, { status })
        .setMeta(editorOriginMeta, "host-command"),
    );
    return this.editor.state.doc.nodeAt(position)?.attrs.status === status;
  }

  private runBlockCommand(run: (chain: ReturnType<Editor["chain"]>) => boolean): boolean {
    if (!this.canExecute("write").allowed || !this.canExecute("block-structure").allowed) {
      return false;
    }
    return run(this.editor.chain().focus().setMeta(editorOriginMeta, "host-command"));
  }

  private attachInputTracking(): void {
    const element = this.editor.view.dom;
    if (this.trackedInputElement === element) return;
    this.detachInputTracking();
    this.trackedInputElement = element;
    element.addEventListener("beforeinput", this.beforeInputHandler, true);
  }

  private detachInputTracking(): void {
    this.trackedInputElement?.removeEventListener("beforeinput", this.beforeInputHandler, true);
    this.trackedInputElement = undefined;
  }

  private consumePendingInputOrigin(): string | undefined {
    if (this.pendingInputClearTimer) clearTimeout(this.pendingInputClearTimer);
    this.pendingInputClearTimer = undefined;
    const origin = this.pendingInputOrigin;
    this.pendingInputOrigin = undefined;
    return origin;
  }

  private updateEditorAttributes(
    updates: Record<string, string>,
    removedAttributes: readonly string[] = [],
  ): void {
    this.managedEditorAttributes = { ...this.managedEditorAttributes, ...updates };
    for (const name of Object.keys(updates)) this.removedEditorAttributes.delete(name);
    for (const name of removedAttributes) {
      delete this.managedEditorAttributes[name];
      this.removedEditorAttributes.add(name);
    }
    this.applyManagedEditorAttributes();
  }

  private applyManagedEditorAttributes(): void {
    const currentProps = this.editor.options.editorProps;
    const baseAttributes = this.baseEditorAttributes;
    const managedAttributes = this.managedEditorAttributes;
    const removed = [...this.removedEditorAttributes];
    const attributes = (state: EditorState): Record<string, string> => {
      const existing =
        typeof baseAttributes === "function" ? baseAttributes(state) : baseAttributes;
      const next = { ...existing, ...managedAttributes };
      for (const name of removed) delete next[name];
      return next;
    };
    this.editor.setOptions({ editorProps: { ...currentProps, attributes } });
  }
}

export function createEditor(options: CreateEditorOptions = {}): EditorController {
  return new EditorController(options);
}
