import { Extension, Node } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { useState } from "react";
import { createSafeReactNodeViewRenderer, NodeViewWrapper } from "@zhishu/editor-react";
import type { ReactNodeViewProps } from "@zhishu/editor-react";

function ReactImageNodeView({ node, selected, updateAttributes }: ReactNodeViewProps) {
  const [simulateFailure, setSimulateFailure] = useState(false);
  if (simulateFailure) throw new Error("Example NodeView render failure.");
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  return (
    <NodeViewWrapper
      as="figure"
      className={`react-image-node-view${selected ? " is-selected" : ""}`}
      data-blockid={String(node.attrs.blockId ?? "")}
      data-selected={String(selected)}
      draggable
    >
      <span className="react-image-node-view-handle" data-drag-handle="" aria-hidden="true">
        ⠿
      </span>
      <div className="react-image-node-view-copy">
        <strong>React 图片 NodeView</strong>
        <label>
          替代文本
          <input
            aria-label="NodeView 图片替代文本"
            value={alt}
            onChange={(event) => updateAttributes({ alt: event.currentTarget.value })}
          />
        </label>
        <button type="button" onClick={() => setSimulateFailure(true)}>
          模拟本块错误
        </button>
        <span>属性由 NodeView 受控更新；选择后可拖动此块。</span>
      </div>
    </NodeViewWrapper>
  );
}

const renderReactImageNodeView = createSafeReactNodeViewRenderer(ReactImageNodeView, {
  errorLabel: "图片块暂时无法显示。正文仍保留，可以重试此块。",
  retryLabel: "重试此块",
  errorClassName: "react-image-node-view-error",
});

export const reactImageNodeViewExtension = Extension.create({
  name: "consumerReactImageNodeView",
  addProseMirrorPlugins() {
    const editor = this.editor;
    const imageExtension = editor.extensionManager.extensions.find(
      (extension): extension is Node => extension instanceof Node && extension.name === "image",
    );
    if (!imageExtension) return [];

    return [
      new Plugin({
        props: {
          nodeViews: {
            image: (node, view, getPos, decorations, innerDecorations) =>
              renderReactImageNodeView({
                node,
                view,
                getPos,
                decorations,
                innerDecorations,
                editor,
                extension: imageExtension,
                HTMLAttributes: node.attrs,
              }),
          },
        },
      }),
    ];
  },
});
