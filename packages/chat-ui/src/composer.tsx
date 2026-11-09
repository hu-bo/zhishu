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
      <AttachmentList items={props.attachments ?? []} onRemove={props.onRemoveAttachment} />
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 19V5m-6 6 6-6 6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
    </form>
  );
}
export function AttachmentList({
  items,
  onRemove,
}: {
  items: readonly AttachmentView[];
  onRemove?(id: string): void;
}) {
  return (
    <ul className="zhishu-chat-attachments">
      {items.map((item) => (
        <li key={item.id}>
          {item.label}
          {item.status && <small>{item.status}</small>}
          {onRemove && (
            <button
              type="button"
              aria-label={`移除 ${item.label}`}
              onClick={() => onRemove(item.id)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
