import { useRef, type ReactNode, type Ref } from "react";
import type { AttachmentView } from "./types.js";
export interface ComposerProps {
  value: string;
  onValueChange(value: string): void;
  onSubmit(): void | Promise<unknown>;
  onStop?(): void | Promise<unknown>;
  busy?: boolean;
  submitting?: boolean;
  stopping?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  maxLength?: number;
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
  headerContent?: ReactNode;
  inputRef?: Ref<HTMLTextAreaElement>;
  attachments?: readonly AttachmentView[];
  onRemoveAttachment?(id: string): void;
  onRetryAttachment?(id: string): void;
  messages?: Partial<{ send: string; stop: string; input: string }>;
}
export function Composer(props: ComposerProps) {
  const composing = useRef(false);
  const labels = { send: "发送", stop: "停止生成", input: "消息", ...props.messages };
  const canSubmit =
    !props.disabled && !props.readOnly && !props.submitting && !props.busy && !!props.value.trim();
  return (
    <form
      className="zhishu-chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !composing.current) void props.onSubmit();
      }}
    >
      {props.headerContent}
      <AttachmentList
        items={props.attachments ?? []}
        onRemove={props.onRemoveAttachment}
        onRetry={props.onRetryAttachment}
      />
      <textarea
        ref={props.inputRef}
        aria-label={labels.input}
        value={props.value}
        placeholder={props.placeholder ?? "输入消息，Shift+Enter 换行"}
        disabled={props.disabled}
        readOnly={props.readOnly}
        rows={2}
        maxLength={props.maxLength}
        onChange={(e) => props.onValueChange(e.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(e) => {
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            !composing.current &&
            e.keyCode !== 229
          ) {
            e.preventDefault();
            if (canSubmit) void props.onSubmit();
          }
        }}
      />
      <div className="zhishu-chat-toolbar">
        {props.toolbarStart}
        <span className="zhishu-chat-spacer" />
        {props.toolbarEnd}
        {props.busy && props.onStop && (
          <button
            type="button"
            className="zhishu-chat-stop"
            aria-label={props.stopping ? "正在停止" : labels.stop}
            title={labels.stop}
            disabled={props.stopping}
            onClick={() => void props.onStop?.()}
          >
            <span aria-hidden="true" />
          </button>
        )}
        {!(props.busy && props.onStop) && (
          <button
            type="submit"
            className="zhishu-chat-send"
            aria-label={props.submitting ? "提交中" : labels.send}
            title={labels.send}
            disabled={!canSubmit}
          >
            {props.submitting ? (
              <span className="zhishu-chat-spinner" aria-hidden="true" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 19V5m-6 6 6-6 6 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        )}
      </div>
    </form>
  );
}

/** File-type badge text for non-image attachments. */
function fileExt(label: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(label);
  return match ? match[1].toUpperCase() : "FILE";
}

export function AttachmentList({
  items,
  onRemove,
  onRetry,
}: {
  items: readonly AttachmentView[];
  onRemove?(id: string): void;
  onRetry?(id: string): void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="zhishu-chat-attachments">
      {items.map((item) => {
        const status = item.status ?? "ready";
        const image = item.kind === "image";
        const progress = Math.min(100, Math.max(0, item.progress ?? 0));
        return (
          <li
            key={item.id}
            className={`zhishu-chat-attachment zhishu-chat-attachment--${status}${
              image ? " zhishu-chat-attachment--image" : ""
            }`}
          >
            {image ? (
              <>
                {item.thumbnailSrc && <img src={item.thumbnailSrc} alt="" />}
                {status === "uploading" && (
                  <span className="zhishu-chat-attachment__veil">
                    <span className="zhishu-chat-spinner" aria-hidden="true" />
                  </span>
                )}
                {status === "ready" && (
                  <span className="zhishu-chat-attachment__corner" aria-hidden="true" />
                )}
              </>
            ) : (
              <>
                <span className="zhishu-chat-attachment__kind" aria-hidden="true">
                  {fileExt(item.label)}
                </span>
                <span className="zhishu-chat-attachment__label" title={item.label}>
                  {item.label}
                </span>
                {status === "uploading" && item.progress !== undefined && (
                  <small className="zhishu-chat-attachment__pct">{progress}%</small>
                )}
                {status === "ready" && item.meta && (
                  <small className="zhishu-chat-attachment__meta">{item.meta}</small>
                )}
              </>
            )}
            {status === "uploading" && !image && (
              <span
                className="zhishu-chat-attachment__bar"
                role="progressbar"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`上传进度 ${item.label}`}
              >
                <i style={{ width: `${progress}%` }} />
              </span>
            )}
            {status === "failed" && (
              <small className="zhishu-chat-attachment__error" title={item.errorText}>
                {item.errorText ?? "上传失败"}
              </small>
            )}
            {status === "failed" && onRetry && (
              <button type="button" onClick={() => onRetry(item.id)}>
                重试
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className="zhishu-chat-attachment__remove"
                aria-label={`${status === "uploading" ? "取消上传" : "移除"} ${item.label}`}
                onClick={() => onRemove(item.id)}
              >
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
