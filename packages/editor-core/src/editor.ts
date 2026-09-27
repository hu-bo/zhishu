import { Editor, getSchema } from "@tiptap/core";
import type { Extensions, JSONContent } from "@tiptap/core";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import {
  applyOperationBatch,
  createBlockId,
  normalizeDocumentContent,
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

type EditorAttributeSource =
  Record<string, string> | ((state: EditorState) => Record<string, string>) | undefined;

export interface EditorTransactionEvent {
  origin: string | undefined;
  operationId: string | undefined;
  docChanged: boolean;
  selectionChanged: boolean;
}

export type EditorStructureAction =
  | { type: "insert-image"; assetId: string; mediaType: string; alt: string }
  | { type: "duplicate-block"; targetBlockId: string }
  | { type: "delete-block"; targetBlockId: string }
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
export type EditorCommand = "write" | "undo" | "redo" | "copy" | "block-structure";

export interface EditorCapability {
  allowed: boolean;
  reason?: "read-only" | "empty-history" | "destroyed" | "collaboration-structure-disabled";
}

export interface CreateEditorOptions {
  element?: HTMLElement | null;
  content?: unknown;
  documentId?: string;
  generationId?: string;
  editable?: boolean;
  readOnlyReason?: string;
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
      additionalExtensions: options.extensions,
      onLinkClick: options.onLinkClick,
      onLimitExceeded: options.onLimitExceeded,
      collaborative: options.collaborative,
      collaborationStructure,
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

    const nextNode = this.editor.schema.nodeFromJSON(result.content as JSONContent);
    nextNode.check();
    const transaction = this.editor.state.tr.replaceWith(
      0,
      this.editor.state.doc.content.size,
      nextNode.content,
    );
    transaction.setMeta(editorOriginMeta, batch.origin);
    transaction.setMeta(editorOperationMeta, batch.operationId);
    this.editor.view.dispatch(transaction);
    return result;
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
      const lastBlockId = blocks.at(-1)?.attrs?.blockId;
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
    const result = applyOperationBatch(content, batch, {
      documentId: this.documentId ?? batch.documentId,
      generationId: this.generationId,
      readOnly: !this.editor.isEditable,
      hashBlock: this.hashBlock,
    });
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
    type: "paragraph" | "heading" | "codeBlock",
    options: { level?: number; language?: string } = {},
    operationId = makeOperationId(),
  ): ApplyOperationResult {
    const location = locateBlock(this.getSnapshot(), targetBlockId);
    if (!location) {
      return operationFailure(operationId, "target-missing", "Target Block does not exist.");
    }
    if (!["paragraph", "heading", "codeBlock"].includes(location.block.type)) {
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
    if (command === "block-structure") {
      return this.collaborationStructureDisabled
        ? { allowed: false, reason: "collaboration-structure-disabled" }
        : { allowed: true };
    }
    if (!this.editor.isEditable) return { allowed: false, reason: "read-only" };
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

  focusBlock(id: string): boolean {
    this.assertActive();
    const block = findIndexedBlock(this.editor, id);
    if (!block) return false;
    const position = Math.min(block.position + 1, this.editor.state.doc.content.size);
    const selection = TextSelection.near(this.editor.state.doc.resolve(position), 1);
    this.editor.view.dispatch(this.editor.state.tr.setSelection(selection).scrollIntoView());
    this.editor.commands.focus();
    return true;
  }

  findText(query: string, options: { caseSensitive?: boolean } = {}): EditorTextMatch[] {
    this.assertActive();
    if (query.length === 0) return [];
    const caseSensitive = options.caseSensitive ?? false;
    const foldedQuery = caseSensitive ? query : query.toLowerCase();
    if (foldedQuery.length === 0) return [];
    const matches: EditorTextMatch[] = [];
    this.editor.state.doc.descendants((node, position) => {
      if (!node.isTextblock) return true;
      const blockId = node.attrs.blockId;
      if (typeof blockId !== "string") return false;

      let text = "";
      const sourceStarts: number[] = [];
      const sourceEnds: number[] = [];
      node.forEach((child, childOffset) => {
        const childPosition = position + 1 + childOffset;
        if (child.isText) {
          const value = child.text ?? "";
          text += value;
          let localOffset = 0;
          for (const character of value) {
            const nextOffset = localOffset + character.length;
            for (let index = localOffset; index < nextOffset; index += 1) {
              sourceStarts.push(childPosition + localOffset);
              sourceEnds.push(childPosition + nextOffset);
            }
            localOffset = nextOffset;
          }
          return;
        }

        const value = child.type.name === "hardBreak" ? "\n" : child.isInline ? "\uFFFC" : "";
        if (value.length > 0) {
          text += value;
          sourceStarts.push(childPosition);
          sourceEnds.push(childPosition + child.nodeSize);
        }
      });
      if (text.length === 0 || foldedQuery.includes("\uFFFC")) return false;

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
          matches.push({
            blockId,
            from: absoluteFrom,
            to: absoluteTo,
            excerpt: text.slice(excerptFrom, excerptTo).replaceAll("\uFFFC", "…"),
          });
        }
        cursor = index + 1;
      }
      return false;
    });
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
