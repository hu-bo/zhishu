import { useEffect, useState } from "react";
import { useEditorEvents, useEditorInstance } from "@zhishu/editor-react";

export interface EditorOutlineProps {
  label?: string;
  emptyLabel?: string;
  untitledLabel?: string;
  className?: string;
  id?: string;
}

export function EditorOutline({
  label = "文档大纲",
  emptyLabel = "文档中暂无标题",
  untitledLabel = "无标题",
  className,
  id,
}: EditorOutlineProps) {
  const { controller } = useEditorInstance();
  const [headings, setHeadings] = useState(() => controller?.getOutline() ?? []);

  useEffect(() => {
    setHeadings(controller && !controller.isDestroyed ? controller.getOutline() : []);
  }, [controller]);

  useEditorEvents((event) => {
    if (event.docChanged && controller && !controller.isDestroyed) {
      setHeadings(controller.getOutline());
    }
  });

  return (
    <nav
      id={id}
      className={className ? `zhishu-ui-outline ${className}` : "zhishu-ui-outline"}
      aria-label={label}
    >
      <h2>{label}</h2>
      {headings.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <ol>
          {headings.map((heading) => (
            <li key={heading.blockId} data-level={heading.level}>
              <button type="button" onClick={() => controller?.focusBlock(heading.blockId)}>
                {heading.text || untitledLabel}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
