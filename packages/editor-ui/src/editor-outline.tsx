import { useEffect, useRef, useState } from "react";
import type { EditorController } from "@zhishu/editor-core";
import { useEditorEvents, useEditorInstance } from "@zhishu/editor-react";
import { EditorIcon } from "./editor-icon.js";

function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.body) {
    const style = window.getComputedStyle(ancestor);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      ancestor.scrollHeight > ancestor.clientHeight
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function findHeadingElement(
  controller: EditorController,
  editorRoot: HTMLElement,
  heading: { blockId: string; position: number },
): HTMLElement | null {
  const byBlockId = Array.from(editorRoot.querySelectorAll<HTMLElement>("[data-blockid]")).find(
    (element) => element.dataset.blockid === heading.blockId,
  );
  if (byBlockId) return byBlockId;
  const node = controller.editor.view.nodeDOM(heading.position);
  return node instanceof HTMLElement ? node : (node?.parentElement ?? null);
}

function focusHeading(controller: EditorController, blockId: string) {
  const heading = controller.getOutline().find((item) => item.blockId === blockId);
  if (!heading || !controller.focusBlock(blockId, { scrollIntoView: false })) return;

  const editorRoot = controller.editor.view.dom;
  const element = findHeadingElement(controller, editorRoot, heading);
  if (!element) return;

  const revealHeading = () => {
    if (controller.isDestroyed || !element.isConnected) return;
    const scrollContainer = findScrollContainer(editorRoot);
    if (!scrollContainer) {
      element.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
      return;
    }

    const containerBounds = scrollContainer.getBoundingClientRect();
    const toolbar = editorRoot
      .closest(".zhishu-ui-shell")
      ?.querySelector<HTMLElement>(".zhishu-ui-toolbar-row");
    const toolbarBounds = toolbar?.getBoundingClientRect();
    const toolbarPinned =
      toolbarBounds &&
      toolbarBounds.top <= containerBounds.top + 1 &&
      toolbarBounds.bottom > containerBounds.top;
    const visibleTop = toolbarPinned ? toolbarBounds.bottom + 12 : containerBounds.top + 16;
    const visibleBottom = containerBounds.bottom - 16;
    const headingBounds = element.getBoundingClientRect();

    if (
      headingBounds.top < visibleTop ||
      headingBounds.bottom > visibleBottom ||
      Math.abs(headingBounds.top - visibleTop) > 16
    ) {
      scrollContainer.scrollTop += headingBounds.top - visibleTop;
    }
  };

  // ProseMirror may perform its own scrollIntoView on the next frame; run after it.
  requestAnimationFrame(() => requestAnimationFrame(revealHeading));
}

export interface EditorOutlineProps {
  label?: string;
  emptyLabel?: string;
  untitledLabel?: string;
  className?: string;
  id?: string;
  onNavigate?: (blockId: string) => void;
  onRequestClose?: () => void;
}

export function EditorOutline({
  label = "文档大纲",
  emptyLabel = "文档中暂无标题",
  untitledLabel = "无标题",
  className,
  id,
  onNavigate,
  onRequestClose,
}: EditorOutlineProps) {
  const { controller } = useEditorInstance();
  const [headings, setHeadings] = useState(() => controller?.getOutline() ?? []);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const updateActiveHeadingRef = useRef<(() => void) | null>(null);

  const updateOutline = (followSelection = true) => {
    if (!controller || controller.isDestroyed) {
      setHeadings([]);
      setActiveHeadingId(null);
      return;
    }
    const nextHeadings = controller.getOutline();
    setHeadings(nextHeadings);
    if (followSelection) {
      const position = controller.editor.state.selection.from;
      const activeHeading = [...nextHeadings]
        .reverse()
        .find((heading) => heading.position <= position);
      setActiveHeadingId(activeHeading?.blockId ?? null);
    }
  };

  useEffect(() => {
    updateOutline();
  }, [controller]);

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    const editorRoot = controller.editor.view.dom;
    const scrollContainer = findScrollContainer(editorRoot);
    const updateActiveHeading = () => {
      if (controller.isDestroyed) return;
      const currentHeadings = controller.getOutline();
      if (currentHeadings.length === 0) {
        setActiveHeadingId(null);
        return;
      }

      const containerTop = scrollContainer?.getBoundingClientRect().top ?? 0;
      const toolbar = editorRoot
        .closest(".zhishu-ui-shell")
        ?.querySelector<HTMLElement>(".zhishu-ui-toolbar-row");
      const toolbarBounds = toolbar?.getBoundingClientRect();
      const readingLine =
        toolbarBounds &&
        toolbarBounds.top <= containerTop + 1 &&
        toolbarBounds.bottom > containerTop
          ? toolbarBounds.bottom
          : containerTop + 16;
      const reachedDocumentEnd =
        scrollContainer &&
        scrollContainer.scrollTop + scrollContainer.clientHeight >=
          scrollContainer.scrollHeight - 1;
      let activeHeading = reachedDocumentEnd
        ? currentHeadings[currentHeadings.length - 1]
        : currentHeadings[0];

      if (!reachedDocumentEnd) {
        for (const heading of currentHeadings) {
          const element = findHeadingElement(controller, editorRoot, heading);
          if (element && element.getBoundingClientRect().top <= readingLine + 2) {
            activeHeading = heading;
          }
        }
      }
      setActiveHeadingId(activeHeading?.blockId ?? null);
    };

    updateActiveHeadingRef.current = updateActiveHeading;
    const scrollTarget: HTMLElement | Window = scrollContainer ?? window;
    scrollTarget.addEventListener("scroll", updateActiveHeading, { passive: true });
    window.addEventListener("resize", updateActiveHeading, { passive: true });
    updateActiveHeading();
    return () => {
      scrollTarget.removeEventListener("scroll", updateActiveHeading);
      window.removeEventListener("resize", updateActiveHeading);
      if (updateActiveHeadingRef.current === updateActiveHeading) {
        updateActiveHeadingRef.current = null;
      }
    };
  }, [controller]);

  useEditorEvents((event) => {
    if (event.docChanged || event.selectionChanged) updateOutline(event.selectionChanged);
    if (event.docChanged) updateActiveHeadingRef.current?.();
  });

  return (
    <nav
      id={id}
      className={className ? `zhishu-ui-outline ${className}` : "zhishu-ui-outline"}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !onRequestClose) return;
        event.preventDefault();
        onRequestClose();
      }}
    >
      <h2>
        <EditorIcon name="list" />
        {label}
      </h2>
      {headings.length === 0 ? (
        <p>{emptyLabel}</p>
      ) : (
        <ol>
          {headings.map((heading) => (
            <li key={heading.blockId} data-level={heading.level}>
              <button
                type="button"
                aria-current={activeHeadingId === heading.blockId ? "location" : undefined}
                title={heading.text || untitledLabel}
                onClick={() => {
                  if (controller && !controller.isDestroyed) {
                    focusHeading(controller, heading.blockId);
                    setActiveHeadingId(heading.blockId);
                    onNavigate?.(heading.blockId);
                  }
                }}
              >
                {heading.text || untitledLabel}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
