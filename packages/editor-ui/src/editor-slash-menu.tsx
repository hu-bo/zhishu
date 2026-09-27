import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { editorOriginMeta } from "@zhishu/editor-core";
import { useEditorEvents, useEditorInstance } from "@zhishu/editor-react";

export interface EditorSlashMenuMessages {
  label: string;
  noResults: string;
  textGroup: string;
  listGroup: string;
  otherGroup: string;
}

const defaultMessages: EditorSlashMenuMessages = {
  label: "插入菜单",
  noResults: "没有匹配的插入项",
  textGroup: "文本",
  listGroup: "列表",
  otherGroup: "其他",
};

type SlashAction = {
  id: string;
  label: string;
  group: "text" | "list" | "other";
  keywords: readonly string[];
  capability: string;
  run: (editor: ReturnType<typeof useEditorInstance>["controller"]) => boolean;
};

interface SlashMenuState {
  query: string;
  from: number;
  to: number;
  index: number;
  x: number;
  y: number;
  placement: "above" | "below";
}

interface SlashCommandChain {
  setParagraph(): SlashCommandChain;
  setHeading(attributes: { level: number }): SlashCommandChain;
  toggleBulletList(): SlashCommandChain;
  toggleOrderedList(): SlashCommandChain;
  toggleBlockquote(): SlashCommandChain;
  setCodeBlock(): SlashCommandChain;
  setHorizontalRule(): SlashCommandChain;
  run(): boolean;
}

export interface EditorSlashMenuProps {
  messages?: Partial<EditorSlashMenuMessages>;
  capabilities?: readonly string[];
  className?: string;
}

export function EditorSlashMenu({ messages, capabilities, className }: EditorSlashMenuProps) {
  const { controller } = useEditorInstance();
  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const labels = { ...defaultMessages, ...messages };
  const actions: readonly SlashAction[] = [
    {
      id: "paragraph",
      label: "段落",
      group: "text",
      keywords: ["正文", "paragraph", "text"],
      capability: "paragraph",
      run: (instance) => applySlashAction(instance, menu, (chain) => chain.setParagraph().run()),
    },
    {
      id: "heading-1",
      label: "一级标题",
      group: "text",
      keywords: ["标题", "heading", "h1"],
      capability: "heading",
      run: (instance) =>
        applySlashAction(instance, menu, (chain) => chain.setHeading({ level: 1 }).run()),
    },
    {
      id: "heading-2",
      label: "二级标题",
      group: "text",
      keywords: ["标题", "heading", "h2"],
      capability: "heading",
      run: (instance) =>
        applySlashAction(instance, menu, (chain) => chain.setHeading({ level: 2 }).run()),
    },
    {
      id: "bullet-list",
      label: "无序列表",
      group: "list",
      keywords: ["列表", "bullet", "ul"],
      capability: "lists",
      run: (instance) =>
        applySlashAction(instance, menu, (chain) => chain.toggleBulletList().run()),
    },
    {
      id: "ordered-list",
      label: "有序列表",
      group: "list",
      keywords: ["列表", "numbered", "ordered", "ol"],
      capability: "lists",
      run: (instance) =>
        applySlashAction(instance, menu, (chain) => chain.toggleOrderedList().run()),
    },
    {
      id: "blockquote",
      label: "引用",
      group: "other",
      keywords: ["引用", "quote", "blockquote"],
      capability: "blockquote",
      run: (instance) =>
        applySlashAction(instance, menu, (chain) => chain.toggleBlockquote().run()),
    },
    {
      id: "code-block",
      label: "代码块",
      group: "other",
      keywords: ["代码", "code", "pre"],
      capability: "codeBlock",
      run: (instance) => applySlashAction(instance, menu, (chain) => chain.setCodeBlock().run()),
    },
    {
      id: "horizontal-rule",
      label: "分隔线",
      group: "other",
      keywords: ["分隔线", "divider", "rule"],
      capability: "horizontalRule",
      run: (instance) =>
        applySlashAction(instance, menu, (chain) => chain.setHorizontalRule().run()),
    },
  ];
  const visibleActions = actions.filter((action) => {
    if (capabilities && !capabilities.includes(action.capability)) return false;
    if (!menu?.query) return true;
    const query = menu.query.toLocaleLowerCase();
    return `${action.label} ${action.keywords.join(" ")}`.toLocaleLowerCase().includes(query);
  });

  const refreshMenu = useCallback(() => {
    if (!controller || controller.isDestroyed || controller.editor.view.composing) {
      setMenu(null);
      return;
    }
    const { selection } = controller.editor.state;
    if (!selection.empty || !selection.$from.parent.inlineContent) {
      setMenu(null);
      return;
    }
    const textBefore = selection.$from.parent.textBetween(
      0,
      selection.$from.parentOffset,
      "",
      "\uFFFC",
    );
    const match = /(?:^|\s)\/([^\s]*)$/.exec(textBefore);
    if (!match) {
      setMenu(null);
      return;
    }
    const query = match[1] ?? "";
    const from = selection.from - query.length - 1;
    let x = selection.from;
    let y = 0;
    let placement: SlashMenuState["placement"] = "below";
    try {
      const rect = controller.editor.view.coordsAtPos(selection.from);
      const availableWidth = Math.max(0, window.innerWidth - 16);
      const menuWidth = Math.min(280, availableWidth);
      const maxLeft = Math.max(8, window.innerWidth - menuWidth - 8);
      x = Math.max(8, Math.min(maxLeft, rect.left));
      const below = rect.bottom + 6;
      placement = below + 260 > window.innerHeight ? "above" : "below";
      y = placement === "below" ? below : Math.max(8, rect.top - 6);
    } catch {
      setMenu(null);
      return;
    }
    setMenu((current) => ({
      query,
      from,
      to: selection.from,
      index: current?.query === query ? current.index : 0,
      x,
      y,
      placement,
    }));
  }, [controller]);

  useEditorEvents((event) => {
    if (event.docChanged || event.selectionChanged) requestAnimationFrame(refreshMenu);
  });

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    const dom = controller.editor.view.dom;
    let frame = 0;
    const scheduleRefresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshMenu);
    };
    const onCompositionStart = () => setMenu(null);
    dom.addEventListener("compositionstart", onCompositionStart);
    dom.addEventListener("keyup", scheduleRefresh);
    document.addEventListener("selectionchange", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, true);
    scheduleRefresh();
    return () => {
      cancelAnimationFrame(frame);
      dom.removeEventListener("compositionstart", onCompositionStart);
      dom.removeEventListener("keyup", scheduleRefresh);
      document.removeEventListener("selectionchange", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
    };
  }, [controller, refreshMenu]);

  useEffect(() => {
    if (!controller || controller.isDestroyed || !menu) return;
    const dom = controller.editor.view.dom;
    const previousControls = dom.getAttribute("aria-controls");
    const previousExpanded = dom.getAttribute("aria-expanded");
    const previousHasPopup = dom.getAttribute("aria-haspopup");
    const previousActiveDescendant = dom.getAttribute("aria-activedescendant");
    const activeOptionId = visibleActions[menu.index]
      ? `${listboxId}-${visibleActions[menu.index]?.id}`
      : undefined;
    dom.setAttribute("aria-controls", listboxId);
    dom.setAttribute("aria-expanded", "true");
    dom.setAttribute("aria-haspopup", "listbox");
    if (activeOptionId) dom.setAttribute("aria-activedescendant", activeOptionId);
    else dom.removeAttribute("aria-activedescendant");
    return () => {
      if (previousControls === null) dom.removeAttribute("aria-controls");
      else dom.setAttribute("aria-controls", previousControls);
      if (previousExpanded === null) dom.removeAttribute("aria-expanded");
      else dom.setAttribute("aria-expanded", previousExpanded);
      if (previousHasPopup === null) dom.removeAttribute("aria-haspopup");
      else dom.setAttribute("aria-haspopup", previousHasPopup);
      if (previousActiveDescendant === null) dom.removeAttribute("aria-activedescendant");
      else dom.setAttribute("aria-activedescendant", previousActiveDescendant);
    };
  }, [controller, listboxId, menu, visibleActions]);

  useEffect(() => {
    if (!controller || !menu) return;
    const dom = controller.editor.view.dom;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || controller.editor.view.composing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (visibleActions.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const offset = event.key === "ArrowDown" ? 1 : -1;
        setMenu((current) =>
          current
            ? {
                ...current,
                index: (current.index + offset + visibleActions.length) % visibleActions.length,
              }
            : current,
        );
      } else if (event.key === "Enter" && visibleActions[menu.index]) {
        event.preventDefault();
        event.stopPropagation();
        visibleActions[menu.index]?.run(controller);
        setMenu(null);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
      }
    };
    dom.addEventListener("keydown", onKeyDown, true);
    return () => dom.removeEventListener("keydown", onKeyDown, true);
  }, [controller, menu, visibleActions]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    const rect = element.getBoundingClientRect();
    const width = rect.width;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const x = Math.max(8, Math.min(maxLeft, menu.x));
    let y = menu.y;
    let placement = menu.placement;
    if (placement === "below" && y + rect.height > window.innerHeight - 8) {
      try {
        if (controller && !controller.isDestroyed) {
          y = Math.max(8, controller.editor.view.coordsAtPos(menu.to).top - rect.height - 6);
          placement = "above";
        }
      } catch {
        // Keep the current anchor if the editor view is being destroyed.
      }
    }
    if (Math.abs(x - menu.x) > 1 || y !== menu.y || placement !== menu.placement) {
      setMenu((current) => (current ? { ...current, x, y, placement } : current));
    }
  }, [controller, menu]);

  if (!menu || !controller || controller.isDestroyed) return null;
  const style = {
    left: `${menu.x}px`,
    top: `${menu.y}px`,
    transform: menu.placement === "above" ? "translateY(-100%)" : undefined,
  };
  const groupLabels = {
    text: labels.textGroup,
    list: labels.listGroup,
    other: labels.otherGroup,
  };

  return (
    <div
      ref={menuRef}
      id={listboxId}
      className={className ? `zhishu-ui-slash-menu ${className}` : "zhishu-ui-slash-menu"}
      style={style}
      role="listbox"
      aria-label={labels.label}
      aria-activedescendant={
        visibleActions[menu.index] ? `${listboxId}-${visibleActions[menu.index]?.id}` : undefined
      }
    >
      {visibleActions.length === 0 ? (
        <p className="zhishu-ui-slash-empty" role="status">
          {labels.noResults}
        </p>
      ) : (
        (["text", "list", "other"] as const).map((group) => {
          const items = visibleActions
            .map((action, index) => ({ action, index }))
            .filter(({ action }) => action.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} role="group" aria-label={groupLabels[group]}>
              <p className="zhishu-ui-slash-group-label">{groupLabels[group]}</p>
              {items.map(({ action, index }) => (
                <button
                  key={action.id}
                  id={`${listboxId}-${action.id}`}
                  type="button"
                  role="option"
                  aria-selected={menu.index === index}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    action.run(controller);
                    setMenu(null);
                    controller.focus();
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
}

function applySlashAction(
  controller: ReturnType<typeof useEditorInstance>["controller"],
  menu: SlashMenuState | null,
  apply: (chain: SlashCommandChain) => boolean,
): boolean {
  if (!controller || !menu || !controller.canExecute("write").allowed) return false;
  const { selection } = controller.editor.state;
  if (!selection.empty || selection.from !== menu.to || !selection.$from.parent.inlineContent) {
    return false;
  }
  const textBefore = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    "",
    "\uFFFC",
  );
  const match = /(?:^|\s)\/([^\s]*)$/.exec(textBefore);
  if (!match || match[1] !== menu.query || selection.from - menu.query.length - 1 !== menu.from) {
    return false;
  }
  const range = { from: menu.from, to: menu.to };
  const chain = controller.editor
    .chain()
    .focus()
    .setTextSelection({ from: range.from, to: range.to })
    .deleteRange(range)
    .setMeta(editorOriginMeta, "host-command") as unknown as SlashCommandChain;
  return apply(chain);
}
