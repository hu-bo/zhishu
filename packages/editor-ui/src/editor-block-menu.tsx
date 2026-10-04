import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EditorStructureAction } from "@zhishu/editor-core";
import { useEditorEvents, useEditorInstance, useEditorSelector } from "@zhishu/editor-react";
import { EditorIcon } from "./editor-icon.js";

interface BlockMenuTarget {
  id: string;
  type: string;
  x: number;
  y: number;
}

type BlockMenuActionId =
  "duplicate" | "delete" | "paragraph" | "heading" | "code" | "move-up" | "move-down";

export interface EditorBlockMenuMessages {
  handleLabel: string;
  menuLabel: string;
  blockActionsGroup: string;
  blockTypeGroup: string;
  blockPositionGroup: string;
  duplicate: string;
  delete: string;
  paragraph: string;
  heading: string;
  code: string;
  moveUp: string;
  moveDown: string;
  changed: string;
  unavailable: string;
  submitting: string;
  structureUnavailable: string;
  completed: string;
}

const defaultMessages: EditorBlockMenuMessages = {
  handleLabel: "Block 操作",
  menuLabel: "Block 操作菜单",
  blockActionsGroup: "块操作",
  blockTypeGroup: "转换类型",
  blockPositionGroup: "调整位置",
  duplicate: "复制 Block",
  delete: "删除 Block",
  paragraph: "转为段落",
  heading: "转为二级标题",
  code: "转为代码块",
  moveUp: "上移",
  moveDown: "下移",
  changed: "当前 Block 已变化或不可编辑",
  unavailable: "此操作在当前结构中不可用",
  submitting: "正在提交协同结构操作…",
  structureUnavailable: "协同编辑期间暂不支持 Block 结构操作",
  completed: "操作完成",
};

export interface EditorBlockMenuProps {
  messages?: Partial<EditorBlockMenuMessages>;
  className?: string;
}

export function EditorBlockMenu({ messages, className }: EditorBlockMenuProps) {
  const { controller, collaboration } = useEditorInstance();
  const editable = useEditorSelector((state) => state.isEditable);
  const labels = { ...defaultMessages, ...messages };
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<BlockMenuTarget | null>(null);
  const activatedRef = useRef(false);
  const menuId = useId();
  const [target, setTarget] = useState<BlockMenuTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const actionLabels: Record<BlockMenuActionId, string> = {
    duplicate: labels.duplicate,
    delete: labels.delete,
    paragraph: labels.paragraph,
    heading: labels.heading,
    code: labels.code,
    "move-up": labels.moveUp,
    "move-down": labels.moveDown,
  };

  const refreshTarget = () => {
    if (!controller || controller.isDestroyed || !controller.isEditable || !activatedRef.current) {
      targetRef.current = null;
      setTarget(null);
      setMenuOpen(false);
      return;
    }

    const { selection } = controller.editor.state;
    let blockId: string | undefined;
    const selectedNode = (
      selection as typeof selection & {
        node?: { attrs: Record<string, unknown>; type: { name: string } };
      }
    ).node;
    const selectedTable = selectedNode?.type.name === "table";
    if (!selectedTable && isInsideTable(selection.$from)) {
      targetRef.current = null;
      setTarget(null);
      setMenuOpen(false);
      return;
    }
    if (selectedNode && typeof selectedNode.attrs.blockId === "string") {
      blockId = selectedNode.attrs.blockId;
    }

    for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
      const node = selection.$from.node(depth);
      const id = node.attrs.blockId;
      if (typeof id !== "string") continue;
      if (node.type.name === "listItem") {
        blockId = id;
        break;
      }
      blockId ??= id;
    }

    const block = blockId ? controller.findBlock(blockId) : undefined;
    if (!block) {
      targetRef.current = null;
      setTarget(null);
      setMenuOpen(false);
      return;
    }

    const dom = controller.editor.view.nodeDOM(block.position);
    if (!(dom instanceof HTMLElement) || !dom.isConnected) {
      targetRef.current = null;
      setTarget(null);
      setMenuOpen(false);
      return;
    }
    const rect = dom.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      targetRef.current = null;
      setTarget(null);
      setMenuOpen(false);
      return;
    }
    const x = Math.max(8, Math.min(window.innerWidth - 52, rect.left - 52));
    const y = Math.max(8, Math.min(window.innerHeight - 44, rect.top + 2));
    const next = { id: block.id, type: block.type, x, y };
    if (targetRef.current?.id !== next.id) setMenuOpen(false);
    targetRef.current = next;
    setTarget(next);
  };

  useEditorEvents((event) => {
    if (event.docChanged || event.selectionChanged) requestAnimationFrame(refreshTarget);
  });

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    const editorDom = controller.editor.view.dom;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshTarget);
    };
    const onFocusIn = () => {
      activatedRef.current = true;
      schedule();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.target instanceof Node && editorDom.contains(event.target)) {
        activatedRef.current = true;
        schedule();
      }
    };
    editorDom.addEventListener("focusin", onFocusIn);
    editorDom.addEventListener("pointerup", onPointerUp);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      editorDom.removeEventListener("focusin", onFocusIn);
      editorDom.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [controller]);

  const location = (() => {
    if (!controller || !target) return undefined;
    const block = controller.findBlock(target.id);
    if (!block) return undefined;
    const $position = controller.editor.state.doc.resolve(block.position);
    const parent = $position.parent;
    const index = $position.index();
    const parentBlockId = parent.type.name === "doc" ? null : parent.attrs.blockId;
    if (parentBlockId !== null && typeof parentBlockId !== "string") return undefined;
    const idAt = (offset: number) => {
      const sibling = parent.maybeChild(offset);
      const id = sibling?.attrs.blockId;
      return typeof id === "string" ? id : undefined;
    };
    return {
      parentBlockId,
      previousId: index > 0 ? idAt(index - 1) : undefined,
      nextId: index + 1 < parent.childCount ? idAt(index + 1) : undefined,
    };
  })();
  const collaborationStatus = collaboration?.getStatus();
  const canSubmitCollaborativeStructure =
    collaboration?.readOnly === false &&
    collaborationStatus?.connection === "connected" &&
    collaborationStatus.sync === "current" &&
    typeof collaboration.submitStructureOperation === "function";
  const structureAllowed =
    (controller?.canExecute("block-structure").allowed ?? false) || canSubmitCollaborativeStructure;

  const actions: Array<{ id: BlockMenuActionId; disabled: boolean }> = [
    { id: "duplicate", disabled: !editable || !structureAllowed || busy },
    { id: "delete", disabled: !editable || !structureAllowed || busy },
    {
      id: "paragraph",
      disabled:
        !editable ||
        !structureAllowed ||
        busy ||
        !["paragraph", "heading", "codeBlock"].includes(target?.type ?? ""),
    },
    {
      id: "heading",
      disabled:
        !editable ||
        !structureAllowed ||
        busy ||
        !["paragraph", "heading", "codeBlock"].includes(target?.type ?? ""),
    },
    {
      id: "code",
      disabled:
        !editable ||
        !structureAllowed ||
        busy ||
        !["paragraph", "heading", "codeBlock"].includes(target?.type ?? ""),
    },
    { id: "move-up", disabled: !editable || !structureAllowed || busy || !location?.previousId },
    { id: "move-down", disabled: !editable || !structureAllowed || busy || !location?.nextId },
  ];
  const actionGroups: Array<{
    id: string;
    label: string;
    actionIds: BlockMenuActionId[];
  }> = [
    { id: "block-actions", label: labels.blockActionsGroup, actionIds: ["duplicate", "delete"] },
    {
      id: "block-type",
      label: labels.blockTypeGroup,
      actionIds: ["paragraph", "heading", "code"],
    },
    {
      id: "block-position",
      label: labels.blockPositionGroup,
      actionIds: ["move-up", "move-down"],
    },
  ];

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen || !target || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const left =
      target.x + 52 + rect.width <= window.innerWidth - 8
        ? target.x + 52
        : Math.max(8, target.x - rect.width - 8);
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, target.y));
    menuRef.current.style.left = `${left}px`;
    menuRef.current.style.top = `${top}px`;
  }, [menuOpen, target]);

  if (!target || !editable || !controller || controller.isDestroyed) return null;

  const execute = async (actionId: BlockMenuActionId) => {
    const block = controller.findBlock(target.id);
    if (!block || !controller.canExecute("write").allowed) {
      setStatus(labels.changed);
      return;
    }

    if (canSubmitCollaborativeStructure && collaboration?.submitStructureOperation) {
      let action: EditorStructureAction | undefined;
      if (actionId === "duplicate") action = { type: "duplicate-block", targetBlockId: target.id };
      else if (actionId === "delete") action = { type: "delete-block", targetBlockId: target.id };
      else if (actionId === "paragraph") {
        action = { type: "change-block-type", targetBlockId: target.id, blockType: "paragraph" };
      } else if (actionId === "heading") {
        action = {
          type: "change-block-type",
          targetBlockId: target.id,
          blockType: "heading",
          options: { level: 2 },
        };
      } else if (actionId === "code") {
        action = { type: "change-block-type", targetBlockId: target.id, blockType: "codeBlock" };
      } else if (location?.parentBlockId !== undefined) {
        if (actionId === "move-up" && location.previousId) {
          action = {
            type: "move-block",
            targetBlockId: target.id,
            parentBlockId: location.parentBlockId,
            position: { beforeBlockId: location.previousId },
          };
        } else if (actionId === "move-down" && location.nextId) {
          action = {
            type: "move-block",
            targetBlockId: target.id,
            parentBlockId: location.parentBlockId,
            position: { afterBlockId: location.nextId },
          };
        }
      }
      if (!action) {
        setStatus(labels.unavailable);
        return;
      }
      const prepared = controller.prepareStructureAction(action);
      if (!prepared.success) {
        setStatus(labels.unavailable);
        return;
      }
      setBusy(true);
      setStatus(labels.submitting);
      try {
        const receipt = await collaboration.submitStructureOperation(prepared.batch);
        if (receipt.status === "conflict") {
          setStatus(labels.changed);
          return;
        }
        if (receipt.status === "rejected") {
          setStatus(labels.unavailable);
          return;
        }
        const focusId = actionId === "duplicate" ? prepared.result.createdBlockIds[0] : target.id;
        setStatus(`${labels.completed}：${actionLabels[actionId]}`);
        setMenuOpen(false);
        requestAnimationFrame(() => {
          if (!controller.isDestroyed && focusId && controller.findBlock(focusId)) {
            controller.focusBlock(focusId);
          } else if (!controller.isDestroyed) {
            controller.editor.commands.focus();
          }
          refreshTarget();
        });
      } catch {
        setStatus(labels.unavailable);
      } finally {
        setBusy(false);
      }
      return;
    }

    let result:
      | ReturnType<typeof controller.duplicateBlock>
      | ReturnType<typeof controller.deleteBlock>
      | ReturnType<typeof controller.changeBlockType>
      | ReturnType<typeof controller.moveBlock>
      | undefined;

    if (actionId === "duplicate") result = controller.duplicateBlock(target.id);
    else if (actionId === "delete") result = controller.deleteBlock(target.id);
    else if (actionId === "paragraph") result = controller.changeBlockType(target.id, "paragraph");
    else if (actionId === "heading") {
      result = controller.changeBlockType(target.id, "heading", { level: 2 });
    } else if (actionId === "code") result = controller.changeBlockType(target.id, "codeBlock");
    else if (location?.parentBlockId !== undefined) {
      if (actionId === "move-up" && location.previousId) {
        result = controller.moveBlock(target.id, location.parentBlockId, {
          beforeBlockId: location.previousId,
        });
      } else if (actionId === "move-down" && location.nextId) {
        result = controller.moveBlock(target.id, location.parentBlockId, {
          afterBlockId: location.nextId,
        });
      }
    }

    if (!result) {
      setStatus(labels.unavailable);
      return;
    }
    if (!result.success) {
      setStatus(labels.unavailable);
      return;
    }

    const focusId = actionId === "duplicate" ? result.createdBlockIds[0] : target.id;
    setStatus(`${labels.completed}：${actionLabels[actionId]}`);
    setMenuOpen(false);
    requestAnimationFrame(() => {
      if (!controller.isDestroyed && focusId && controller.findBlock(focusId)) {
        controller.focusBlock(focusId);
      } else if (!controller.isDestroyed) {
        controller.editor.commands.focus();
      }
      refreshTarget();
    });
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      handleRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[nextIndex]?.focus();
  };

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        className={className ? `zhishu-ui-block-handle ${className}` : "zhishu-ui-block-handle"}
        style={{ left: `${target.x}px`, top: `${target.y}px` }}
        aria-label={labels.handleLabel}
        title={labels.handleLabel}
        aria-controls={menuId}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <EditorIcon name="more" />
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          id={menuId}
          className="zhishu-ui-block-menu"
          style={{ left: `${target.x + 52}px`, top: `${target.y}px` }}
          role="menu"
          aria-label={labels.menuLabel}
          onKeyDown={onMenuKeyDown}
        >
          {!structureAllowed && (
            <p role="note" className="zhishu-ui-block-menu-note">
              {labels.structureUnavailable}
            </p>
          )}
          {actionGroups.map((group) => (
            <div
              key={group.id}
              className="zhishu-ui-block-menu-group"
              role="group"
              aria-label={group.label}
            >
              <p className="zhishu-ui-block-menu-group-label">{group.label}</p>
              {group.actionIds.map((actionId) => {
                const action = actions.find((item) => item.id === actionId);
                if (!action) return null;
                return (
                  <button
                    key={action.id}
                    type="button"
                    role="menuitem"
                    disabled={action.disabled}
                    data-danger={action.id === "delete" ? "true" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void execute(action.id)}
                  >
                    {actionLabels[action.id]}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <span className="zhishu-ui-visually-hidden" role="status" aria-live="polite">
        {status}
      </span>
    </>
  );
}

function isInsideTable(position: {
  depth: number;
  node(depth: number): { type: { name: string } };
}) {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    if (position.node(depth).type.name === "table") return true;
  }
  return false;
}
