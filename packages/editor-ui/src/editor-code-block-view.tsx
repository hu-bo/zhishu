import { useState } from "react";
import type { ReactNodeViewProps } from "@zhishu/editor-react";
import { NodeViewContent, NodeViewWrapper } from "@zhishu/editor-react";

export interface EditorCodeBlockViewMessages {
  label: string;
  copy: string;
  copied: string;
  copyFailed: string;
  plainText: string;
  readOnly: string;
}

const defaultMessages: EditorCodeBlockViewMessages = {
  label: "代码块",
  copy: "复制代码",
  copied: "代码已复制",
  copyFailed: "复制失败，请选择代码后手动复制",
  plainText: "纯文本",
  readOnly: "只读代码块",
};

export function EditorCodeBlockView({ node, editor, selected }: ReactNodeViewProps) {
  const [status, setStatus] = useState("");
  const language = typeof node.attrs.language === "string" ? node.attrs.language : "";

  async function copyCode() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(node.textContent);
      setStatus(defaultMessages.copied);
    } catch {
      setStatus(defaultMessages.copyFailed);
    }
  }

  return (
    <NodeViewWrapper
      as="section"
      className="zhishu-ui-code-block"
      data-selected={selected ? "true" : undefined}
      data-language={language || undefined}
      role="group"
      aria-label={`${defaultMessages.label}${language ? ` · ${language}` : ""}`}
    >
      <div className="zhishu-ui-code-block-header" contentEditable={false}>
        <span className="zhishu-ui-code-block-language">
          {language || defaultMessages.plainText}
        </span>
        <button
          type="button"
          className="zhishu-ui-code-block-copy"
          aria-label={defaultMessages.copy}
          title={defaultMessages.copy}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void copyCode()}
        >
          <span aria-hidden="true">⧉</span>
          <span>{defaultMessages.copy}</span>
        </button>
      </div>
      <pre className="zhishu-ui-code-block-pre">
        <NodeViewContent<"code"> as="code" className="zhishu-ui-code-block-content" />
      </pre>
      <span className="zhishu-ui-visually-hidden" role="status" aria-live="polite">
        {status || (!editor.isEditable ? defaultMessages.readOnly : "")}
      </span>
    </NodeViewWrapper>
  );
}
