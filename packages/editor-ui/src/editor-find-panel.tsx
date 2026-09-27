import { useId, useMemo, useState, type FormEvent } from "react";
import { useEditorEvents, useEditorInstance } from "@zhishu/editor-react";

export interface EditorFindPanelMessages {
  label: string;
  previous: string;
  next: string;
  noMatches: string;
  matchCount: (count: number, active: number) => string;
}

const defaultMessages: EditorFindPanelMessages = {
  label: "查找文档内容",
  previous: "上一个匹配项",
  next: "下一个匹配项",
  noMatches: "没有匹配项",
  matchCount: (count, active) => `${count} 个匹配项${active > 0 ? `，当前第 ${active} 个` : ""}`,
};

export interface EditorFindPanelProps {
  messages?: Partial<EditorFindPanelMessages>;
  className?: string;
}

export function EditorFindPanel({ messages, className }: EditorFindPanelProps) {
  const { controller } = useEditorInstance();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [activeMatch, setActiveMatch] = useState<{ revision: number; index: number } | null>(null);
  const activeIndex = activeMatch?.revision === revision ? activeMatch.index : -1;
  const labels = { ...defaultMessages, ...messages };
  const matches = useMemo(
    () => (controller && query ? controller.findText(query) : []),
    [controller, query, revision],
  );

  useEditorEvents((event) => {
    if (event.docChanged) setRevision((value) => value + 1);
  });

  function moveToMatch(direction: -1 | 1) {
    if (!controller || matches.length === 0) {
      setActiveMatch(null);
      return;
    }
    const index =
      activeIndex < 0
        ? direction > 0
          ? 0
          : matches.length - 1
        : (activeIndex + direction + matches.length) % matches.length;
    const match = matches[index];
    if (!match || !controller.focusTextRange(match.from, match.to)) return;
    setActiveMatch({ revision, index });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    moveToMatch(1);
  }

  const status = !query
    ? ""
    : matches.length === 0
      ? labels.noMatches
      : labels.matchCount(matches.length, activeIndex + 1);

  return (
    <form
      className={className ? `zhishu-ui-find-panel ${className}` : "zhishu-ui-find-panel"}
      role="search"
      onSubmit={submit}
    >
      <label htmlFor={inputId}>{labels.label}</label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActiveMatch(null);
        }}
      />
      <button type="button" disabled={matches.length === 0} onClick={() => moveToMatch(-1)}>
        {labels.previous}
      </button>
      <button type="submit" disabled={matches.length === 0}>
        {labels.next}
      </button>
      <span role="status" aria-live="polite">
        {status}
      </span>
    </form>
  );
}
