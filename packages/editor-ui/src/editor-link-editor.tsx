import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { editorOriginMeta } from "@zhishu/editor-core";
import { useEditorInstance, useEditorSelector } from "@zhishu/editor-react";
import { EditorIcon } from "./editor-icon.js";

export interface EditorLinkEditorMessages {
  label: string;
  title: string;
  displayText: string;
  url: string;
  save: string;
  remove: string;
  cancel: string;
  invalidUrl: string;
  textRequired: string;
  selectionChanged: string;
}

const defaultMessages: EditorLinkEditorMessages = {
  label: "插入或编辑链接",
  title: "链接",
  displayText: "显示文本",
  url: "链接地址",
  save: "保存链接",
  remove: "移除链接",
  cancel: "取消",
  invalidUrl: "请输入有效的 http、https 或 mailto 链接。",
  textRequired: "显示文本不能为空。",
  selectionChanged: "编辑目标已变化，请重新选择文本后再试。",
};

interface LinkDraft {
  from: number;
  to: number;
  originalText: string;
  displayText: string;
  href: string;
  document: object;
}

interface LinkCommandChain {
  insertContent(content: string): LinkCommandChain;
  setTextSelection(selection: { from: number; to: number }): LinkCommandChain;
  setLink(attributes: { href: string }): LinkCommandChain;
  unsetLink(): LinkCommandChain;
  run(): boolean;
}

export interface EditorLinkEditorProps {
  messages?: Partial<EditorLinkEditorMessages>;
  className?: string;
  openRequest?: number;
  hideTrigger?: boolean;
}

export function EditorLinkEditor({
  messages,
  className,
  openRequest,
  hideTrigger = false,
}: EditorLinkEditorProps) {
  const { controller } = useEditorInstance();
  const editable = useEditorSelector((state) => state.isEditable);
  const errorId = useId();
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<"text" | "url" | null>(null);
  const displayTextRef = useRef<HTMLInputElement | null>(null);
  const previousOpenRequestRef = useRef(openRequest ?? 0);
  const openRef = useRef<() => void>(() => {});
  const labels = { ...defaultMessages, ...messages };
  const isOpen = draft !== null;

  useEffect(() => {
    if (isOpen) displayTextRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (openRequest === undefined || previousOpenRequestRef.current === openRequest) return;
    previousOpenRequestRef.current = openRequest;
    openRef.current();
  }, [openRequest]);

  if (!controller || controller.isDestroyed) return null;
  const editor = controller.editor;

  const open = () => {
    if (!controller.canExecute("write").allowed) return;
    if (editor.isActive("link")) editor.chain().extendMarkRange("link").run();
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "");
    const href = editor.isActive("link") ? String(editor.getAttributes("link").href ?? "") : "";
    setError("");
    setErrorField(null);
    setDraft({
      from,
      to,
      originalText: text,
      displayText: text,
      href,
      document: editor.state.doc,
    });
  };
  openRef.current = open;

  const close = () => {
    setDraft(null);
    setError("");
    setErrorField(null);
    requestAnimationFrame(() => {
      if (!controller.isDestroyed) editor.commands.focus();
    });
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !controller.canExecute("write").allowed) return;
    const href = validateHref(draft.href);
    if (!href) {
      setError(labels.invalidUrl);
      setErrorField("url");
      return;
    }
    const displayText = draft.displayText;
    if (!displayText.trim()) {
      setError(labels.textRequired);
      setErrorField("text");
      return;
    }
    if (
      editor.state.doc !== draft.document ||
      draft.from < 0 ||
      draft.to < draft.from ||
      draft.to > editor.state.doc.content.size ||
      editor.state.doc.textBetween(draft.from, draft.to, "") !== draft.originalText
    ) {
      setError(labels.selectionChanged);
      setErrorField(null);
      return;
    }

    const textChanged = displayText !== draft.originalText;
    let chain = editor
      .chain()
      .focus()
      .setMeta(editorOriginMeta, "host-command")
      .setTextSelection({ from: draft.from, to: draft.to }) as unknown as LinkCommandChain;
    if (textChanged) {
      chain = chain
        .insertContent(displayText)
        .setTextSelection({ from: draft.from, to: draft.from + displayText.length });
    }
    const applied = chain.setLink({ href }).run();
    if (!applied) {
      setError(labels.invalidUrl);
      setErrorField("url");
      return;
    }
    close();
  };

  const remove = () => {
    if (!draft || !draft.href || !controller.canExecute("write").allowed) return;
    if (editor.state.doc !== draft.document) {
      setError(labels.selectionChanged);
      setErrorField(null);
      return;
    }
    const chain = editor
      .chain()
      .focus()
      .setMeta(editorOriginMeta, "host-command")
      .setTextSelection({ from: draft.from, to: draft.to }) as unknown as LinkCommandChain;
    const applied = chain.unsetLink().run();
    if (applied) close();
    else {
      setError(labels.selectionChanged);
      setErrorField(null);
    }
  };

  return (
    <div className="zhishu-ui-link-editor">
      {!hideTrigger && (
        <button
          type="button"
          className={className ? `zhishu-ui-link-trigger ${className}` : "zhishu-ui-link-trigger"}
          aria-label={labels.label}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          disabled={!editable}
          title={editable ? labels.label : (controller.readonlyReason ?? labels.label)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={open}
        >
          <EditorIcon name="link" />
          <span className="zhishu-ui-visually-hidden">{labels.label}</span>
        </button>
      )}
      {draft && (
        <form
          className="zhishu-ui-link-dialog"
          role="dialog"
          aria-label={labels.title}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
          onSubmit={save}
        >
          <label>
            <span>{labels.displayText}</span>
            <input
              ref={displayTextRef}
              type="text"
              value={draft.displayText}
              onChange={(event) => {
                setDraft({ ...draft, displayText: event.target.value });
                if (errorField === "text") {
                  setError("");
                  setErrorField(null);
                }
              }}
              aria-invalid={errorField === "text"}
              aria-describedby={errorField === "text" ? errorId : undefined}
            />
          </label>
          <label>
            <span>{labels.url}</span>
            <input
              type="text"
              inputMode="url"
              autoComplete="url"
              value={draft.href}
              onChange={(event) => {
                setDraft({ ...draft, href: event.target.value });
                if (errorField === "url") {
                  setError("");
                  setErrorField(null);
                }
              }}
              aria-invalid={errorField === "url"}
              aria-describedby={errorField === "url" ? errorId : undefined}
            />
          </label>
          {error && (
            <p id={errorId} className="zhishu-ui-link-error" role="alert">
              {error}
            </p>
          )}
          <div className="zhishu-ui-link-actions">
            {draft.href && (
              <button type="button" onClick={remove}>
                {labels.remove}
              </button>
            )}
            <button type="button" onClick={close}>
              {labels.cancel}
            </button>
            <button type="submit">{labels.save}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function validateHref(value: string): string | undefined {
  const href = value.trim();
  if (!href || href.length > 2048 || /\s/.test(href)) return undefined;
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      if (!url.hostname || url.username || url.password) return undefined;
      return href;
    }
    if (url.protocol === "mailto:" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(url.pathname)) {
      return href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
