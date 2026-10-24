import { Extension, type Editor } from "@tiptap/core";
import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { validateDocumentContent, type DocumentContent } from "@zhishu/document-contracts";

export interface EditorReplacementPreviewData {
  id: string;
  original: DocumentContent;
  proposed: DocumentContent;
}
export interface EditorReplacementPreviewActions {
  disabled?: boolean;
  onAccept?: (blockId: string) => void;
  onReject?: (blockId: string) => void;
}
interface PreviewState {
  decorations: DecorationSet;
  count: number;
}
const empty: PreviewState = { decorations: DecorationSet.empty, count: 0 };
const key = new PluginKey<PreviewState>("zhishuReplacementPreview");

/** Decorations are local view state: they never become document nodes, history or Yjs updates. */
export const replacementPreviewExtension = Extension.create({
  name: "zhishuReplacementPreview",
  addProseMirrorPlugins() {
    return [
      new Plugin<PreviewState>({
        key,
        state: {
          init: () => empty,
          apply: (transaction, current) =>
            (transaction.getMeta(key) as PreviewState | undefined) ??
            (transaction.docChanged ? empty : current),
        },
        props: { decorations: (state) => key.getState(state)?.decorations },
      }),
    ];
  },
});

export function setReplacementPreview(
  editor: Editor,
  preview: EditorReplacementPreviewData | null,
  actions: EditorReplacementPreviewActions = {},
): number | null {
  if (editor.isDestroyed || !key.getState(editor.state)) return null;
  let next = empty;
  if (preview) {
    if (
      !validateDocumentContent(preview.original).success ||
      !validateDocumentContent(preview.proposed).success
    )
      return null;
    let proposed: ProseMirrorNode;
    try {
      if (!editor.schema.nodeFromJSON(preview.original).eq(editor.state.doc)) return null;
      proposed = editor.schema.nodeFromJSON(preview.proposed);
      proposed.check();
    } catch {
      return null;
    }
    const replacements = new Map<string, ProseMirrorNode>();
    proposed.forEach((node) => replacements.set(String(node.attrs.blockId), node));
    const decorations: Decoration[] = [];
    let count = 0;
    const widget = (
      position: number,
      node: ProseMirrorNode | null,
      blockId: string,
      index: number,
    ) =>
      Decoration.widget(
        position,
        (view) => {
          const document = view.dom.ownerDocument;
          const element = document.createElement("div");
          element.className = "zhishu-replacement-new";
          element.dataset.replacementHunk = String(index);
          element.dataset.replacementBlockId = blockId;
          element.contentEditable = "false";
          element.setAttribute("role", "region");
          element.setAttribute("aria-label", `修改建议 ${index + 1}`);
          const label = document.createElement("span");
          label.className = "zhishu-replacement-label";
          label.textContent = node ? "建议内容" : "删除建议";
          element.append(
            label,
            node
              ? DOMSerializer.fromSchema(editor.schema).serializeNode(node, { document })
              : document.createTextNode("建议删除此段原文"),
          );
          if (actions.onAccept && actions.onReject) {
            const controls = document.createElement("div");
            controls.className = "zhishu-replacement-actions";
            for (const [name, symbol, callback] of [
              ["替换此段", "✓", actions.onAccept],
              ["拒绝此段", "×", actions.onReject],
            ] as const) {
              const button = document.createElement("button");
              button.type = "button";
              button.setAttribute("aria-label", name);
              button.title = name;
              button.textContent = symbol;
              button.disabled = !!actions.disabled;
              button.addEventListener("mousedown", (event) => event.preventDefault());
              button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                callback(blockId);
              });
              controls.append(button);
            }
            element.append(controls);
          }
          return element;
        },
        {
          key: `${preview.id}:${blockId}:${index}:${!!actions.disabled}`,
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      );
    editor.state.doc.forEach((old, position) => {
      const id = String(old.attrs.blockId),
        replacement = replacements.get(id);
      replacements.delete(id);
      if (replacement?.eq(old)) return;
      const index = count++;
      decorations.push(
        Decoration.node(position, position + old.nodeSize, {
          class: "zhishu-replacement-old",
          ...(replacement ? {} : { "data-replacement-hunk": String(index) }),
        }),
      );
      decorations.push(
        widget(replacement ? position : position + old.nodeSize, replacement ?? null, id, index),
      );
    });
    for (const node of replacements.values())
      decorations.push(
        widget(editor.state.doc.content.size, node, String(node.attrs.blockId), count++),
      );
    next = { decorations: DecorationSet.create(editor.state.doc, decorations), count };
  }
  editor.view.dispatch(editor.state.tr.setMeta(key, next).setMeta("addToHistory", false));
  return next.count;
}

export function scrollToReplacementPreview(editor: Editor, index: number): void {
  editor.view.dom
    .querySelector<HTMLElement>(`[data-replacement-hunk="${index}"]`)
    ?.scrollIntoView({ block: "center", behavior: "instant" });
}
