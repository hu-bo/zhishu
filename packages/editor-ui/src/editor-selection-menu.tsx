import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import {
  useEditorEvents,
  useEditorInstance,
  useEditorSelector,
  useEditorStructureAction,
} from "@zhishu/editor-react";
import { EditorStructureFeedback } from "./editor-structure-feedback.js";

export interface EditorSelectionMenuMessages {
  label: string;
  bold: string;
  italic: string;
  strike: string;
  underline: string;
  highlight: string;
  clearFormatting: string;
  link: string;
  code: string;
  callout: string;
}

const defaultMessages: EditorSelectionMenuMessages = {
  label: "选区格式工具",
  bold: "加粗",
  italic: "斜体",
  strike: "删除线",
  underline: "下划线",
  highlight: "高亮",
  clearFormatting: "清除格式",
  link: "链接",
  code: "行内代码",
  callout: "转换为提示块",
};

const useClientLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface MenuPosition {
  x: number;
  y: number;
  placement: "above" | "below";
}

export interface EditorSelectionMenuProps {
  messages?: Partial<EditorSelectionMenuMessages>;
  className?: string;
  onOpenLink?: () => void;
}

export function EditorSelectionMenu({ messages, className, onOpenLink }: EditorSelectionMenuProps) {
  const { controller } = useEditorInstance();
  const calloutAction = useEditorStructureAction();
  const isEditable = useEditorSelector((state) => state.isEditable);
  const formatting = useEditorSelector((state) => state.formatting);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const dismissedRef = useRef(false);
  const labels = { ...defaultMessages, ...messages };

  const updatePosition = useCallback(() => {
    if (
      !controller ||
      controller.isDestroyed ||
      !isEditable ||
      isComposing ||
      dismissedRef.current
    ) {
      setPosition(null);
      return;
    }
    const { editor } = controller;
    const { selection } = editor.state;
    if (editor.view.composing || selection.empty || !selection.$from.parent.inlineContent) {
      setPosition(null);
      return;
    }

    try {
      const start = editor.view.coordsAtPos(selection.from);
      const end = editor.view.coordsAtPos(selection.to);
      const inset = Math.min(120, Math.max(8, window.innerWidth / 2 - 8));
      const x = Math.max(inset, Math.min(window.innerWidth - inset, (start.left + end.right) / 2));
      const aboveY = Math.min(start.top, end.top) - 8;
      const belowY = Math.max(start.bottom, end.bottom) + 8;
      const placement = aboveY < 52 ? "below" : "above";
      const y =
        placement === "above" ? aboveY : Math.min(window.innerHeight - 48, Math.max(8, belowY));
      setPosition({ x, y, placement });
    } catch {
      setPosition(null);
    }
  }, [controller, isComposing, isEditable]);

  useEditorEvents((event) => {
    if (!event.selectionChanged && !event.docChanged) return;
    dismissedRef.current = false;
    requestAnimationFrame(updatePosition);
  });

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    const { dom } = controller.editor.view;
    let frame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePosition);
    };
    const onCompositionStart = () => {
      setIsComposing(true);
      setPosition(null);
    };
    const onCompositionEnd = () => {
      frame = requestAnimationFrame(() => {
        setIsComposing(false);
        updatePosition();
      });
    };
    const onEditorBlur: EventListener = (event) => {
      const target = (event as globalThis.FocusEvent).relatedTarget;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      dismissedRef.current = true;
      setPosition(null);
    };
    const onOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || dom.contains(target)) return;
      dismissedRef.current = true;
      setPosition(null);
    };
    const onEditorPointerDown = () => {
      dismissedRef.current = false;
    };

    dom.addEventListener("compositionstart", onCompositionStart);
    dom.addEventListener("compositionend", onCompositionEnd);
    dom.addEventListener("blur", onEditorBlur, true);
    dom.addEventListener("pointerdown", onEditorPointerDown);
    dom.addEventListener("keyup", scheduleUpdate);
    dom.addEventListener("mouseup", scheduleUpdate);
    document.addEventListener("selectionchange", scheduleUpdate);
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    scheduleUpdate();

    return () => {
      cancelAnimationFrame(frame);
      dom.removeEventListener("compositionstart", onCompositionStart);
      dom.removeEventListener("compositionend", onCompositionEnd);
      dom.removeEventListener("blur", onEditorBlur, true);
      dom.removeEventListener("pointerdown", onEditorPointerDown);
      dom.removeEventListener("keyup", scheduleUpdate);
      dom.removeEventListener("mouseup", scheduleUpdate);
      document.removeEventListener("selectionchange", scheduleUpdate);
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [controller, updatePosition]);

  useClientLayoutEffect(() => {
    const menu = menuRef.current;
    if (!position || !menu) return;
    const width = menu.getBoundingClientRect().width;
    const inset = Math.min(width / 2 + 8, Math.max(8, window.innerWidth / 2));
    const x = Math.max(inset, Math.min(window.innerWidth - inset, position.x));
    if (Math.abs(x - position.x) > 1)
      setPosition((current) => (current ? { ...current, x } : current));
  }, [position]);

  function handleMenuBlur(event: FocusEvent<HTMLDivElement>) {
    const target = event.relatedTarget;
    if (
      target instanceof Node &&
      (menuRef.current?.contains(target) || controller?.editor.view.dom.contains(target))
    ) {
      return;
    }
    dismissedRef.current = true;
    setPosition(null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissedRef.current = true;
      setPosition(null);
      controller?.focus();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (!buttons?.length) return;
    const currentIndex = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons.item(nextIndex)?.focus();
  }

  if (!position || !controller || controller.isDestroyed)
    return <EditorStructureFeedback action={calloutAction} />;
  const style: CSSProperties = {
    left: `${position.x}px`,
    top: `${position.y}px`,
    transform: position.placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
  };
  const actions = [
    {
      id: "bold",
      label: labels.bold,
      pressed: formatting.bold,
      run: () => controller.toggleBold(),
    },
    {
      id: "italic",
      label: labels.italic,
      pressed: formatting.italic,
      run: () => controller.toggleItalic(),
    },
    {
      id: "strike",
      label: labels.strike,
      pressed: formatting.strike,
      run: () => controller.toggleStrike(),
    },
    {
      id: "underline",
      label: labels.underline,
      pressed: formatting.underline,
      run: () => controller.toggleUnderline(),
    },
    {
      id: "highlight",
      label: labels.highlight,
      pressed: formatting.highlight,
      run: () => {
        if (formatting.highlight === true) controller.unsetHighlight();
        else controller.setHighlightColor("yellow");
      },
    },
    {
      id: "clear-formatting",
      label: labels.clearFormatting,
      run: () => controller.clearFormatting(),
    },
    ...(onOpenLink ? [{ id: "link", label: labels.link, run: onOpenLink }] : []),
    {
      id: "code",
      label: labels.code,
      pressed: formatting.code,
      run: () => controller.toggleCode(),
    },
    {
      id: "callout",
      label: labels.callout,
      disabled: !calloutAction.allowed || calloutAction.busy || calloutAction.canRetry,
      run: () =>
        void calloutAction.run({
          type: "wrap-callout",
          targetBlockIds: controller.getSelectedBlockIds(),
          theme: "info",
        }),
    },
  ];

  return (
    <div
      ref={menuRef}
      className={className ? `zhishu-ui-selection-menu ${className}` : "zhishu-ui-selection-menu"}
      style={style}
      role="toolbar"
      aria-label={labels.label}
      onBlur={handleMenuBlur}
      onKeyDown={handleKeyDown}
    >
      {actions.map((action, index) => (
        <button
          key={action.id}
          type="button"
          aria-label={action.label}
          aria-pressed={action.pressed === "mixed" ? "mixed" : action.pressed}
          disabled={!isEditable || action.disabled}
          tabIndex={index === 0 ? 0 : -1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
