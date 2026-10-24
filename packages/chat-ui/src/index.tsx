import type { ComponentProps, ReactNode } from "react";
import { MessageList } from "./message-list.js";
export * from "./types.js";
export * from "./composer.js";
export * from "./message-list.js";
export * from "./approval.js";
export function ChatStatus({ children, error = false }: { children?: ReactNode; error?: boolean }) {
  return (
    <div className="zhishu-chat-status" role={error ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function Chat({
  composer,
  header,
  status,
  className = "",
  ...list
}: ComponentProps<typeof MessageList> & {
  composer?: ReactNode;
  header?: ReactNode;
  status?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`zhishu-chat ${className}`}>
      {header}
      <MessageList {...list} />
      {status}
      {composer}
    </section>
  );
}
