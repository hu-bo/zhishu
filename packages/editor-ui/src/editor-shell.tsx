import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import {
  EditorSurface,
  useEditorHost,
  useEditorCollaborationPresences,
  useEditorCollaborationStatus,
} from "@zhishu/editor-react";
import { EditorBlockMenu, type EditorBlockMenuMessages } from "./editor-block-menu.js";
import { EditorLinkEditor, type EditorLinkEditorMessages } from "./editor-link-editor.js";
import { EditorOutline } from "./editor-outline.js";
import { EditorFindPanel, type EditorFindPanelMessages } from "./editor-find-panel.js";
import { EditorSelectionMenu, type EditorSelectionMenuMessages } from "./editor-selection-menu.js";
import { EditorSlashMenu, type EditorSlashMenuMessages } from "./editor-slash-menu.js";
import { EditorToolbar, type EditorToolbarMessages } from "./editor-toolbar.js";
import { EditorCollaborationIndicator } from "./editor-collaboration-indicator.js";
import { EditorCollaborationParticipants } from "./editor-collaboration-participants.js";

export interface EditorShellMessages {
  collapseOutline: string;
  expandOutline: string;
}

export interface EditorShellProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "title"> {
  ariaLabel: string;
  surfaceLabel?: string;
  surfaceClassName?: string;
  title?: ReactNode;
  headerSlot?: ReactNode;
  footerSlot?: ReactNode;
  toolbar?: ReactNode;
  collaborationIndicator?: boolean;
  collaborationParticipants?: boolean;
  toolbarMessages?: Partial<EditorToolbarMessages>;
  outline?: boolean;
  outlineLabel?: string;
  outlineEmptyLabel?: string;
  outlineUntitledLabel?: string;
  find?: boolean;
  findMessages?: Partial<EditorFindPanelMessages>;
  shellMessages?: Partial<EditorShellMessages>;
  selectionMenu?: boolean;
  selectionMenuMessages?: Partial<EditorSelectionMenuMessages>;
  blockMenu?: boolean;
  blockMenuMessages?: Partial<EditorBlockMenuMessages>;
  linkEditor?: boolean;
  linkEditorMessages?: Partial<EditorLinkEditorMessages>;
  slashMenu?: boolean;
  slashCapabilities?: readonly string[];
  slashMenuMessages?: Partial<EditorSlashMenuMessages>;
}

export function EditorShell({
  ariaLabel,
  surfaceLabel = ariaLabel,
  surfaceClassName,
  title,
  headerSlot,
  footerSlot,
  toolbar,
  collaborationIndicator = true,
  collaborationParticipants = true,
  toolbarMessages,
  outline = false,
  outlineLabel = "文档大纲",
  outlineEmptyLabel,
  outlineUntitledLabel,
  find = false,
  findMessages,
  shellMessages,
  selectionMenu = false,
  selectionMenuMessages,
  blockMenu = false,
  blockMenuMessages,
  linkEditor = false,
  linkEditorMessages,
  slashMenu = false,
  slashCapabilities,
  slashMenuMessages,
  className,
  ...props
}: EditorShellProps) {
  const outlineId = useId();
  const shellRef = useRef<HTMLElement | null>(null);
  const { resolveAssetURL } = useEditorHost();
  const collaborationStatus = useEditorCollaborationStatus();
  const collaborationPresences = useEditorCollaborationPresences();
  const showParticipants = collaborationParticipants && collaborationPresences.length > 0;
  const [outlineVisible, setOutlineVisible] = useState(true);
  const labels: EditorShellMessages = {
    collapseOutline: "收起大纲",
    expandOutline: "显示大纲",
    ...shellMessages,
  };

  useEffect(() => {
    if (!resolveAssetURL) return;
    const shell = shellRef.current;
    if (!shell) return;
    let active = true;
    const requests = new Map<HTMLImageElement, AbortController>();
    const resolveImages = () => {
      for (const image of shell.querySelectorAll<HTMLImageElement>(
        ".ProseMirror img[data-asset-id]",
      )) {
        const assetId = image.dataset.assetId;
        if (!assetId || image.dataset.resolvedAssetId === assetId) continue;
        if (image.dataset.failedAssetId === assetId) continue;
        requests.get(image)?.abort();
        const request = new AbortController();
        requests.set(image, request);
        void resolveAssetURL(assetId, request.signal)
          .then((url) => {
            if (!active || request.signal.aborted || image.dataset.assetId !== assetId) return;
            image.src = url;
            image.dataset.resolvedAssetId = assetId;
          })
          .catch(() => {
            if (!active || request.signal.aborted || image.dataset.assetId !== assetId) return;
            image.dataset.failedAssetId = assetId;
          })
          .finally(() => {
            if (requests.get(image) === request) requests.delete(image);
          });
      }
    };
    const observer = new MutationObserver(resolveImages);
    observer.observe(shell, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-asset-id"],
    });
    resolveImages();
    return () => {
      active = false;
      observer.disconnect();
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, [resolveAssetURL]);

  return (
    <section
      ref={shellRef}
      {...props}
      className={className ? `zhishu-ui-shell ${className}` : "zhishu-ui-shell"}
      aria-label={ariaLabel}
    >
      {(title ||
        headerSlot ||
        (collaborationIndicator && collaborationStatus) ||
        showParticipants ||
        outline) && (
        <header className="zhishu-ui-header">
          {title && <div className="zhishu-ui-title">{title}</div>}
          {headerSlot}
          {showParticipants && (
            <EditorCollaborationParticipants participants={collaborationPresences} />
          )}
          {collaborationIndicator && collaborationStatus && (
            <EditorCollaborationIndicator
              status={collaborationStatus}
              className="zhishu-ui-collaboration-status"
            />
          )}
          {outline && (
            <button
              type="button"
              className="zhishu-ui-outline-toggle"
              aria-controls={outlineId}
              aria-expanded={outlineVisible}
              onClick={() => setOutlineVisible((visible) => !visible)}
            >
              {outlineVisible ? labels.collapseOutline : labels.expandOutline}
            </button>
          )}
        </header>
      )}
      <div className="zhishu-ui-toolbar-row">
        {toolbar ?? <EditorToolbar messages={toolbarMessages} />}
        {find && <EditorFindPanel messages={findMessages} />}
        {linkEditor && <EditorLinkEditor messages={linkEditorMessages} />}
      </div>
      <div className={outline ? "zhishu-ui-body zhishu-ui-with-outline" : "zhishu-ui-body"}>
        {outline && (
          <EditorOutline
            id={outlineId}
            label={outlineLabel}
            emptyLabel={outlineEmptyLabel}
            untitledLabel={outlineUntitledLabel}
            className={outlineVisible ? undefined : "is-collapsed"}
          />
        )}
        <EditorSurface
          ariaLabel={surfaceLabel}
          className={
            surfaceClassName ? `zhishu-ui-surface ${surfaceClassName}` : "zhishu-ui-surface"
          }
        />
      </div>
      {footerSlot && <footer className="zhishu-ui-footer">{footerSlot}</footer>}
      {selectionMenu && <EditorSelectionMenu messages={selectionMenuMessages} />}
      {blockMenu && <EditorBlockMenu messages={blockMenuMessages} />}
      {slashMenu && (
        <EditorSlashMenu capabilities={slashCapabilities} messages={slashMenuMessages} />
      )}
    </section>
  );
}
