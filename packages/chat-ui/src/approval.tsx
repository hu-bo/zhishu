import { ActionCard } from "./action-card.js";
import type { CardTone } from "./types.js";

const APPROVAL_STATUS: Record<string, { tone: CardTone; text: string }> = {
  pending: { tone: "warning", text: "等待你确认" },
  allowed: { tone: "success", text: "已允许这一次" },
  rejected: { tone: "neutral", text: "已拒绝" },
  cancelled: { tone: "neutral", text: "已取消" },
  expired: { tone: "neutral", text: "已过期" },
  unavailable: { tone: "danger", text: "当前无法审批" },
};

const ShieldIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3l8 3v5.2c0 4.7-3.3 8.2-8 9.8-4.7-1.6-8-5.1-8-9.8V6z M8.8 12l2.2 2.2 4.2-4.4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

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
  const view = APPROVAL_STATUS[status] ?? { tone: "neutral" as CardTone, text: status };
  const pending = status === "pending";
  return (
    <ActionCard
      label="工具审批"
      tone={view.tone}
      icon={ShieldIcon}
      title={title}
      subtitle={description}
      badge={{ text: view.text }}
      footer={
        pending && (onAllow || onReject) ? (
          <div className="zhishu-chat-card__actions">
            {onReject && (
              <button
                type="button"
                className="zhishu-chat-card__danger"
                disabled={busy}
                onClick={onReject}
              >
                拒绝
              </button>
            )}
            {onAllow && (
              <button
                type="button"
                className="zhishu-chat-card__primary"
                disabled={busy}
                onClick={onAllow}
              >
                允许这一次
              </button>
            )}
          </div>
        ) : undefined
      }
    />
  );
}
