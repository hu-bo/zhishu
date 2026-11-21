import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MessagePart, MessageView, ToolStepStatus } from "./types.js";

/** Live run stages surfaced as compact chips while a preview streams. */
const STAGE_LABELS = {
  scope: "确认资料范围",
  searching: "检索资料",
  reading: "阅读来源",
  generating: "生成中",
  validating: "校验输出",
} as const satisfies Record<string, string>;
export type StageKey = keyof typeof STAGE_LABELS;

function stageLabel(stage: string): string {
  return stage in STAGE_LABELS ? STAGE_LABELS[stage as StageKey] : "生成中";
}

const ROLE_LABEL = { user: "你", tool: "工具", assistant: "知书助手" } as const satisfies Record<
  MessageView["role"],
  string
>;

/** Tool step rows share one status table: icon and label come from the same fact. */
const TOOL_STEPS = {
  running: { label: "执行中", icon: null },
  completed: { label: "已完成", icon: "✓" },
  failed: { label: "失败", icon: "✕" },
} as const satisfies Record<ToolStepStatus, { label: string; icon: string | null }>;

function ThinkingPart({ part }: { part: Extract<MessagePart, { kind: "thinking" }> }) {
  // Open while streaming; an explicit user toggle wins over the automatic state.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? !!part.streaming;
  return (
    <details className="zhishu-chat-thinking" open={open}>
      <summary onClick={() => setManual(!open)}>
        <span aria-hidden="true">💭</span>
        {part.streaming ? "深度思考中…" : "已完成思考"}
      </summary>
      <p>{part.text}</p>
    </details>
  );
}

function renderPart(part: MessagePart): ReactNode {
  switch (part.kind) {
    case "text":
      return <p>{part.text}</p>;
    case "code":
      return (
        <pre aria-label={part.language ?? "代码"}>
          <code>{part.text}</code>
        </pre>
      );
    case "image":
      return /^(https?:|blob:)/i.test(part.src) ? (
        <img src={part.src} alt={part.alt} loading="lazy" />
      ) : (
        <span>{part.alt}</span>
      );
    case "thinking":
      return <ThinkingPart part={part} />;
    case "tool": {
      const step = TOOL_STEPS[part.status];
      return (
        <div className={`zhishu-chat-toolstep zhishu-chat-toolstep--${part.status}`}>
          {step.icon === null ? (
            <span className="zhishu-chat-spinner" aria-hidden="true" />
          ) : (
            <span aria-hidden="true">{step.icon}</span>
          )}
          <span className="zhishu-chat-toolstep__label">{part.title}</span>
          <small>{step.label}</small>
        </div>
      );
    }
    case "error":
      return <p role="alert">{part.text}</p>;
    case "plugin":
      return part.content ?? <p>{part.fallbackText}</p>;
  }
}

export const MessageParts = memo(function MessageParts({
  parts,
}: {
  parts: readonly MessagePart[];
}) {
  return (
    <>
      {parts.map((part) => (
        <div key={part.id} className={`zhishu-chat-part zhishu-chat-part-${part.kind}`}>
          {renderPart(part)}
        </div>
      ))}
    </>
  );
});
export function MessageList({
  messages,
  emptyState,
  messageActions,
  renderText,
  onLoadEarlier,
  loadingEarlier = false,
  afterMessages,
}: {
  messages: readonly MessageView[];
  emptyState?: ReactNode;
  messageActions?(message: MessageView): ReactNode;
  renderText?(text: string, message: MessageView): ReactNode;
  onLoadEarlier?(): void;
  loadingEarlier?: boolean;
  afterMessages?: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null),
    following = useRef(true);
  const previous = useRef({ height: 0, first: "" });
  const [unread, setUnread] = useState(false);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const first = messages[0]?.id ?? "";
    if (
      !first ||
      (previous.current.first && !messages.some((message) => message.id === previous.current.first))
    ) {
      following.current = true;
      setUnread(false);
      element.scrollTop = element.scrollHeight;
    } else if (previous.current.first && previous.current.first !== first)
      element.scrollTop += element.scrollHeight - previous.current.height;
    else if (following.current) element.scrollTop = element.scrollHeight;
    else setUnread(true);
    previous.current = { height: element.scrollHeight, first };
  }, [messages]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (following.current) element.scrollTop = element.scrollHeight;
    });
    const content = element.firstElementChild;
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="zhishu-chat-history">
      <div
        className="zhishu-chat-messages"
        ref={list}
        role="log"
        aria-label="对话消息"
        aria-live="off"
        tabIndex={0}
        onScroll={() => {
          const el = list.current!;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
          if (following.current) setUnread(false);
        }}
      >
        <div>
          {onLoadEarlier && (
            <button type="button" disabled={loadingEarlier} onClick={onLoadEarlier}>
              加载更早消息
            </button>
          )}
          {messages.length === 0
            ? emptyState
            : messages.map((message, index) => {
                // Consecutive messages from the same role keep one avatar/label row.
                const showRole = index === 0 || messages[index - 1].role !== message.role;
                const streaming = message.role === "assistant" && !!message.stage;
                // Any live process fact (answer text, thinking or tool steps) replaces the skeleton.
                const hasContent = message.parts.some((part) => {
                  switch (part.kind) {
                    case "text":
                    case "thinking":
                      return part.text.trim().length > 0;
                    case "tool":
                      return true;
                    default:
                      return false;
                  }
                });
                return (
                  <article
                    key={message.id}
                    className={`zhishu-chat-message zhishu-chat-${message.role}`}
                    aria-label={message.role === "user" ? "你" : "助手"}
                  >
                    {showRole && (
                      <span className="zhishu-chat-role">
                        {message.role === "assistant" && <span aria-hidden="true">✦</span>}
                        {ROLE_LABEL[message.role]}
                      </span>
                    )}
                    {streaming && (
                      <span className="zhishu-chat-stage">
                        <span className="zhishu-chat-spinner" aria-hidden="true" />
                        {stageLabel(message.stage!)}
                      </span>
                    )}
                    {streaming && !hasContent && (
                      <div className="zhishu-chat-skeleton" aria-hidden="true">
                        <i />
                        <i />
                      </div>
                    )}
                    {message.parts.map((part) =>
                      renderText && part.kind === "text" ? (
                        <div key={part.id}>{renderText(part.text, message)}</div>
                      ) : (
                        <MessageParts key={part.id} parts={[part]} />
                      ),
                    )}
                    {message.status && <small>{message.status}</small>}
                    <div className="zhishu-chat-actions">{messageActions?.(message)}</div>
                  </article>
                );
              })}
          {afterMessages}
        </div>
      </div>
      {unread && (
        <button
          className="zhishu-chat-latest"
          type="button"
          onClick={() => {
            following.current = true;
            list.current?.scrollTo({ top: list.current.scrollHeight });
            setUnread(false);
          }}
        >
          回到最新消息
        </button>
      )}
    </div>
  );
}
