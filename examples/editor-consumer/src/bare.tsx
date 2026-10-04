import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EditorProvider, EditorSurface, useEditorInstance } from "@zhishu/editor-react";

function HostActions() {
  const { controller } = useEditorInstance();
  return (
    <button type="button" disabled={!controller} onClick={() => controller?.toggleBold()}>
      宿主加粗动作
    </button>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Example root is missing.");
createRoot(root).render(
  <StrictMode>
    <main>
      <h1>无默认 UI 消费</h1>
      <p>此入口只消费 editor-react 和 core，不导入 editor-ui、其样式或应用服务。</p>
      <EditorProvider
        options={{
          documentId: "doc_bare_consumer",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "block_bare_consumer" },
                content: [{ type: "text", text: "宿主可以用公开命令组合自己的界面。" }],
              },
            ],
          },
        }}
      >
        <HostActions />
        <EditorSurface ariaLabel="无默认 UI 的独立正文" />
      </EditorProvider>
    </main>
  </StrictMode>,
);
