import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useEditorEvents, useEditorInstance } from "@zhishu/editor-react";
import type { EditorTextMatch } from "@zhishu/editor-core";
import type { EditorCollaborationSession } from "@zhishu/editor-react";
import { EditorIcon } from "./editor-icon.js";

export interface EditorFindPanelMessages {
  label: string;
  previous: string;
  next: string;
  noMatches: string;
  matchCount: (count: number, active: number) => string;
  anchorStaleDocument: string;
  anchorStaleGeneration: string;
  anchorTargetMissing: string;
  anchorInvalid: string;
  anchorNotCurrent: string;
}

const defaultMessages: EditorFindPanelMessages = {
  label: "查找文档内容",
  previous: "上一个匹配项",
  next: "下一个匹配项",
  noMatches: "没有匹配项",
  matchCount: (count, active) => `${count} 个匹配项${active > 0 ? `，当前第 ${active} 个` : ""}`,
  anchorStaleDocument: "搜索位置属于另一篇文档，请重新搜索。",
  anchorStaleGeneration: "协同文档已切换版本，请重新搜索。",
  anchorTargetMissing: "搜索位置已失效，请重新搜索。",
  anchorInvalid: "搜索位置无法解析，请重新搜索。",
  anchorNotCurrent: "协同内容尚未同步，暂时无法恢复此位置。",
};

type CapturedAnchor = ReturnType<NonNullable<EditorCollaborationSession["captureAnchor"]>>;
type AnchoredMatch = EditorTextMatch & { anchor?: CapturedAnchor };

export interface EditorFindPanelProps {
  id?: string;
  hidden?: boolean;
  autoFocus?: boolean;
  onClose?: () => void;
  messages?: Partial<EditorFindPanelMessages>;
  className?: string;
}

export function EditorFindPanel({
  id,
  hidden = false,
  autoFocus = false,
  onClose,
  messages,
  className,
}: EditorFindPanelProps) {
  const { controller, collaboration } = useEditorInstance();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [activeMatch, setActiveMatch] = useState<{ revision: number; index: number } | null>(null);
  const [anchorFeedback, setAnchorFeedback] = useState("");
  const activeIndex = activeMatch?.revision === revision ? activeMatch.index : -1;
  const labels = { ...defaultMessages, ...messages };
  const matches = useMemo<AnchoredMatch[]>(() => {
    if (!controller || !query) return [];
    return controller.findText(query).map((match) => {
      try {
        const anchor = collaboration?.captureAnchor?.(controller.editor, {
          from: match.from,
          to: match.to,
        });
        return anchor ? { ...match, anchor } : match;
      } catch {
        return match;
      }
    });
  }, [collaboration, controller, query, revision]);

  useEditorEvents((event) => {
    if (event.docChanged) {
      setRevision((value) => value + 1);
      setAnchorFeedback("");
    }
  });

  useEffect(() => {
    if (autoFocus && !hidden) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, hidden]);

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
    if (!match) return;
    let range = { from: match.from, to: match.to };
    if (match.anchor && collaboration?.resolveAnchor) {
      const resolution = collaboration.resolveAnchor(controller.editor, match.anchor);
      if (resolution.status !== "current") {
        const feedbackByStatus = {
          "stale-document": labels.anchorStaleDocument,
          "stale-generation": labels.anchorStaleGeneration,
          "target-missing": labels.anchorTargetMissing,
          "invalid-anchor": labels.anchorInvalid,
          "not-current": labels.anchorNotCurrent,
        };
        setAnchorFeedback(feedbackByStatus[resolution.status]);
        return;
      }
      range = { from: resolution.from, to: resolution.to };
    }
    if (!controller.focusTextRange(range.from, range.to)) {
      setAnchorFeedback(labels.anchorTargetMissing);
      return;
    }
    setAnchorFeedback("");
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
      id={id}
      hidden={hidden}
      role="search"
      onSubmit={submit}
    >
      <label htmlFor={inputId}>{labels.label}</label>
      <EditorIcon name="search" />
      <input
        ref={inputRef}
        id={inputId}
        type="search"
        placeholder={labels.label}
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActiveMatch(null);
          setAnchorFeedback("");
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onClose?.();
        }}
      />
      <button
        type="button"
        aria-label={labels.previous}
        title={labels.previous}
        disabled={matches.length === 0}
        onClick={() => moveToMatch(-1)}
      >
        <EditorIcon name="chevron-left" />
        <span className="zhishu-ui-visually-hidden">{labels.previous}</span>
      </button>
      <button
        type="submit"
        aria-label={labels.next}
        title={labels.next}
        disabled={matches.length === 0}
      >
        <EditorIcon name="chevron-right" />
        <span className="zhishu-ui-visually-hidden">{labels.next}</span>
      </button>
      <span role="status" aria-live="polite">
        {anchorFeedback || status}
      </span>
    </form>
  );
}
