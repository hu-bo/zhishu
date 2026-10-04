import Collaboration from "@tiptap/extension-collaboration";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  yUndoPluginKey,
} from "@tiptap/y-tiptap";
import { checkAnchorContext } from "@zhishu/document-contracts";
import type { Anchor, AnchorTargetStatus } from "@zhishu/document-contracts";
import * as Y from "yjs";
import type {
  CollaborationPresenceInput,
  CollaborationPresenceListener,
  CollaborationPresenceState,
  CollaborationStatus,
} from "./index.js";

export type TiptapCollaborationExtensionOptions = Pick<
  NonNullable<Parameters<typeof Collaboration.configure>[0]>,
  "ySyncOptions" | "onFirstRender"
>;

/**
 * Creates the Tiptap binding for a synchronized Y.Doc. Create the editor only after the
 * collaboration session reports `sync: "current"` so UniqueID cannot seed stale local content.
 */
export function createTiptapCollaborationExtension(
  document: Y.Doc,
  field = "content",
  options: TiptapCollaborationExtensionOptions = {},
): Extension {
  if (field.length === 0) throw new TypeError("The collaboration field must not be empty.");
  return Collaboration.configure({ document, field, ...options });
}

export function isTiptapCollaborationFieldEmpty(document: Y.Doc, field = "content"): boolean {
  return document.getXmlFragment(field).length === 0;
}

function decodeRelativePositionToken(token: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,1024}$/u.test(token)) throw new TypeError("invalid-presence-position");
  const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
  if (normalized.length % 4 === 1) throw new TypeError("invalid-presence-position");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") !== token) {
    throw new TypeError("invalid-presence-position");
  }
  return bytes;
}

function encodeRelativePositionToken(position: Y.RelativePosition): string {
  return toBase64(Y.encodeRelativePosition(position))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function createPresenceSelection(
  state: Editor["state"],
  yDocument: Y.Doc,
  field: string,
): NonNullable<CollaborationPresenceInput["selection"]> {
  const syncState = ySyncPluginKey.getState(state) as
    { doc?: Y.Doc; type?: Y.XmlFragment; binding?: { mapping: ProsemirrorMapping } } | undefined;
  const fragment = yDocument.getXmlFragment(field);
  if (syncState?.doc !== yDocument || syncState.type !== fragment || !syncState.binding) {
    throw new TypeError("The editor is not bound to this collaboration document and field.");
  }
  return {
    anchor: encodeRelativePositionToken(
      absolutePositionToRelativePosition(
        state.selection.anchor,
        fragment,
        syncState.binding.mapping,
      ),
    ),
    head: encodeRelativePositionToken(
      absolutePositionToRelativePosition(state.selection.head, fragment, syncState.binding.mapping),
    ),
  };
}

/** Captures a Tiptap selection as generation-local Base64URL Yjs relative positions. */
export function createTiptapPresenceSelection(
  editor: Editor,
  document: Y.Doc,
  field = "content",
): NonNullable<CollaborationPresenceInput["selection"]> {
  getBinding(editor, document, field);
  return createPresenceSelection(editor.state, document, field);
}

function publishLocalPresenceSelection(
  state: Editor["state"],
  yDocument: Y.Doc,
  session: TiptapPresenceSession,
  field: string,
): void {
  const localPresence = session.getPresences().find((presence) => presence.local);
  if (!localPresence) return;
  try {
    session.setPresence({
      displayName: localPresence.displayName,
      color: localPresence.color,
      selection: createPresenceSelection(state, yDocument, field),
    });
  } catch {
    // Presence is ephemeral; stale bindings and invalid positions must not affect editing.
  }
}

function createPresenceDecorations(
  state: Editor["state"],
  yDocument: Y.Doc,
  session: TiptapPresenceSession,
  field: string,
): DecorationSet {
  if (session.getStatus().sync !== "current") return DecorationSet.empty;
  const syncState = ySyncPluginKey.getState(state) as
    { doc?: Y.Doc; type?: Y.XmlFragment; binding?: { mapping: ProsemirrorMapping } } | undefined;
  const fragment = yDocument.getXmlFragment(field);
  if (syncState?.doc !== yDocument || syncState.type !== fragment || !syncState.binding) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  for (const presence of session.getPresences()) {
    if (presence.local || !presence.selection || !/^#[0-9A-Fa-f]{6}$/u.test(presence.color))
      continue;
    try {
      const anchor = Y.decodeRelativePosition(
        decodeRelativePositionToken(presence.selection.anchor),
      );
      const head = Y.decodeRelativePosition(decodeRelativePositionToken(presence.selection.head));
      const from = relativePositionToAbsolutePosition(
        yDocument,
        fragment,
        anchor,
        syncState.binding.mapping,
      );
      const to = relativePositionToAbsolutePosition(
        yDocument,
        fragment,
        head,
        syncState.binding.mapping,
      );
      if (
        from === null ||
        to === null ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 0 ||
        to < 0 ||
        from > state.doc.content.size ||
        to > state.doc.content.size
      ) {
        continue;
      }

      if (from !== to) {
        decorations.push(
          Decoration.inline(Math.min(from, to), Math.max(from, to), {
            class: "zhishu-collaboration-selection",
            style: `background-color: ${presence.color}33;`,
            "data-client-id": String(presence.clientId),
          }),
        );
      }

      if (typeof globalThis.document === "undefined") continue;
      const cursor = globalThis.document.createElement("span");
      cursor.className = "zhishu-collaboration-cursor";
      cursor.setAttribute("aria-hidden", "true");
      cursor.contentEditable = "false";
      cursor.style.position = "relative";
      cursor.style.marginLeft = "-1px";
      cursor.style.marginRight = "-1px";
      cursor.style.borderLeft = `2px solid ${presence.color}`;
      cursor.style.pointerEvents = "none";
      cursor.style.userSelect = "none";
      const label = globalThis.document.createElement("span");
      label.className = "zhishu-collaboration-cursor-label";
      label.textContent = presence.displayName;
      label.style.backgroundColor = presence.color;
      label.style.position = "absolute";
      label.style.left = "-1px";
      label.style.top = "-1.5em";
      label.style.padding = "1px 4px";
      label.style.borderRadius = "3px";
      label.style.color = "#fff";
      label.style.fontSize = "11px";
      label.style.lineHeight = "1.4";
      label.style.whiteSpace = "nowrap";
      cursor.append(label);
      decorations.push(
        Decoration.widget(to, cursor, {
          key: `zhishu-presence-${presence.clientId}`,
          side: from <= to ? 1 : -1,
        }),
      );
    } catch {
      continue;
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

/** Renders remote generation-local selections over a synchronized Tiptap XmlFragment. */
export function createTiptapPresenceExtension(
  document: Y.Doc,
  session: TiptapPresenceSession,
  field = "content",
): Extension {
  if (field.length === 0) throw new TypeError("The collaboration field must not be empty.");
  return Extension.create({
    name: "zhishuCollaborationPresence",
    addProseMirrorPlugins() {
      const key = new PluginKey<DecorationSet>();
      return [
        new Plugin<DecorationSet>({
          key,
          state: {
            init: () => DecorationSet.empty,
            apply: (transaction, decorations, _oldState, newState) =>
              transaction.docChanged || transaction.getMeta(key)
                ? createPresenceDecorations(newState, document, session, field)
                : decorations,
          },
          props: {
            decorations: (state) => key.getState(state) ?? DecorationSet.empty,
          },
          view: (view) => {
            publishLocalPresenceSelection(view.state, document, session, field);
            let destroyed = false;
            let refreshScheduled = false;
            const scheduleRefresh = () => {
              if (destroyed || refreshScheduled || view.isDestroyed) return;
              refreshScheduled = true;
              queueMicrotask(() => {
                refreshScheduled = false;
                if (!destroyed && !view.isDestroyed)
                  view.dispatch(view.state.tr.setMeta(key, true));
              });
            };
            const unsubscribe = session.subscribePresence(scheduleRefresh);
            return {
              update: (nextView, previousState) => {
                if (!nextView.state.selection.eq(previousState.selection)) {
                  publishLocalPresenceSelection(nextView.state, document, session, field);
                }
              },
              destroy: () => {
                destroyed = true;
                unsubscribe();
              },
            };
          },
        }),
      ];
    },
  });
}

/** Isolates one synchronous local action from surrounding collaborative undo captures. */
export function runTiptapCollaborationUndoGroup(editor: Editor, apply: () => void): void {
  const pluginState = yUndoPluginKey.getState(editor.state) as
    { undoManager?: Y.UndoManager } | undefined;
  if (!pluginState?.undoManager) {
    throw new TypeError("The editor does not have an active Tiptap collaboration undo manager.");
  }
  const undoManager = pluginState.undoManager;
  undoManager.stopCapturing();
  try {
    const result = apply() as unknown;
    if (typeof result === "object" && result !== null && "then" in result) {
      throw new TypeError("A collaborative undo group must apply synchronously.");
    }
  } finally {
    undoManager.stopCapturing();
  }
}

export type TiptapAnchorContext = Pick<Anchor, "documentId" | "generationId">;

export type TiptapAnchorResolution =
  | { status: "current"; from: number; to: number }
  | { status: Exclude<AnchorTargetStatus, "current"> | "invalid-anchor" };

type ProsemirrorMapping = Parameters<typeof absolutePositionToRelativePosition>[2];
type AnchorPositionMapping = { revision: number; mapping: Mapping };
type AnchorPositionHistory = {
  revision: number;
  firstRevision: number;
  mappings: AnchorPositionMapping[];
};

const anchorPositionHistoryLimit = 512;
const anchorPositionHistories = new WeakMap<Editor, AnchorPositionHistory>();

function anchorPositionHistory(editor: Editor): AnchorPositionHistory {
  const existing = anchorPositionHistories.get(editor);
  if (existing) return existing;

  const history: AnchorPositionHistory = { revision: 0, firstRevision: 0, mappings: [] };
  anchorPositionHistories.set(editor, history);
  editor.on("transaction", ({ transaction }) => {
    if (!transaction.docChanged) return;
    history.revision += 1;
    history.mappings.push({ revision: history.revision, mapping: transaction.mapping });
    if (history.mappings.length > anchorPositionHistoryLimit) {
      const removed = history.mappings.shift();
      if (removed) history.firstRevision = removed.revision;
    }
  });
  editor.on("destroy", () => anchorPositionHistories.delete(editor));
  return history;
}

function mapAnchorPositions(editor: Editor, anchor: Anchor): { from: number; to: number } | null {
  const { positionRevision, startPosition, endPosition } = anchor;
  const history = anchorPositionHistories.get(editor);
  if (
    !history ||
    !Number.isSafeInteger(positionRevision) ||
    !Number.isSafeInteger(startPosition) ||
    !Number.isSafeInteger(endPosition) ||
    positionRevision === undefined ||
    startPosition === undefined ||
    endPosition === undefined ||
    positionRevision < history.firstRevision ||
    positionRevision > history.revision
  ) {
    return null;
  }

  let from = startPosition;
  let to = endPosition;
  const endAssoc = anchor.start === anchor.end ? 1 : -1;
  for (const entry of history.mappings) {
    if (entry.revision <= positionRevision) continue;
    from = entry.mapping.map(from, 1);
    to = entry.mapping.map(to, endAssoc);
  }
  return { from, to };
}

export interface TiptapPresenceSession {
  getStatus(): Pick<CollaborationStatus, "sync">;
  getPresences(): readonly CollaborationPresenceState[];
  setPresence(presence: CollaborationPresenceInput): void;
  subscribePresence(listener: CollaborationPresenceListener): () => void;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new TypeError("invalid-anchor-position");
  const unpadded = value.replace(/=+$/u, "");
  if (unpadded.length % 4 === 1) throw new TypeError("invalid-anchor-position");
  const padded = unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (toBase64(bytes) !== padded) throw new TypeError("invalid-anchor-position");
  return bytes;
}

function blockIdFromNode(node: Editor["state"]["doc"] | null): string | null {
  if (!node) return null;
  const blockId = (node.attrs as Record<string, unknown>).blockId;
  if (typeof blockId === "string") return blockId;
  for (let index = 0; index < node.childCount; index += 1) {
    const nested = blockIdFromNode(node.child(index));
    if (nested) return nested;
  }
  return null;
}

function blockIdAtPosition(
  editor: Editor,
  position: number,
  prefer: "before" | "after",
): string | null {
  const resolved = editor.state.doc.resolve(position);
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const blockId = (resolved.node(depth).attrs as Record<string, unknown>).blockId;
    if (typeof blockId === "string") return blockId;
  }
  const preferred = prefer === "before" ? resolved.nodeBefore : resolved.nodeAfter;
  const fallback = prefer === "before" ? resolved.nodeAfter : resolved.nodeBefore;
  return blockIdFromNode(preferred) ?? blockIdFromNode(fallback);
}

function getBlockIds(editor: Editor): Set<string> {
  const blockIds = new Set<string>();
  editor.state.doc.descendants((node) => {
    const blockId = (node.attrs as Record<string, unknown>).blockId;
    if (typeof blockId === "string") blockIds.add(blockId);
  });
  return blockIds;
}

type BlockContentRange = {
  from: number;
  node: ProseMirrorNode;
  position: number;
  to: number;
};

function blockContentRange(editor: Editor, blockId: string): BlockContentRange | null {
  let range: BlockContentRange | null = null;
  editor.state.doc.descendants((node, position) => {
    if ((node.attrs as Record<string, unknown>).blockId !== blockId) return;
    range = {
      from: node.isLeaf ? position : position + 1,
      node,
      position,
      to: node.isLeaf ? position + node.nodeSize : position + node.nodeSize - 1,
    };
    return false;
  });
  return range;
}

function blockOffsetAtPosition(editor: Editor, blockId: string, position: number): number | null {
  const range = blockContentRange(editor, blockId);
  if (!range || position < range.from || position > range.to) return null;
  return position - range.from;
}

function positionAtBlockOffset(editor: Editor, blockId: string, offset: number): number | null {
  let current = blockContentRange(editor, blockId);
  if (!current) return null;
  let remaining = offset;

  while (current) {
    const contentSize = current.to - current.from;
    if (remaining <= contentSize) return current.from + remaining;
    if (current.node.isLeaf) return null;
    remaining -= contentSize;

    const resolved = editor.state.doc.resolve(current.position);
    const sibling = resolved.parent.maybeChild(resolved.index() + 1);
    if (!sibling || sibling.type !== current.node.type || sibling.isLeaf) return null;

    const position: number = current.position + current.node.nodeSize;
    current = {
      from: position + 1,
      node: sibling,
      position,
      to: position + sibling.nodeSize - 1,
    };
  }
  return null;
}

function resolveBlockOffsets(editor: Editor, anchor: Anchor): { from: number; to: number } | null {
  if (
    !Number.isSafeInteger(anchor.startOffset) ||
    !Number.isSafeInteger(anchor.endOffset) ||
    anchor.startOffset === undefined ||
    anchor.endOffset === undefined
  ) {
    return null;
  }
  const startBlock = blockContentRange(editor, anchor.startBlockId);
  const start = positionAtBlockOffset(editor, anchor.startBlockId, anchor.startOffset);
  let end = positionAtBlockOffset(editor, anchor.endBlockId, anchor.endOffset);
  if (
    end === null &&
    startBlock &&
    anchor.startBlockId !== anchor.endBlockId &&
    Number.isSafeInteger(anchor.startBlockLength) &&
    anchor.startBlockLength !== undefined &&
    getBlockIds(editor).has(anchor.startBlockId) &&
    !getBlockIds(editor).has(anchor.endBlockId)
  ) {
    const mergedOffset = anchor.startBlockLength + anchor.endOffset;
    if (mergedOffset <= startBlock.to - startBlock.from) end = startBlock.from + mergedOffset;
  }
  if (start === null || end === null || start > end) return null;
  return { from: start, to: end };
}

function rangeMatchesStoredBlocks(
  editor: Editor,
  anchor: Anchor,
  range: { from: number; to: number },
  blockIds: ReadonlySet<string>,
): boolean {
  const startBlockId = blockIdAtPosition(editor, range.from, "after");
  const endBlockId = blockIdAtPosition(
    editor,
    range.to,
    range.from === range.to ? "after" : "before",
  );
  return (
    (!blockIds.has(anchor.startBlockId) || startBlockId === anchor.startBlockId) &&
    (!blockIds.has(anchor.endBlockId) || endBlockId === anchor.endBlockId)
  );
}

function getBinding(editor: Editor, document: Y.Doc, field: string) {
  const syncState = ySyncPluginKey.getState(editor.state) as
    { doc?: Y.Doc; type?: Y.XmlFragment; binding?: { mapping: ProsemirrorMapping } } | undefined;
  if (field.length === 0) throw new TypeError("The collaboration field must not be empty.");
  const fragment = document.getXmlFragment(field);
  if (syncState?.doc !== document || syncState.type !== fragment || !syncState.binding) {
    throw new TypeError("The editor is not bound to this collaboration document and field.");
  }
  return { fragment, mapping: syncState.binding.mapping };
}

export function createTiptapAnchor(
  editor: Editor,
  document: Y.Doc,
  context: TiptapAnchorContext,
  field = "content",
): Anchor {
  const selection = editor.state.selection;
  return createTiptapAnchorFromRange(
    editor,
    document,
    context,
    selection.from,
    selection.to,
    field,
  );
}

export function createTiptapAnchorFromRange(
  editor: Editor,
  document: Y.Doc,
  context: TiptapAnchorContext,
  from: number,
  to: number,
  field = "content",
): Anchor {
  const docSize = editor.state.doc.content.size;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > docSize
  ) {
    throw new TypeError("invalid-anchor-range");
  }
  const startBlockId = blockIdAtPosition(editor, from, "after");
  const endBlockId = blockIdAtPosition(editor, to, from === to ? "after" : "before");
  if (!startBlockId || !endBlockId) throw new TypeError("The selection has no addressable Blocks.");

  const { fragment, mapping } = getBinding(editor, document, field);
  const startBlock = blockContentRange(editor, startBlockId);
  const startOffset = blockOffsetAtPosition(editor, startBlockId, from);
  const endOffset = blockOffsetAtPosition(editor, endBlockId, to);
  const toAssociatedPosition = (position: number, assoc: number) => {
    const relative = absolutePositionToRelativePosition(position, fragment, mapping);
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, document);
    if (!absolute) throw new TypeError("invalid-anchor-position");
    return Y.createRelativePositionFromTypeIndex(absolute.type, absolute.index, assoc);
  };
  // Keep boundary insertions outside the anchored range: the start follows the
  // character after it, while the end stays attached to the character before it.
  const start = toAssociatedPosition(from, 1);
  const end = toAssociatedPosition(to, from === to ? 1 : -1);
  const positionHistory = anchorPositionHistory(editor);
  return {
    ...context,
    anchorVersion: 1,
    encoding: "yjs-relative-position-v1",
    startBlockId,
    endBlockId,
    positionRevision: positionHistory.revision,
    startPosition: from,
    endPosition: to,
    ...(startOffset !== null ? { startOffset } : {}),
    ...(endOffset !== null ? { endOffset } : {}),
    ...(startBlock ? { startBlockLength: startBlock.to - startBlock.from } : {}),
    selectedTextLength: editor.state.doc.textBetween(from, to, "", "").length,
    start: toBase64(Y.encodeRelativePosition(start)),
    end: toBase64(Y.encodeRelativePosition(end)),
  };
}

export function resolveTiptapAnchor(
  editor: Editor,
  document: Y.Doc,
  anchor: Anchor,
  current: TiptapAnchorContext,
  field = "content",
): TiptapAnchorResolution {
  if (
    anchor.anchorVersion !== 1 ||
    anchor.encoding !== "yjs-relative-position-v1" ||
    typeof anchor.start !== "string" ||
    typeof anchor.end !== "string" ||
    !/^block_[A-Za-z0-9_-]{1,64}$/u.test(anchor.startBlockId) ||
    !/^block_[A-Za-z0-9_-]{1,64}$/u.test(anchor.endBlockId) ||
    anchor.start.length > 8_192 ||
    anchor.end.length > 8_192 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(anchor.start) ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(anchor.end)
  ) {
    return { status: "invalid-anchor" };
  }
  const contextStatus = checkAnchorContext(anchor, current);
  if (contextStatus !== "current") return { status: contextStatus };

  try {
    const blockIds = getBlockIds(editor);
    const { fragment, mapping } = getBinding(editor, document, field);
    const start = Y.decodeRelativePosition(fromBase64(anchor.start));
    const end = Y.decodeRelativePosition(fromBase64(anchor.end));
    const relativeFrom = relativePositionToAbsolutePosition(document, fragment, start, mapping);
    const relativeTo = relativePositionToAbsolutePosition(document, fragment, end, mapping);
    const rangeIsValid = (range: [number | null, number | null]): range is [number, number] =>
      range[0] !== null &&
      range[1] !== null &&
      Number.isSafeInteger(range[0]) &&
      Number.isSafeInteger(range[1]) &&
      range[0] >= 0 &&
      range[1] >= 0 &&
      range[0] <= editor.state.doc.content.size &&
      range[1] <= editor.state.doc.content.size;
    const relativeRange: [number | null, number | null] = [relativeFrom, relativeTo];
    const mappedRange = mapAnchorPositions(editor, anchor);
    const validRange = (range: { from: number; to: number } | null) =>
      range !== null &&
      Number.isSafeInteger(range.from) &&
      Number.isSafeInteger(range.to) &&
      range.from >= 0 &&
      range.to >= 0 &&
      range.from <= editor.state.doc.content.size &&
      range.to <= editor.state.doc.content.size;
    const currentBlockIds = getBlockIds(editor);
    const relativeResolved = rangeIsValid(relativeRange)
      ? { from: relativeRange[0], to: relativeRange[1] }
      : null;
    const relativeRangeIsCurrent =
      relativeResolved !== null &&
      (anchor.start === anchor.end || relativeFrom !== relativeTo) &&
      rangeMatchesStoredBlocks(editor, anchor, relativeResolved, currentBlockIds);
    const offsetRange = resolveBlockOffsets(editor, anchor);
    const mappedResolved = validRange(mappedRange) ? mappedRange : null;
    const mappedRangeIsCurrent =
      mappedResolved !== null &&
      rangeMatchesStoredBlocks(editor, anchor, mappedResolved, currentBlockIds);
    const expectedTextLength =
      typeof anchor.selectedTextLength === "number" &&
      Number.isSafeInteger(anchor.selectedTextLength)
        ? anchor.selectedTextLength
        : anchor.startBlockId === anchor.endBlockId &&
            typeof anchor.startPosition === "number" &&
            typeof anchor.endPosition === "number" &&
            Number.isSafeInteger(anchor.startPosition) &&
            Number.isSafeInteger(anchor.endPosition) &&
            anchor.endPosition >= anchor.startPosition
          ? anchor.endPosition - anchor.startPosition
          : null;
    const textLength = (range: { from: number; to: number } | null) =>
      range
        ? editor.state.doc.textBetween(
            Math.min(range.from, range.to),
            Math.max(range.from, range.to),
            "",
            "",
          ).length
        : null;
    const offsetRepairsAnchorMapping =
      offsetRange !== null &&
      expectedTextLength !== null &&
      textLength(offsetRange) === expectedTextLength &&
      textLength(relativeResolved) !== expectedTextLength &&
      !mappedRangeIsCurrent;
    const selected: { from: number; to: number } | null = offsetRepairsAnchorMapping
      ? offsetRange
      : relativeRangeIsCurrent
        ? relativeResolved
        : (offsetRange ??
          (mappedRangeIsCurrent ? mappedResolved : (relativeResolved ?? mappedResolved)));
    const selectedRange: [number | null, number | null] = selected
      ? [selected.from, selected.to]
      : [null, null];
    if (!rangeIsValid(selectedRange)) return { status: "target-missing" };
    const [from, to] = selectedRange;

    const startBlockId = blockIdAtPosition(editor, from, "after");
    const endBlockId = blockIdAtPosition(editor, to, from === to ? "after" : "before");
    if (!startBlockId || !endBlockId || !blockIds.has(startBlockId) || !blockIds.has(endBlockId)) {
      return { status: "target-missing" };
    }
    if (anchor.start !== anchor.end && from === to) return { status: "target-missing" };
    return { status: "current", from: Math.min(from, to), to: Math.max(from, to) };
  } catch {
    return { status: "invalid-anchor" };
  }
}
