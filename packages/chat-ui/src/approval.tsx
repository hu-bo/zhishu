import type { ReactNode } from "react";
export function ApprovalCard({
  title,
  status,
  onAllow,
  onReject,
  busy,
  description,
}: {
  title: string;
  status: string;
  onAllow?(): void;
  onReject?(): void;
  busy?: boolean;
  description?: string;
}) {
  return (
    <section className="zhishu-chat-approval" aria-label="工具审批">
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      <p>
        {{
          pending: "等待你确认",
          allowed: "已允许这一次",
          rejected: "已拒绝",
          cancelled: "已取消",
          expired: "已过期",
          unavailable: "当前无法审批",
        }[status] ?? status}
      </p>
      {status === "pending" && (
        <div>
          {onAllow && (
            <button disabled={busy} onClick={onAllow}>
              允许这一次
            </button>
          )}
          {onReject && (
            <button disabled={busy} onClick={onReject}>
              拒绝
            </button>
          )}
        </div>
      )}
    </section>
  );
}
export function ArtifactCard({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="zhishu-chat-artifact">
      <strong>{title}</strong>
      {children}
      {actions}
    </section>
  );
}
