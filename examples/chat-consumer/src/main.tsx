import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat, Composer, ApprovalCard, type MessageView } from "@zhishu/chat-ui";
import "@zhishu/chat-ui/styles.css";
import "./style.css";
function Consumer({ kind }: { kind: "writing" | "rag" }) {
  const [draft, setDraft] = useState(""),
    [messages, setMessages] = useState<MessageView[]>([
      {
        id: "initial",
        role: "assistant",
        parts: [
          {
            id: "text",
            kind: "text",
            text:
              kind === "writing"
                ? "写作视图示例：没有业务 API 或执行器。"
                : "RAG 视图示例：同一基础组件，独立受控状态。",
          },
        ],
      },
    ]);
  return (
    <Chat
      header={<h2>{kind === "writing" ? "写作" : "知识问答"} · 受控展示示例</h2>}
      messages={messages}
      status={
        kind === "writing" ? (
          <ApprovalCard title="示例审批，不执行工具" status="expired" />
        ) : undefined
      }
      composer={
        <Composer
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => {
            setMessages((current) => [
              ...current,
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ id: "text", kind: "text", text: draft }],
              },
            ]);
            setDraft("");
          }}
        />
      }
    />
  );
}
createRoot(document.getElementById("root")!).render(
  <main>
    <Consumer kind="writing" />
    <Consumer kind="rag" />
  </main>,
);
