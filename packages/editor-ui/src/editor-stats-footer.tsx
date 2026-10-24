import type { ReactNode } from "react";
import { useEditorSelector } from "@zhishu/editor-react";

export interface EditorStatsFooterMessages {
  label: string;
  words: string;
  characters: string;
  readingTime: string;
  minute: string;
  minutes: string;
  /** @deprecated Configure the toolbar shortcut popover with EditorShell.keyboardHelpMessages. */
  keyboardHelp: string;
  /** @deprecated Configure the toolbar shortcut popover with EditorShell.keyboardHelpMessages. */
  underline: string;
  /** @deprecated Configure the toolbar shortcut popover with EditorShell.keyboardHelpMessages. */
  highlight: string;
}

export interface EditorStatsFooterProps {
  messages?: Partial<EditorStatsFooterMessages>;
  className?: string;
  trailingSlot?: ReactNode;
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

export function EditorStatsFooter({ messages, className, trailingSlot }: EditorStatsFooterProps) {
  const statistics = useEditorSelector((snapshot) => snapshot.statistics);
  const labels = { ...defaultMessages, ...messages };

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
      {trailingSlot}
    </div>
  );
}
