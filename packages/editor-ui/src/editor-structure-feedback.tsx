import type { useEditorStructureAction } from "@zhishu/editor-react";

export function EditorStructureFeedback({
  action,
}: {
  action: ReturnType<typeof useEditorStructureAction>;
}) {
  if (!action.error) return null;
  return (
    <span role="alert" className="zhishu-ui-node-error">
      {action.error}
      {action.canRetry && (
        <button type="button" disabled={action.busy} onClick={() => void action.retry()}>
          重试操作
        </button>
      )}
      <button type="button" disabled={action.busy} onClick={action.dismissError}>
        关闭提示
      </button>
    </span>
  );
}
