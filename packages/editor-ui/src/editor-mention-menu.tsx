import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useEditorEvents, useEditorInstance, type EditorMentionMember } from "@zhishu/editor-react";

type Trigger = {
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
  above: boolean;
  theme: CSSProperties;
};
export function EditorMentionMenu() {
  const { controller, hostServices } = useEditorInstance();
  const search = hostServices.searchMembers;
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const dismissed = useRef<string | null>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [result, setResult] = useState<{
    key: string;
    members: readonly EditorMentionMember[];
    error?: string;
  } | null>(null);
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => {
    if (
      !search ||
      !controller ||
      controller.isDestroyed ||
      !controller.canExecute("write").allowed ||
      controller.editor.view.composing ||
      !controller.editor.isFocused
    ) {
      setTrigger(null);
      return;
    }
    const { selection } = controller.editor.state;
    if (
      !selection.empty ||
      !selection.$from.parent.inlineContent ||
      selection.$from.parent.type.name === "codeBlock"
    ) {
      setTrigger(null);
      return;
    }
    const before = selection.$from.parent.textBetween(
      0,
      selection.$from.parentOffset,
      "",
      "\uFFFC",
    );
    const match = /(?:^|[^A-Za-z0-9._%+-])@([^\s\uFFFC]{0,100})$/u.exec(before);
    if (!match) {
      dismissed.current = null;
      setTrigger(null);
      return;
    }
    const query = match[1] ?? "";
    const from = selection.from - query.length - 1;
    if (dismissed.current === `${from}:${query}`) {
      setTrigger(null);
      return;
    }
    try {
      const rect = controller.editor.view.coordsAtPos(selection.from);
      const width = Math.min(304, window.innerWidth - 16);
      const styles = getComputedStyle(controller.editor.view.dom);
      const theme = {
        background: styles.getPropertyValue("--zhishu-editor-surface").trim() || "Canvas",
        color: styles.getPropertyValue("--zhishu-editor-text").trim() || "CanvasText",
        borderColor: styles.getPropertyValue("--zhishu-editor-border").trim() || "GrayText",
      };
      const above = window.innerHeight - rect.bottom < Math.min(300, rect.top - 8);
      setTrigger({
        theme,
        from,
        to: selection.from,
        query,
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left)),
        top: above ? Math.max(8, rect.top - 6) : rect.bottom + 6,
        above,
      });
    } catch {
      setTrigger(null);
    }
  }, [controller, search]);
  useEditorEvents((event) => {
    if (event.docChanged || event.selectionChanged) refresh();
  });
  useEffect(() => {
    if (!controller || controller.isDestroyed || !search) return;
    const dom = controller.editor.view.dom;
    let compositionTimer = 0;
    const hide = () => setTrigger(null);
    const finishComposition = () => {
      window.clearTimeout(compositionTimer);
      compositionTimer = window.setTimeout(refresh, 30);
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !dom.contains(event.target)
      )
        hide();
    };
    dom.addEventListener("keyup", refresh);
    dom.addEventListener("compositionstart", hide);
    dom.addEventListener("compositionend", finishComposition);
    dom.addEventListener("blur", hide);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      dom.removeEventListener("keyup", refresh);
      dom.removeEventListener("compositionstart", hide);
      dom.removeEventListener("compositionend", finishComposition);
      window.clearTimeout(compositionTimer);
      dom.removeEventListener("blur", hide);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [controller, refresh, search]);
  const requestKey = trigger ? `${trigger.from}:${trigger.to}:${trigger.query}` : null;
  const query = trigger?.query;
  useEffect(() => {
    if (requestKey === null || query === undefined || !search) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setIndex(0);
      void search(query, abort.signal)
        .then((members) => {
          if (abort.signal.aborted) return;
          const unique = new Map(
            members
              .filter(
                (m) =>
                  /^[A-Za-z0-9._:@-]{1,256}$/.test(m.identityId) &&
                  m.displayName.trim().length > 0 &&
                  m.displayName.length <= 80,
              )
              .map((m) => [m.identityId, m]),
          );
          setResult({ key: requestKey, members: [...unique.values()].slice(0, 20) });
        })
        .catch(() => {
          if (!abort.signal.aborted)
            setResult({ key: requestKey, members: [], error: "成员加载失败，请重试" });
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      abort.abort();
    };
  }, [requestKey, query, retry, search]);
  const members = result?.key === requestKey ? result.members : [];
  const error = result?.key === requestKey ? result.error : undefined;
  const choose = useCallback(
    (member: EditorMentionMember) => {
      if (!controller || !trigger || controller.isDestroyed) return;
      if (
        controller.editor.state.doc.textBetween(trigger.from, trigger.to, "", "\uFFFC") !==
          `@${trigger.query}` ||
        !controller.insertMention(
          { identityId: member.identityId, label: member.displayName },
          trigger,
        )
      ) {
        hostServices.reportError?.(new Error("提及位置已变化，请重新选择成员。"));
      }
      setTrigger(null);
    },
    [controller, hostServices, trigger],
  );
  useEffect(() => {
    if (!controller || !trigger) return;
    const dom = controller.editor.view.dom;
    const attributes = [
      "aria-controls",
      "aria-expanded",
      "aria-haspopup",
      "aria-activedescendant",
    ] as const;
    const original = attributes.map((name) => dom.getAttribute(name));
    dom.setAttribute("aria-controls", id);
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-haspopup", "listbox");
    if (members[index]) dom.setAttribute("aria-activedescendant", `${id}-${index}`);
    const onKeyDown = (event: KeyboardEvent) => {
      // React may not have removed this listener between two rapid key events.
      // Once dismissed, Enter must immediately return to the editor.
      if (dismissed.current === `${trigger.from}:${trigger.query}`) return;
      if (event.isComposing || event.keyCode === 229 || controller.editor.view.composing) return;
      if (!["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        dismissed.current = `${trigger.from}:${trigger.query}`;
        setTrigger(null);
      } else if (event.key === "Enter") {
        if (members[index]) choose(members[index]);
      } else if (members.length)
        setIndex(
          (current) =>
            (current + (event.key === "ArrowDown" ? 1 : -1) + members.length) % members.length,
        );
    };
    dom.addEventListener("keydown", onKeyDown, true);
    return () => {
      dom.removeEventListener("keydown", onKeyDown, true);
      attributes.forEach((name, i) => {
        const value = original[i];
        if (value === null || value === undefined) dom.removeAttribute(name);
        else dom.setAttribute(name, value);
      });
    };
  }, [choose, controller, id, index, members, trigger]);
  useEffect(() => {
    if (trigger) document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [id, index, trigger]);
  if (!trigger || !search) return null;
  return createPortal(
    <div
      ref={panel}
      className="zhishu-ui-mention-menu"
      style={{
        ...trigger.theme,
        left: trigger.left,
        top: trigger.top,
        transform: trigger.above ? "translateY(-100%)" : undefined,
        maxHeight: Math.max(
          40,
          Math.min(300, trigger.above ? trigger.top - 8 : window.innerHeight - trigger.top - 8),
        ),
      }}
    >
      <div id={id} role="listbox" aria-label="提及成员">
        {members.map((member, position) => (
          <button
            key={member.identityId}
            id={`${id}-${position}`}
            type="button"
            role="option"
            aria-selected={position === index}
            tabIndex={-1}
            className="zhishu-ui-mention-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(member)}
          >
            <span className="zhishu-ui-mention-avatar" aria-hidden="true">
              {[...member.displayName][0]}
            </span>
            <span>
              <strong>{member.displayName}</strong>
              <small>{[member.title, member.email].filter(Boolean).join(" · ")}</small>
            </span>
          </button>
        ))}
      </div>
      {error ? (
        <div role="alert" className="zhishu-ui-mention-feedback">
          {error}{" "}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : !members.length ? (
        <p role="status" className="zhishu-ui-mention-feedback">
          {result?.key === requestKey ? "没有匹配且有文档访问权限的成员" : "正在搜索成员…"}
        </p>
      ) : null}
      <p className="zhishu-ui-mention-hint">↑↓ 选择 · Enter 提及 · Esc 关闭</p>
    </div>,
    document.body,
  );
}
