import { useEffect, useState } from "react";
import { useEditorInstance, useEditorSelector } from "@zhishu/editor-react";

export interface EditorCodeLanguageSelectorMessages {
  label: string;
  plainText: string;
  updated: string;
  changed: string;
}

const defaultMessages: EditorCodeLanguageSelectorMessages = {
  label: "代码语言",
  plainText: "纯文本",
  updated: "代码语言已更新",
  changed: "代码块已变化，请重新选择后再编辑",
};

const codeLanguages = [
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["jsx", "JSX"],
  ["tsx", "TSX"],
  ["json", "JSON"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["python", "Python"],
  ["java", "Java"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["sql", "SQL"],
  ["bash", "Bash"],
  ["yaml", "YAML"],
  ["markdown", "Markdown"],
] as const;

export interface EditorCodeLanguageSelectorProps {
  messages?: Partial<EditorCodeLanguageSelectorMessages>;
  className?: string;
}

export function EditorCodeLanguageSelector({
  messages,
  className,
}: EditorCodeLanguageSelectorProps) {
  const { controller } = useEditorInstance();
  const revision = useEditorSelector((snapshot) => snapshot.revision);
  const isEditable = useEditorSelector((snapshot) => snapshot.isEditable);
  const [status, setStatus] = useState("");
  const labels = { ...defaultMessages, ...messages };
  void revision;

  const selection = controller?.editor.state.selection;
  const selectionWithNode = selection as
    | {
        from: number;
        node?: { type: { name: string }; attrs: Record<string, unknown> };
        $from: {
          before: () => number;
          parent: { type: { name: string }; attrs: Record<string, unknown> };
        };
      }
    | undefined;
  const selectedNode =
    selectionWithNode?.node?.type.name === "codeBlock"
      ? selectionWithNode.node
      : selectionWithNode?.$from.parent.type.name === "codeBlock"
        ? selectionWithNode.$from.parent
        : undefined;
  const blockId = typeof selectedNode?.attrs.blockId === "string" ? selectedNode.attrs.blockId : "";
  const language =
    typeof selectedNode?.attrs.language === "string" ? selectedNode.attrs.language : "";
  const position =
    selectionWithNode?.node?.type.name === "codeBlock"
      ? selectionWithNode.from
      : selectedNode
        ? selectionWithNode?.$from.before()
        : undefined;

  useEffect(() => setStatus(""), [blockId]);

  if (!blockId || position === undefined || !controller || controller.isDestroyed) return null;

  function updateLanguage(nextLanguage: string) {
    setStatus("");
    if (!controller || controller.isDestroyed || !controller.canExecute("write").allowed) return;
    if (nextLanguage && !/^[A-Za-z0-9_+-]{1,32}$/.test(nextLanguage)) return;

    const current = controller.findBlock(blockId);
    const node = current ? controller.editor.state.doc.nodeAt(current.position) : undefined;
    if (!current || current.type !== "codeBlock" || node?.type.name !== "codeBlock") {
      setStatus(labels.changed);
      return;
    }

    const attrs = { ...node.attrs } as Record<string, unknown>;
    if (nextLanguage) attrs.language = nextLanguage;
    else delete attrs.language;
    const transaction = controller.editor.state.tr.setNodeMarkup(
      current.position,
      undefined,
      attrs,
    );
    transaction.setMeta("zhishu-origin", "host-command");
    controller.editor.view.dispatch(transaction);
    setStatus(labels.updated);
  }

  return (
    <div
      className={
        className
          ? `zhishu-ui-code-language-selector ${className}`
          : "zhishu-ui-code-language-selector"
      }
    >
      <label>
        <span>{labels.label}</span>
        <select
          aria-label={labels.label}
          value={language}
          disabled={!isEditable}
          onChange={(event) => updateLanguage(event.currentTarget.value)}
        >
          <option value="">{labels.plainText}</option>
          {!codeLanguages.some(([value]) => value === language) && language && (
            <option value={language}>{language}</option>
          )}
          {codeLanguages.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <span role="status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
