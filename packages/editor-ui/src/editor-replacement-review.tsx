import type { EditorReplacementPreviewData } from "@zhishu/editor-core";
import { useEditorReplacementPreview } from "@zhishu/editor-react";
import { EditorIcon } from "./editor-icon.js";

export interface EditorReplacementReviewProps {
  preview: EditorReplacementPreviewData | null;
  waitForOriginal?: boolean;
  stale?: boolean;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onReplace: () => void;
  onDismiss: () => void;
  onAcceptBlock: (blockId: string) => void;
  onRejectBlock: (blockId: string) => void;
  onInvalidated: () => void;
}
export function EditorReplacementReview({
  preview,
  waitForOriginal,
  stale,
  busy,
  disabled,
  error,
  onReplace,
  onDismiss,
  onAcceptBlock,
  onRejectBlock,
  onInvalidated,
}: EditorReplacementReviewProps) {
  const { ready, count, index, navigate } = useEditorReplacementPreview(preview, onInvalidated, {
    disabled: busy || disabled || stale,
    waitForOriginal,
    onAccept: onAcceptBlock,
    onReject: onRejectBlock,
  });
  return (
    <div className="zhishu-ui-replacement-review" role="region" aria-label="AI 替换建议">
      <div className="zhishu-ui-replacement-review__bar">
        <EditorIcon name={stale ? "alert" : "sparkles"} />
        <span role="status">
          {busy
            ? "正在处理建议…"
            : stale
              ? "原文已变化，请重新生成"
              : count
                ? `${index + 1} / ${count} 处修改`
                : ready
                  ? "内容一致，无需替换"
                  : "正在同步原文…"}
        </span>
        {count > 1 && !stale && (
          <>
            <button
              type="button"
              aria-label="上一处修改"
              onClick={() => navigate(-1)}
              disabled={busy}
            >
              <EditorIcon name="chevron-left" />
            </button>
            <button
              type="button"
              aria-label="下一处修改"
              onClick={() => navigate(1)}
              disabled={busy}
            >
              <EditorIcon name="chevron-right" />
            </button>
          </>
        )}
        <button type="button" onClick={onDismiss} disabled={busy} aria-label="全部拒绝">
          <EditorIcon name="x" />
          全部拒绝
        </button>
        <button
          type="button"
          className="zhishu-ui-replacement-review__accept"
          onClick={onReplace}
          disabled={busy || disabled || stale || !count}
          aria-label="全部替换"
        >
          <EditorIcon name={busy ? "loader" : "check"} />
          {busy ? "处理中…" : "全部替换"}
        </button>
      </div>
      <p className="zhishu-ui-replacement-review__hint" role={error ? "alert" : undefined}>
        {error ?? (stale ? "生成草稿已保留，原文未被替换。" : "逐段确认，或一次处理剩余建议。")}
      </p>
    </div>
  );
}
