export interface EditorKeyboardHelpMessages {
  label: string;
  underline: string;
  highlight: string;
  insertLink: string;
  insertMenu: string;
}

const defaultMessages: EditorKeyboardHelpMessages = {
  label: "快捷键",
  underline: "下划线",
  highlight: "黄色高亮",
  insertLink: "插入链接",
  insertMenu: "打开插入菜单",
};

export function EditorKeyboardHelp({
  messages,
  className,
}: {
  messages?: Partial<EditorKeyboardHelpMessages>;
  className?: string;
}) {
  const labels = { ...defaultMessages, ...messages };
  const modifier =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

  return (
    <details
      className={className ? `zhishu-ui-keyboard-help ${className}` : "zhishu-ui-keyboard-help"}
    >
      <summary>{labels.label}</summary>
      <div className="zhishu-ui-keyboard-help-popover">
        <p>
          <kbd>{modifier}+B</kbd> 粗体
        </p>
        <p>
          <kbd>{modifier}+I</kbd> 斜体
        </p>
        <p>
          <kbd>{modifier}+U</kbd> {labels.underline}
        </p>
        <p>
          <kbd>{modifier}+Shift+H</kbd> {labels.highlight}
        </p>
        <p>
          <kbd>{modifier}+K</kbd> {labels.insertLink}
        </p>
        <p>
          <kbd>/</kbd> {labels.insertMenu}
        </p>
      </div>
    </details>
  );
}
