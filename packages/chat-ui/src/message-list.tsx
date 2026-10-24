import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { MessagePart, MessageView } from "./types.js";
export const MessageParts = memo(function MessageParts({
  parts,
}: {
  parts: readonly MessagePart[];
}) {
  return (
    <>
      {parts.map((part) => (
        <div key={part.id} className={`zhishu-chat-part zhishu-chat-part-${part.kind}`}>
          {part.kind === "text" ? (
            <p>{part.text}</p>
          ) : part.kind === "code" ? (
            <pre aria-label={part.language ?? "代码"}>
              <code>{part.text}</code>
            </pre>
          ) : part.kind === "image" ? (
            /^(https?:|blob:)/i.test(part.src) ? (
              <img src={part.src} alt={part.alt} loading="lazy" />
            ) : (
              <span>{part.alt}</span>
            )
          ) : part.kind === "tool" ? (
            <details>
              <summary>{part.title}</summary>
              {part.status}
            </details>
          ) : part.kind === "error" ? (
            <p role="alert">{part.text}</p>
          ) : (
            (part.content ?? <p>{part.fallbackText}</p>)
          )}
        </div>
      ))}
    </>
  );
});
export function MessageList({
  messages,
  emptyState,
  messageActions,
  onLoadEarlier,
  loadingEarlier = false,
  afterMessages,
}: {
  messages: readonly MessageView[];
  emptyState?: ReactNode;
  messageActions?(message: MessageView): ReactNode;
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
    if (previous.current.first && previous.current.first !== first)
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
            : messages.map((message) => (
                <article
                  key={message.id}
                  className={`zhishu-chat-message zhishu-chat-${message.role}`}
                  aria-label={message.role === "user" ? "你" : "助手"}
                >
                  <span className="zhishu-chat-role">
                    {message.role === "user" ? "你" : message.role === "tool" ? "工具" : "知书助手"}
                  </span>
                  <MessageParts parts={message.parts} />
                  {message.status && <small>{message.status}</small>}
                  {messageActions?.(message)}
                </article>
              ))}
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
