import type { EditorCollaborationStatus } from "@zhishu/editor-react";

export interface EditorCollaborationIndicatorProps {
  status: EditorCollaborationStatus;
  className?: string;
}

function connectionLabel(connection: EditorCollaborationStatus["connection"]): string {
  const labels: Record<EditorCollaborationStatus["connection"], string> = {
    idle: "未连接",
    connecting: "正在连接",
    connected: "已连接",
    reconnecting: "正在重连",
    denied: "访问被拒绝",
    closed: "连接已关闭",
  };
  return labels[connection];
}

function syncLabel(sync: EditorCollaborationStatus["sync"]): string {
  const labels: Record<EditorCollaborationStatus["sync"], string> = {
    loading: "正在加载",
    "catching-up": "正在同步",
    current: "内容已同步",
    incompatible: "内容版本不兼容",
  };
  return labels[sync];
}

function persistenceLabel(status: EditorCollaborationStatus): string {
  switch (status.persistence) {
    case "pending":
      return `正在保存${status.pendingUpdateCount ? `（${status.pendingUpdateCount} 项）` : ""}`;
    case "persisted":
      return `已保存${status.durableSeq === undefined ? "" : ` · 序号 ${status.durableSeq}`}`;
    case "failed":
      return "保存失败";
    case "unknown":
      return "保存状态待确认";
    case "clean":
      return "没有待保存修改";
    default:
      return "等待持久化状态";
  }
}

export function EditorCollaborationIndicator({
  status,
  className,
}: EditorCollaborationIndicatorProps) {
  return (
    <div
      className={
        className ? `zhishu-collaboration-indicator ${className}` : "zhishu-collaboration-indicator"
      }
      role="group"
      aria-label="协同状态"
    >
      <span data-state={status.connection}>
        <span className="zhishu-sr-only">连接：</span>
        {connectionLabel(status.connection)}
      </span>
      <span data-state={status.sync}>
        <span className="zhishu-sr-only">同步：</span>
        {syncLabel(status.sync)}
      </span>
      <span data-state={status.persistence ?? "unknown"}>
        <span className="zhishu-sr-only">持久化：</span>
        {persistenceLabel(status)}
      </span>
      {status.errorCode && <span className="zhishu-sr-only">错误代码：{status.errorCode}</span>}
    </div>
  );
}
