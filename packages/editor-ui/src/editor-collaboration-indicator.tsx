import type { EditorCollaborationStatus } from "@zhishu/editor-react";

export interface EditorCollaborationIndicatorProps {
  status: EditorCollaborationStatus;
  className?: string;
  onRetry?: () => void;
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
      return "已保存";
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
  onRetry,
}: EditorCollaborationIndicatorProps) {
  return (
    <details
      className={
        className ? `zhishu-collaboration-indicator ${className}` : "zhishu-collaboration-indicator"
      }
      role="group"
      aria-label="协同状态"
    >
      <summary
        data-state={status.persistence ?? "unknown"}
        aria-label={`${persistenceLabel(status)}；展开连接和同步详情`}
      >
        {persistenceLabel(status)}
      </summary>
      <div className="zhishu-collaboration-status-details">
        <dl>
          <div data-state={status.connection}>
            <dt>连接</dt>
            <dd>{connectionLabel(status.connection)}</dd>
          </div>
          <div data-state={status.sync}>
            <dt>正文同步</dt>
            <dd>{syncLabel(status.sync)}</dd>
          </div>
          <div data-state={status.persistence ?? "unknown"}>
            <dt>服务端保存</dt>
            <dd>
              {persistenceLabel(status)}
              {status.pendingUpdateCount ? `（${status.pendingUpdateCount} 项）` : ""}
            </dd>
          </div>
          {status.durableSeq !== undefined && (
            <div>
              <dt>服务端序号</dt>
              <dd>{status.durableSeq}</dd>
            </div>
          )}
        </dl>
        {status.errorCode && <p>错误代码：{status.errorCode}</p>}
        {status.connection === "denied" && onRetry && (
          <button type="button" onClick={onRetry}>
            重试连接
          </button>
        )}
      </div>
    </details>
  );
}
