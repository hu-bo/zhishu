import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { editorOriginMeta, MAX_LATEX_LENGTH } from "@zhishu/editor-core";
import type { EditorController } from "@zhishu/editor-core";
import { useEditorEvents, useEditorInstance, useEditorStructureAction } from "@zhishu/editor-react";
import { EditorIcon, type EditorIconName } from "./editor-icon.js";
import { EditorStructureFeedback } from "./editor-structure-feedback.js";

export interface EditorSlashMenuMessages {
  label: string;
  noResults: string;
  keyboardHint: string;
  textGroup: string;
  listGroup: string;
  otherGroup: string;
  editorNotReady: string;
  currentlyReadOnly: string;
  blockStructureUnavailable: string;
}

const defaultMessages: EditorSlashMenuMessages = {
  label: "插入菜单",
  noResults: "没有匹配的插入项",
  keyboardHint: "↑↓ 选择 · Enter 插入 · Esc 关闭",
  textGroup: "文本",
  listGroup: "列表",
  otherGroup: "其他",
  editorNotReady: "编辑器尚未就绪",
  currentlyReadOnly: "当前为只读",
  blockStructureUnavailable: "当前模式暂不支持此块操作",
};

type SlashAction = {
  id: string;
  label: string;
  description: string;
  icon: EditorIconName;
  group: "text" | "list" | "other";
  keywords: readonly string[];
  capability: string;
  collaborativeOperation?: boolean;
  inline?: boolean;
  run: (editor: ReturnType<typeof useEditorInstance>["controller"]) => boolean;
};

type SlashCollaboration = NonNullable<ReturnType<typeof useEditorInstance>["collaboration"]>;

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

export function useEditorInsertionActions(
  menu: SlashMenuState | null,
  capabilities?: readonly string[],
  messages?: Partial<EditorSlashMenuMessages>,
) {
  const { controller, collaboration, collaborationStatus, hostServices } = useEditorInstance();
  const contentAction = useEditorStructureAction();
  const labels = { ...defaultMessages, ...messages };
  const collaborativeStructureAllowed =
    collaboration?.readOnly === false &&
    collaborationStatus?.connection === "connected" &&
    collaborationStatus.sync === "current" &&
    typeof collaboration.submitStructureOperation === "function";
  function runContentAction(kind: "callout" | "divider" | "status"): boolean {
    if (!controller || contentAction.busy || contentAction.canRetry) return false;
    const toolbarMenu = !menu;
    if (toolbarMenu && !focusToolbarSelection(controller, collaborativeStructureAllowed))
      return false;
    const trigger = toolbarMenu
      ? null
      : getSlashTrigger(controller, menu, collaborativeStructureAllowed);
    if (!toolbarMenu && !trigger) return false;
    if (kind === "status") {
      if (trigger && !controller.focusTextRange(trigger.from, trigger.to)) return false;
      return controller.insertStatusTag();
    }
    if (!contentAction.allowed) return false;
    if (kind === "divider") {
      const paragraph = controller.editor.state.selection.$from.parent;
      if (paragraph.type.name !== "paragraph" || typeof paragraph.attrs.blockId !== "string")
        return false;
      const expectedText = paragraph.textBetween(0, paragraph.content.size, "", "\uFFFC");
      if (expectedText !== (trigger?.text ?? "")) {
        hostServices.reportError?.(new Error("请在空段落中插入分隔线。"));
        return false;
      }
      void contentAction.run({
        type: "make-divider",
        targetBlockId: paragraph.attrs.blockId,
        expectedText,
        label: "",
      });
      return true;
    }
    if (trigger && !collaboration && !deleteSlashTrigger(controller, trigger)) return false;
    const targetBlockIds = controller.getSelectedBlockIds();
    void contentAction
      .run({ type: "wrap-callout", targetBlockIds, theme: "info" })
      .then((success) => {
        if (success && trigger && collaboration && !controller.isDestroyed)
          removeSlashTrigger(controller, trigger, hostServices.reportError);
      });
    return true;
  }
  function insertFormula(inline: boolean): boolean {
    if (
      !controller ||
      (!inline && (!contentAction.allowed || contentAction.busy || contentAction.canRetry))
    ) {
      return false;
    }
    const toolbarMenu = !menu;
    const allowStructure = inline || collaborativeStructureAllowed;
    if (toolbarMenu && !focusToolbarSelection(controller, allowStructure)) return false;
    const trigger = toolbarMenu ? null : getSlashTrigger(controller, menu, allowStructure);
    if (!toolbarMenu && !trigger) return false;
    const { $from, $to } = controller.editor.state.selection;
    const paragraph = $from.parent;
    const blockId = paragraph.attrs.blockId;
    const expectedText = trigger?.text ?? "";
    if (
      !inline &&
      (paragraph.type.name !== "paragraph" ||
        typeof blockId !== "string" ||
        !$from.sameParent($to) ||
        paragraph.textBetween(0, paragraph.content.size, "", "\uFFFC") !== expectedText)
    ) {
      hostServices.reportError?.(new Error("请在空段落中插入公式块。"));
      return false;
    }
    if (
      inline &&
      (!paragraph.inlineContent || paragraph.type.spec.code || !$from.sameParent($to))
    ) {
      return false;
    }
    const { doc, selection } = controller.editor.state;
    void Promise.resolve()
      .then(() => controller.requestMathSource({ kind: inline ? "inline" : "block" }))
      .then((source) => {
        if (source === null || !controller.canExecute("write").allowed) return;
        const latex = source.trim();
        if (!latex || latex.length > MAX_LATEX_LENGTH) {
          throw new Error(`请输入 1 至 ${MAX_LATEX_LENGTH} 个字符的 LaTeX 公式。`);
        }
        if (inline) {
          if (
            !controller.editor.state.doc.eq(doc) ||
            !controller.focusTextRange(
              trigger?.from ?? selection.from,
              trigger?.to ?? selection.to,
            ) ||
            !controller.insertInlineFormula(latex)
          ) {
            throw new Error("原选区已变化，请重新选择后插入公式。");
          }
          return;
        }
        return contentAction.run({
          type: "make-block-math",
          targetBlockId: blockId,
          expectedText,
          latex,
        });
      })
      .catch((error: unknown) =>
        hostServices.reportError?.(error instanceof Error ? error : new Error("无法插入公式。")),
      )
      .finally(() => {
        if (!controller.isDestroyed) controller.focus();
      });
    return true;
  }
  const actions: readonly SlashAction[] = [
    {
      id: "inline-math",
      label: "行内公式",
      description: "在当前行插入 LaTeX 公式。",
      icon: "code",
      group: "other",
      keywords: ["数学", "latex", "math", "inline"],
      capability: "inlineMath",
      inline: true,
      run: () => insertFormula(true),
    },
    {
      id: "block-math",
      label: "公式块",
      description: "在空段落插入独立的 LaTeX 公式。",
      icon: "code",
      group: "other",
      keywords: ["数学", "latex", "math", "equation"],
      capability: "blockMath",
      collaborativeOperation: true,
      run: () => insertFormula(false),
    },
    {
      id: "callout",
      label: "提示块",
      description: "将当前块转换为可切换主题的提示块。",
      icon: "alert",
      group: "other",
      keywords: ["提示", "callout", "警告", "info"],
      capability: "callout",
      collaborativeOperation: true,
      run: () => runContentAction("callout"),
    },
    {
      id: "status-tag",
      label: "状态标签",
      description: "插入可切换的文档内状态。",
      icon: "check",
      group: "other",
      keywords: ["状态", "status", "badge"],
      capability: "statusTag",
      collaborativeOperation: true,
      run: () => runContentAction("status"),
    },
    {
      id: "labeled-divider",
      label: "带标签分隔线",
      description: "在空段落插入可原位编辑标签的分隔线。",
      icon: "horizontal-rule",
      group: "other",
      keywords: ["分隔", "divider", "标签"],
      capability: "horizontalRule",
      collaborativeOperation: true,
      run: () => runContentAction("divider"),
    },
    {
      id: "paragraph",
      label: "段落",
      description: "切换为普通正文段落。",
      icon: "paragraph",
      group: "text",
      keywords: ["正文", "paragraph", "text"],
      capability: "paragraph",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.setParagraph().run(),
          (editor) => editor.setParagraph(),
        ),
    },
    {
      id: "heading-1",
      label: "一级标题",
      description: "设置为一级标题，用作文档主章节。",
      icon: "heading",
      group: "text",
      keywords: ["标题", "heading", "h1"],
      capability: "heading",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.setHeading({ level: 1 }).run(),
          (editor) => editor.setHeading(1),
        ),
    },
    {
      id: "heading-2",
      label: "二级标题",
      description: "设置为二级标题，用作章节小节。",
      icon: "heading",
      group: "text",
      keywords: ["标题", "heading", "h2"],
      capability: "heading",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.setHeading({ level: 2 }).run(),
          (editor) => editor.setHeading(2),
        ),
    },
    {
      id: "bullet-list",
      label: "无序列表",
      description: "插入带项目符号的列表。",
      icon: "list",
      group: "list",
      keywords: ["列表", "bullet", "ul"],
      capability: "lists",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.toggleBulletList().run(),
          (editor) => editor.toggleBulletList(),
        ),
    },
    {
      id: "ordered-list",
      label: "有序列表",
      description: "插入按顺序编号的列表。",
      icon: "ordered-list",
      group: "list",
      keywords: ["列表", "numbered", "ordered", "ol"],
      capability: "lists",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.toggleOrderedList().run(),
          (editor) => editor.toggleOrderedList(),
        ),
    },
    {
      id: "task-list",
      label: "任务清单项",
      description: "将当前段落转换为可勾选任务。",
      icon: "task-list",
      group: "list",
      keywords: ["任务", "待办", "清单", "checkbox", "todo", "task"],
      capability: "taskList",
      collaborativeOperation: true,
      run: (instance) => {
        if (!instance) return false;
        const toolbarMenu = !menu;
        if (toolbarMenu && !focusToolbarSelection(instance, collaborativeStructureAllowed))
          return false;
        const trigger = toolbarMenu
          ? null
          : getSlashTrigger(instance, menu, collaborativeStructureAllowed);
        if (!toolbarMenu && !trigger) return false;
        const targetBlockId = instance.editor.state.selection.$from.parent.attrs.blockId;
        if (typeof targetBlockId !== "string") return false;
        const prepared = instance.prepareStructureAction({
          type: "make-task-item",
          targetBlockId,
        });
        if (!prepared.success) {
          hostServices.reportError?.(new Error(prepared.result.error.message));
          return false;
        }
        if (collaboration?.submitStructureOperation) {
          void submitStructureOperationWithRetry(collaboration, prepared.batch)
            .then((result) => {
              if (result.status === "accepted" || result.status === "duplicate") {
                if (trigger) removeSlashTrigger(instance, trigger, hostServices.reportError);
              } else {
                hostServices.reportError?.(
                  new Error("code" in result ? result.code : "任务清单项提交失败。"),
                );
              }
            })
            .catch((error: unknown) => {
              hostServices.reportError?.(
                error instanceof Error ? error : new Error("任务清单项提交失败。"),
              );
            });
          return true;
        }
        if (trigger && !deleteSlashTrigger(instance, trigger)) return false;
        const result = instance.applyOperations(prepared.batch);
        if (!result.success) hostServices.reportError?.(new Error(result.error.message));
        return result.success;
      },
    },
    {
      id: "nested-task-list",
      label: "嵌套任务清单",
      description: "在当前任务下添加子任务列表。",
      icon: "task-list",
      group: "list",
      keywords: ["子任务", "嵌套", "任务", "清单", "todo", "task"],
      capability: "taskList",
      collaborativeOperation: true,
      run: (instance) => {
        if (!instance) return false;
        const toolbarMenu = !menu;
        if (toolbarMenu && !focusToolbarSelection(instance, collaborativeStructureAllowed))
          return false;
        const trigger = toolbarMenu
          ? null
          : getSlashTrigger(instance, menu, collaborativeStructureAllowed);
        if (!toolbarMenu && !trigger) return false;
        const parentBlockId = instance.editor.state.selection.$from.parent.attrs.blockId;
        if (typeof parentBlockId !== "string") return false;
        const prepared = instance.prepareStructureAction({
          type: "insert-nested-task-list",
          parentBlockId,
        });
        if (!prepared.success) {
          hostServices.reportError?.(new Error(prepared.result.error.message));
          return false;
        }
        if (collaboration?.submitStructureOperation) {
          void submitStructureOperationWithRetry(collaboration, prepared.batch)
            .then((result) => {
              if (result.status === "accepted" || result.status === "duplicate") {
                if (trigger) removeSlashTrigger(instance, trigger, hostServices.reportError);
              } else {
                hostServices.reportError?.(
                  new Error("code" in result ? result.code : "嵌套任务清单提交失败。"),
                );
              }
            })
            .catch((error: unknown) => {
              hostServices.reportError?.(
                error instanceof Error ? error : new Error("嵌套任务清单提交失败。"),
              );
            });
          return true;
        }
        if (trigger && !deleteSlashTrigger(instance, trigger)) return false;
        const result = instance.applyOperations(prepared.batch);
        if (!result.success) hostServices.reportError?.(new Error(result.error.message));
        return result.success;
      },
    },
    {
      id: "table",
      label: "表格",
      description: "在空段落处插入三列表格。",
      icon: "table",
      group: "other",
      keywords: ["表格", "table", "grid"],
      capability: "table",
      collaborativeOperation: true,
      run: (instance) => {
        if (!instance) return false;
        const toolbarMenu = !menu;
        if (toolbarMenu && !focusToolbarSelection(instance, collaborativeStructureAllowed))
          return false;
        const trigger = toolbarMenu
          ? null
          : getSlashTrigger(instance, menu, collaborativeStructureAllowed);
        if (!toolbarMenu && !trigger) return false;
        const selection = instance.editor.state.selection;
        const parent = selection.$from.parent;
        const blockId = parent.attrs.blockId;
        if (typeof blockId !== "string") return false;
        const actionTarget = trigger ?? {
          from: selection.from,
          to: selection.to,
          text: "",
          blockId,
        };
        if (toolbarMenu && (!selection.empty || parent.type.name !== "paragraph")) {
          hostServices.reportError?.(new Error("请将光标放在空段落中再插入表格。"));
          return false;
        }
        const paragraphText = instance.editor.state.selection.$from.parent.textBetween(
          0,
          instance.editor.state.selection.$from.parent.content.size,
          "",
          "\uFFFC",
        );
        if (paragraphText !== actionTarget.text) {
          hostServices.reportError?.(
            new Error(
              toolbarMenu
                ? "请将光标放在空段落中再插入表格。"
                : "请在空段落中输入 /table 后插入表格。",
            ),
          );
          return false;
        }
        const prepared = instance.prepareStructureAction({
          type: "insert-table",
          targetBlockId: actionTarget.blockId,
          expectedText: actionTarget.text,
        });
        if (!prepared.success) {
          hostServices.reportError?.(new Error(prepared.result.error.message));
          return false;
        }
        if (collaboration?.submitStructureOperation) {
          void submitStructureOperationWithRetry(collaboration, prepared.batch)
            .then((result) => {
              if (result.status === "accepted" || result.status === "duplicate") {
                // Replacing the slash-command paragraph with the table consumes the trigger.
              } else {
                hostServices.reportError?.(
                  new Error("code" in result ? result.code : "表格插入失败。"),
                );
              }
            })
            .catch((error: unknown) => {
              hostServices.reportError?.(
                error instanceof Error ? error : new Error("表格插入失败。"),
              );
            });
          return true;
        }
        if (trigger && !deleteSlashTrigger(instance, trigger)) return false;
        const result = instance.applyOperations(prepared.batch);
        if (!result.success) hostServices.reportError?.(new Error(result.error.message));
        return result.success;
      },
    },
    {
      id: "blockquote",
      label: "引用",
      description: "将当前段落转换为引用块。",
      icon: "quote",
      group: "other",
      keywords: ["引用", "quote", "blockquote"],
      capability: "blockquote",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.toggleBlockquote().run(),
          (editor) => editor.toggleBlockquote(),
        ),
    },
    {
      id: "code-block",
      label: "代码块",
      description: "插入等宽代码块。",
      icon: "code",
      group: "other",
      keywords: ["代码", "code", "pre"],
      capability: "codeBlock",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.setCodeBlock().run(),
          (editor) => editor.setCodeBlock(),
        ),
    },
    {
      id: "horizontal-rule",
      label: "分隔线",
      description: "插入正文分隔线。",
      icon: "horizontal-rule",
      group: "other",
      keywords: ["分隔线", "divider", "rule"],
      capability: "horizontalRule",
      run: (instance) =>
        applySlashAction(
          instance,
          menu,
          (chain) => chain.setHorizontalRule().run(),
          (editor) => editor.setHorizontalRule(),
        ),
    },
  ];
  const visibleActions = actions.filter((action) => {
    if (capabilities && !capabilities.includes(action.capability)) return false;
    if (
      action.id === "nested-task-list" &&
      controller?.editor.state.selection.$from.parent.type.name !== "taskItem"
    ) {
      return false;
    }
    if ((action.id === "table" || action.id === "block-math") && isInsideTable(controller))
      return false;
    if (!menu?.query) return true;
    const query = menu.query.toLocaleLowerCase();
    return `${action.label} ${action.keywords.join(" ")}`.toLocaleLowerCase().includes(query);
  });
  const getActionDisabledReason = useCallback(
    (action: SlashAction) => {
      if (!controller) return labels.editorNotReady;
      if (!controller.canExecute("write").allowed) return labels.currentlyReadOnly;
      if (action.inline) return undefined;
      const structure = controller.canExecute("block-structure");
      if (structure.allowed || (action.collaborativeOperation && collaborativeStructureAllowed)) {
        return undefined;
      }
      return structure.reason === "read-only"
        ? labels.currentlyReadOnly
        : labels.blockStructureUnavailable;
    },
    [
      collaborativeStructureAllowed,
      controller,
      labels.blockStructureUnavailable,
      labels.currentlyReadOnly,
      labels.editorNotReady,
    ],
  );

  return { contentAction, visibleActions, getActionDisabledReason };
}

export function EditorSlashMenu({ messages, capabilities, className }: EditorSlashMenuProps) {
  const { controller, hostServices } = useEditorInstance();
  const [menu, setMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();
  const labels = { ...defaultMessages, ...messages };
  const { contentAction, visibleActions, getActionDisabledReason } = useEditorInsertionActions(
    menu,
    capabilities,
    messages,
  );

  const refreshMenu = useCallback(() => {
    if (
      !controller ||
      controller.isDestroyed ||
      !controller.editor.isFocused ||
      controller.editor.view.composing
    ) {
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
    dom.addEventListener("blur", scheduleRefresh);
    dom.addEventListener("keyup", scheduleRefresh);
    document.addEventListener("selectionchange", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, true);
    scheduleRefresh();
    return () => {
      cancelAnimationFrame(frame);
      dom.removeEventListener("compositionstart", onCompositionStart);
      dom.removeEventListener("blur", scheduleRefresh);
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
        const selectedAction = visibleActions[menu.index];
        const disabledReason = selectedAction && getActionDisabledReason(selectedAction);
        if (disabledReason) hostServices.reportError?.(new Error(disabledReason));
        else selectedAction?.run(controller);
        setMenu(null);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
      }
    };
    dom.addEventListener("keydown", onKeyDown, true);
    return () => dom.removeEventListener("keydown", onKeyDown, true);
  }, [controller, getActionDisabledReason, hostServices, menu, visibleActions]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    element
      .querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
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

  if (!menu || !controller || controller.isDestroyed)
    return <EditorStructureFeedback action={contentAction} />;
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
              {items.map(({ action, index }) => {
                const disabledReason = getActionDisabledReason(action);
                return (
                  <button
                    key={action.id}
                    id={`${listboxId}-${action.id}`}
                    type="button"
                    role="option"
                    aria-selected={menu.index === index}
                    aria-describedby={`${listboxId}-${action.id}-description`}
                    aria-disabled={disabledReason !== undefined}
                    aria-description={disabledReason}
                    tabIndex={-1}
                    className="zhishu-ui-slash-option"
                    disabled={disabledReason !== undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (disabledReason) {
                        hostServices.reportError?.(new Error(disabledReason));
                        return;
                      }
                      action.run(controller);
                      setMenu(null);
                      controller.focus();
                    }}
                  >
                    <EditorIcon name={action.icon} />
                    <span className="zhishu-ui-slash-option-copy">
                      <span className="zhishu-ui-slash-option-label">{action.label}</span>
                      <span
                        id={`${listboxId}-${action.id}-description`}
                        className="zhishu-ui-slash-option-description"
                      >
                        {action.description}
                      </span>
                      {disabledReason && (
                        <span className="zhishu-ui-slash-option-description">{disabledReason}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })
      )}
      <p className="zhishu-ui-slash-keyboard-hint">{labels.keyboardHint}</p>
    </div>
  );
}

function applySlashAction(
  controller: ReturnType<typeof useEditorInstance>["controller"],
  menu: SlashMenuState | null,
  apply: (chain: SlashCommandChain) => boolean,
  applyToolbar: (controller: EditorController) => boolean,
): boolean {
  if (!controller) return false;
  if (!menu) {
    if (!focusToolbarSelection(controller)) return false;
    return applyToolbar(controller);
  }
  const trigger = getSlashTrigger(controller, menu);
  if (!trigger) return false;
  const chain = controller.editor
    .chain()
    .focus()
    .setTextSelection({ from: trigger.from, to: trigger.to })
    .deleteRange({ from: trigger.from, to: trigger.to })
    .setMeta(editorOriginMeta, "host-command") as unknown as SlashCommandChain;
  return apply(chain);
}

function focusToolbarSelection(
  controller: ReturnType<typeof useEditorInstance>["controller"],
  allowCollaborativeStructure = false,
): boolean {
  if (
    !controller ||
    !controller.canExecute("write").allowed ||
    (!controller.canExecute("block-structure").allowed && !allowCollaborativeStructure)
  ) {
    return false;
  }
  controller.focus();
  return true;
}

function isInsideTable(controller: ReturnType<typeof useEditorInstance>["controller"]): boolean {
  if (!controller) return false;
  const { $from } = controller.editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "table") return true;
  }
  return false;
}

type SlashTrigger = { from: number; to: number; text: string; blockId: string };

function getSlashTrigger(
  controller: ReturnType<typeof useEditorInstance>["controller"],
  menu: SlashMenuState | null,
  allowCollaborativeStructure = false,
): SlashTrigger | null {
  if (
    !controller ||
    !menu ||
    !controller.canExecute("write").allowed ||
    (!controller.canExecute("block-structure").allowed && !allowCollaborativeStructure)
  ) {
    return null;
  }
  const { selection } = controller.editor.state;
  if (!selection.empty || selection.from !== menu.to || !selection.$from.parent.inlineContent) {
    return null;
  }
  const textBefore = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    "",
    "\uFFFC",
  );
  const match = /(?:^|\s)\/([^\s]*)$/.exec(textBefore);
  if (!match || match[1] !== menu.query || selection.from - menu.query.length - 1 !== menu.from) {
    return null;
  }
  const blockId = selection.$from.parent.attrs.blockId;
  if (typeof blockId !== "string") return null;
  return {
    from: menu.from,
    to: menu.to,
    text: `/${menu.query}`,
    blockId,
  };
}

function deleteSlashTrigger(
  controller: NonNullable<ReturnType<typeof useEditorInstance>["controller"]>,
  trigger: Pick<SlashTrigger, "from" | "to">,
): boolean {
  const chain = controller.editor
    .chain()
    .focus()
    .setTextSelection({ from: trigger.from, to: trigger.to })
    .deleteRange({ from: trigger.from, to: trigger.to })
    .setMeta(editorOriginMeta, "host-command") as unknown as SlashCommandChain;
  return chain.run();
}

async function submitStructureOperationWithRetry(
  collaboration: SlashCollaboration,
  batch: Parameters<NonNullable<SlashCollaboration["submitStructureOperation"]>>[0],
) {
  const submit = collaboration.submitStructureOperation;
  if (!submit) throw new Error("协同结构操作不可用。");
  let result = await submit.call(collaboration, batch);
  if (result.status === "conflict" && result.code === "stale-structure-revision") {
    result = await submit.call(collaboration, batch, result.revision);
  }
  return result;
}

function removeSlashTrigger(
  controller: NonNullable<ReturnType<typeof useEditorInstance>["controller"]>,
  trigger: SlashTrigger,
  reportError: ((error: Error) => void) | undefined,
): void {
  const range = findSlashTriggerRange(controller, trigger);
  if (!range) {
    reportError?.(new Error("任务结构已提交，但无法定位原斜线命令文字。"));
    return;
  }
  if (
    controller.editor.state.doc.textBetween(range.from, range.to, "", "\uFFFC") !== trigger.text
  ) {
    reportError?.(new Error("任务结构已提交，但斜线命令文字已被其他编辑修改。"));
    return;
  }
  if (!deleteSlashTrigger(controller, range)) {
    reportError?.(new Error("任务结构已提交，但无法删除斜线命令文字。"));
  }
}

function findSlashTriggerRange(
  controller: NonNullable<ReturnType<typeof useEditorInstance>["controller"]>,
  trigger: SlashTrigger,
): { from: number; to: number } | null {
  const candidates: { from: number; to: number }[] = [];
  const visit = (
    node: typeof controller.editor.state.doc,
    position: number,
    blockId?: string,
  ): void => {
    const currentBlockId = typeof node.attrs.blockId === "string" ? node.attrs.blockId : blockId;
    if (node.isText) {
      const index = (node.text ?? "").indexOf(trigger.text);
      if (currentBlockId === trigger.blockId && index >= 0) {
        candidates.push({
          from: position + index,
          to: position + index + trigger.text.length,
        });
      }
      return;
    }
    node.forEach((child, offset) => visit(child, position + 1 + offset, currentBlockId));
  };
  visit(controller.editor.state.doc, -1);
  return (
    candidates.sort(
      (left, right) => Math.abs(left.from - trigger.from) - Math.abs(right.from - trigger.from),
    )[0] ?? null
  );
}
