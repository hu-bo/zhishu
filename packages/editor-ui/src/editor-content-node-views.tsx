import { useState } from "react";
import {
  CALLOUT_THEMES,
  CALLOUT_THEME_LABELS,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
} from "@zhishu/editor-core";
import type { CalloutTheme, DocumentStatus } from "@zhishu/editor-core";
import {
  NodeViewContent,
  NodeViewWrapper,
  useEditorInstance,
  useEditorSelector,
  useEditorStructureAction,
  type ReactNodeViewProps,
  type EditorProviderProps,
} from "@zhishu/editor-react";
import { EditorCodeBlockView } from "./editor-code-block-view.js";
import { EditorStructureFeedback } from "./editor-structure-feedback.js";

const themeLabels = CALLOUT_THEME_LABELS;
const themeIcons: Record<CalloutTheme, string> = {
  info: "ⓘ",
  tip: "✧",
  warning: "⚠",
  success: "✓",
  danger: "!",
};

export function EditorCalloutView({ node, selected }: ReactNodeViewProps) {
  const editable = useEditorSelector((state) => state.isEditable);
  const action = useEditorStructureAction();
  const theme = CALLOUT_THEMES.find((value) => value === node.attrs.theme) ?? "info";
  const targetBlockId = String(node.attrs.blockId);
  return (
    <NodeViewWrapper
      data-callout-theme={theme}
      data-blockid={targetBlockId}
      className="zhishu-ui-callout"
      data-selected={selected ? "true" : undefined}
    >
      <div className="zhishu-ui-callout-header" contentEditable={false}>
        <span className="zhishu-ui-callout-title">
          <span aria-hidden="true">{themeIcons[theme]}</span>
          {themeLabels[theme]}
        </span>
        {editable && (
          <div className="zhishu-ui-callout-actions">
            <select
              aria-label="提示块主题"
              value={theme}
              disabled={!action.allowed || action.busy || action.canRetry}
              onChange={(event) =>
                void action.run({
                  type: "set-callout-theme",
                  targetBlockId,
                  theme: event.target.value as CalloutTheme,
                })
              }
            >
              {CALLOUT_THEMES.map((value) => (
                <option value={value} key={value}>
                  {themeLabels[value]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!action.allowed || action.busy || action.canRetry}
              onClick={() => void action.run({ type: "unwrap-callout", targetBlockId })}
            >
              转换为正文
            </button>
            <button
              type="button"
              aria-label="删除提示块"
              disabled={!action.allowed || action.busy || action.canRetry}
              onClick={() => void action.run({ type: "delete-block", targetBlockId })}
            >
              删除
            </button>
          </div>
        )}
      </div>
      <NodeViewContent className="zhishu-ui-callout-content" data-callout-content="" />
      <div contentEditable={false}>
        <EditorStructureFeedback action={action} />
      </div>
    </NodeViewWrapper>
  );
}

export function EditorDividerView({ node, selected }: ReactNodeViewProps) {
  const { controller } = useEditorInstance();
  const editable = useEditorSelector((state) => state.isEditable);
  const action = useEditorStructureAction();
  const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const targetBlockId = String(node.attrs.blockId);
  async function save() {
    if (await action.run({ type: "set-divider-label", targetBlockId, label: draft.trim() })) {
      setEditing(false);
      controller?.focus();
    }
  }
  function cancel() {
    setEditing(false);
    action.dismissError();
    controller?.focus();
  }
  return (
    <NodeViewWrapper
      className="zhishu-ui-divider"
      data-blockid={targetBlockId}
      data-selected={selected ? "true" : undefined}
      contentEditable={false}
    >
      <hr />
      {editing && editable ? (
        <span className="zhishu-ui-divider-form">
          <input
            autoFocus
            aria-label="分隔线标签"
            maxLength={80}
            value={draft}
            disabled={action.busy || action.canRetry}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Escape" && !action.busy) {
                event.preventDefault();
                cancel();
              }
            }}
          />
          <button
            type="button"
            disabled={!action.allowed || action.busy || action.canRetry}
            onClick={() => void save()}
          >
            保存标签
          </button>
          <button type="button" disabled={action.busy} onClick={cancel}>
            取消
          </button>
        </span>
      ) : editable ? (
        <button
          type="button"
          aria-label="编辑分隔线标签"
          disabled={!action.allowed}
          onClick={() => {
            setDraft(label);
            setEditing(true);
          }}
        >
          {label || "添加标签"}
        </button>
      ) : label ? (
        <span>{label}</span>
      ) : null}
      <hr />
      <EditorStructureFeedback action={action} />
    </NodeViewWrapper>
  );
}

export function EditorStatusTagView({ node, getPos }: ReactNodeViewProps) {
  const { controller, hostServices } = useEditorInstance();
  const editable = useEditorSelector((state) => state.isEditable);
  const status = DOCUMENT_STATUSES.find((value) => value === node.attrs.status) ?? "todo";
  return (
    <NodeViewWrapper
      as="span"
      className="zhishu-ui-status-tag"
      data-status-tag={status}
      contentEditable={false}
    >
      {editable ? (
        <select
          aria-label="文档内状态"
          value={status}
          onChange={(event) => {
            const position = getPos();
            if (
              typeof position !== "number" ||
              !controller?.updateStatusTag(position, status, event.target.value as DocumentStatus)
            )
              hostServices.reportError?.(new Error("状态标签已变化，请重新选择。"));
          }}
        >
          {DOCUMENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      ) : (
        DOCUMENT_STATUS_LABELS[status]
      )}
    </NodeViewWrapper>
  );
}

export const defaultEditorNodeViews = {
  codeBlock: { component: EditorCodeBlockView },
  callout: { component: EditorCalloutView },
  horizontalRule: { component: EditorDividerView },
  statusTag: { component: EditorStatusTagView },
} satisfies NonNullable<EditorProviderProps["nodeViews"]>;
