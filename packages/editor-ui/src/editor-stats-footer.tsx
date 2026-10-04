import { useEditorSelector } from "@zhishu/editor-react";

export interface EditorStatsFooterMessages {
  label: string;
  words: string;
  characters: string;
  readingTime: string;
  minute: string;
  minutes: string;
  keyboardHelp: string;
  underline: string;
  highlight: string;
}

export interface EditorStatsFooterProps {
  messages?: Partial<EditorStatsFooterMessages>;
  className?: string;
}

const defaultMessages: EditorStatsFooterMessages = {
  label: "文档统计",
  words: "词",
  characters: "字符",
  readingTime: "预计阅读",
  minute: "分钟",
  minutes: "分钟",
  keyboardHelp: "快捷键",
  underline: "下划线",
  highlight: "黄色高亮",
};

export function EditorStatsFooter({ messages, className }: EditorStatsFooterProps) {
  const statistics = useEditorSelector((snapshot) => snapshot.statistics);
  const labels = { ...defaultMessages, ...messages };
  const modifier =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

  return (
    <div className={["zhishu-ui-stats-footer", className].filter(Boolean).join(" ")}>
      <div className="zhishu-ui-statistics" role="group" aria-label={labels.label}>
        <span>
          <strong>{statistics.wordCount.toLocaleString()}</strong> {labels.words}
        </span>
        <span>
          <strong>{statistics.characterCount.toLocaleString()}</strong> {labels.characters}
        </span>
        <span>
          {labels.readingTime} <strong>{statistics.readingTimeMinutes}</strong>{" "}
          {statistics.readingTimeMinutes === 1 ? labels.minute : labels.minutes}
        </span>
      </div>
      <details className="zhishu-ui-keyboard-help">
        <summary>{labels.keyboardHelp}</summary>
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
            <kbd>{modifier}+K</kbd> 插入链接
          </p>
          <p>
            <kbd>/</kbd> 打开插入菜单
          </p>
        </div>
      </details>
    </div>
  );
}
