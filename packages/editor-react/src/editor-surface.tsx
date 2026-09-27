import { useEffect, type HTMLAttributes } from "react";
import { EditorContent } from "@tiptap/react";
import { useEditorInstance } from "./context.js";

export interface EditorSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  ariaLabel: string;
  ariaDescribedBy?: string;
  loadingLabel?: string;
  errorLabel?: string;
  retryLabel?: string;
}

export function EditorSurface({
  ariaLabel,
  ariaDescribedBy,
  loadingLabel = "正在准备编辑器",
  errorLabel = "编辑器无法打开",
  retryLabel = "重试",
  className,
  ...props
}: EditorSurfaceProps) {
  const { status, controller, retry } = useEditorInstance();

  useEffect(() => {
    if (status === "ready" && controller) controller.setAriaLabel(ariaLabel, ariaDescribedBy);
  }, [ariaLabel, ariaDescribedBy, controller, status]);

  if (status === "failed") {
    return (
      <div {...props} className={className} role="alert">
        <span>{errorLabel}</span>
        <button type="button" onClick={retry}>
          {retryLabel}
        </button>
      </div>
    );
  }

  if (status !== "ready" || !controller) {
    return (
      <div {...props} className={className} aria-busy="true" aria-label={ariaLabel}>
        {loadingLabel}
      </div>
    );
  }

  return (
    <div {...props} className={className} data-zhishu-editor-surface="">
      <EditorContent editor={controller.editor} />
    </div>
  );
}
