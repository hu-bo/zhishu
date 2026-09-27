import Collaboration from "@tiptap/extension-collaboration";
import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
  yUndoPluginKey,
} from "@tiptap/y-tiptap";
import { checkAnchorTarget } from "@zhishu/document-contracts";
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
  const startBlockId = blockIdAtPosition(editor, selection.from, "after");
  const endBlockId = blockIdAtPosition(editor, selection.to, selection.empty ? "after" : "before");
  if (!startBlockId || !endBlockId) throw new TypeError("The selection has no addressable Blocks.");

  const { fragment, mapping } = getBinding(editor, document, field);
  const start = absolutePositionToRelativePosition(selection.from, fragment, mapping);
  const end = absolutePositionToRelativePosition(selection.to, fragment, mapping);
  return {
    ...context,
    anchorVersion: 1,
    encoding: "yjs-relative-position-v1",
    startBlockId,
    endBlockId,
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
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(anchor.start) ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(anchor.end)
  ) {
    return { status: "invalid-anchor" };
  }
  const targetStatus = checkAnchorTarget(anchor, {
    ...current,
    blockIds: getBlockIds(editor),
  });
  if (targetStatus !== "current") return { status: targetStatus };

  try {
    const { fragment, mapping } = getBinding(editor, document, field);
    const start = Y.decodeRelativePosition(fromBase64(anchor.start));
    const end = Y.decodeRelativePosition(fromBase64(anchor.end));
    const from = relativePositionToAbsolutePosition(document, fragment, start, mapping);
    const to = relativePositionToAbsolutePosition(document, fragment, end, mapping);
    if (from === null || to === null) return { status: "target-missing" };
    if (
      blockIdAtPosition(editor, from, "after") !== anchor.startBlockId ||
      blockIdAtPosition(editor, to, "before") !== anchor.endBlockId
    ) {
      return { status: "target-missing" };
    }
    return { status: "current", from: Math.min(from, to), to: Math.max(from, to) };
  } catch {
    return { status: "invalid-anchor" };
  }
}
