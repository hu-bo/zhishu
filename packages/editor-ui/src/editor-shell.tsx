import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  EditorSurface,
  useEditorHost,
  useEditorCollaborationPresences,
  useEditorCollaborationStatus,
  useEditorInstance,
} from "@zhishu/editor-react";
import { EditorBlockMenu, type EditorBlockMenuMessages } from "./editor-block-menu.js";
import type { EditorLinkEditorMessages } from "./editor-link-editor.js";
import { EditorOutline } from "./editor-outline.js";
import { EditorFindPanel, type EditorFindPanelMessages } from "./editor-find-panel.js";
import { EditorSelectionMenu, type EditorSelectionMenuMessages } from "./editor-selection-menu.js";
import {
  EditorImageAltEditor,
  type EditorImageAltEditorMessages,
} from "./editor-image-alt-editor.js";
import {
  EditorCodeLanguageSelector,
  type EditorCodeLanguageSelectorMessages,
} from "./editor-code-language-selector.js";
import { EditorSlashMenu, type EditorSlashMenuMessages } from "./editor-slash-menu.js";
import { EditorToolbar, type EditorToolbarMessages } from "./editor-toolbar.js";
import { EditorTableToolbar, type EditorTableToolbarMessages } from "./editor-table-toolbar.js";
import { EditorCollaborationIndicator } from "./editor-collaboration-indicator.js";
import { EditorCollaborationParticipants } from "./editor-collaboration-participants.js";
import { EditorIcon } from "./editor-icon.js";
import { EditorStatsFooter, type EditorStatsFooterMessages } from "./editor-stats-footer.js";
import { EditorKeyboardHelp, type EditorKeyboardHelpMessages } from "./editor-keyboard-help.js";
import {
  EditorReplacementReview,
  type EditorReplacementReviewProps,
} from "./editor-replacement-review.js";

export interface EditorShellMessages {
  collapseOutline: string;
  expandOutline: string;
  openFind: string;
  closeFind: string;
  assetLoading: string;
  assetFailed: string;
  assetUnavailable: string;
}

export interface EditorShellProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "title"> {
  ariaLabel: string;
  surfaceLabel?: string;
  surfaceClassName?: string;
  compact?: boolean;
  contentMaxWidth?: string | number;
  stickyToolbar?: boolean;
  toolbarOffset?: string;
  title?: ReactNode;
  headerSlot?: ReactNode;
  showHeader?: boolean;
  footerSlot?: ReactNode;
  footerTrailingSlot?: ReactNode;
  statisticsFooter?: boolean;
  replacementReview?: EditorReplacementReviewProps;
  statisticsMessages?: Partial<EditorStatsFooterMessages>;
  keyboardHelp?: boolean;
  keyboardHelpMessages?: Partial<EditorKeyboardHelpMessages>;
  toolbar?: ReactNode;
  editingControls?: boolean;
  collaborationIndicator?: boolean;
  collaborationParticipants?: boolean;
  collaborationParticipantsCount?: boolean;
  toolbarMessages?: Partial<EditorToolbarMessages>;
  tableToolbar?: boolean;
  tableToolbarMessages?: Partial<EditorTableToolbarMessages>;
  outline?: boolean;
  outlinePlacement?: "start" | "end";
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
  imageAltEditorMessages?: Partial<EditorImageAltEditorMessages>;
  codeLanguageMessages?: Partial<EditorCodeLanguageSelectorMessages>;
  slashMenu?: boolean;
  slashCapabilities?: readonly string[];
  slashMenuMessages?: Partial<EditorSlashMenuMessages>;
}

export function EditorShell({
  ariaLabel,
  surfaceLabel = ariaLabel,
  surfaceClassName,
  compact = false,
  contentMaxWidth,
  stickyToolbar = false,
  toolbarOffset,
  title,
  headerSlot,
  showHeader = true,
  footerSlot,
  footerTrailingSlot,
  statisticsFooter = false,
  replacementReview,
  statisticsMessages,
  keyboardHelp,
  keyboardHelpMessages,
  toolbar,
  editingControls = true,
  collaborationIndicator = true,
  collaborationParticipants = true,
  collaborationParticipantsCount = true,
  toolbarMessages,
  tableToolbar = true,
  tableToolbarMessages,
  outline = false,
  outlinePlacement = "start",
  outlineLabel = "文档大纲",
  outlineEmptyLabel,
  outlineUntitledLabel,
  find = false,
  findMessages,
  shellMessages,
  style,
  selectionMenu = false,
  selectionMenuMessages,
  blockMenu = false,
  blockMenuMessages,
  linkEditor = false,
  linkEditorMessages,
  imageAltEditorMessages,
  codeLanguageMessages,
  slashMenu = false,
  slashCapabilities,
  slashMenuMessages,
  className,
  ...props
}: EditorShellProps) {
  const outlineId = useId();
  const findPanelId = useId();
  const shellRef = useRef<HTMLElement | null>(null);
  const findToggleRef = useRef<HTMLButtonElement | null>(null);
  const outlineToggleRef = useRef<HTMLButtonElement | null>(null);
  const { resolveAssetURL } = useEditorHost();
  const collaborationStatus = useEditorCollaborationStatus();
  const collaborationPresences = useEditorCollaborationPresences();
  const { controller } = useEditorInstance();
  const showParticipants = collaborationParticipants && collaborationPresences.length > 0;
  const [outlineVisible, setOutlineVisible] = useState(false);
  const [findVisible, setFindVisible] = useState(false);
  const [linkOpenRequest, setLinkOpenRequest] = useState(0);
  const requestOpenLink = () => setLinkOpenRequest((request) => request + 1);
  const [slashOpenRequest, setSlashOpenRequest] = useState<{
    request: number;
    selection: { from: number; to: number } | null;
  }>({ request: 0, selection: null });
  const requestOpenSlashMenu = (selection: { from: number; to: number } | null) => {
    setSlashOpenRequest((current) => ({ request: current.request + 1, selection }));
  };
  const labels: EditorShellMessages = {
    collapseOutline: "收起大纲",
    expandOutline: "显示大纲",
    openFind: "查找正文",
    closeFind: "关闭正文查找",
    assetLoading: "正在加载附件",
    assetFailed: "附件无法加载",
    assetUnavailable: "附件预览不可用",
    ...shellMessages,
  };
  const shellStyle = {
    ...style,
    ...(contentMaxWidth !== undefined
      ? {
          "--zhishu-ui-content-max-width":
            typeof contentMaxWidth === "number" ? `${contentMaxWidth}px` : contentMaxWidth,
        }
      : {}),
    ...(toolbarOffset !== undefined ? { "--zhishu-ui-toolbar-offset": toolbarOffset } : {}),
  } as CSSProperties;
  const outlineClassName = [
    outlineVisible ? "" : "is-collapsed",
    "is-floating",
    outlinePlacement === "end" ? "is-end" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const outlineElement = outline ? (
    <EditorOutline
      id={outlineId}
      label={outlineLabel}
      emptyLabel={outlineEmptyLabel}
      untitledLabel={outlineUntitledLabel}
      className={outlineClassName || undefined}
      onNavigate={() => setOutlineVisible(false)}
      onRequestClose={() => {
        setOutlineVisible(false);
        requestAnimationFrame(() => outlineToggleRef.current?.focus({ preventScroll: true }));
      }}
    />
  ) : null;
  const surfaceElement = (
    <EditorSurface
      ariaLabel={surfaceLabel}
      className={surfaceClassName ? `zhishu-ui-surface ${surfaceClassName}` : "zhishu-ui-surface"}
    />
  );
  const outlineToggle = outline ? (
    <button
      ref={outlineToggleRef}
      type="button"
      className="zhishu-ui-outline-toggle"
      aria-controls={outlineId}
      aria-expanded={outlineVisible}
      aria-label={outlineVisible ? labels.collapseOutline : labels.expandOutline}
      title={outlineVisible ? labels.collapseOutline : labels.expandOutline}
      onClick={() => setOutlineVisible((visible) => !visible)}
    >
      <EditorIcon name={outlineVisible ? "panel-left-close" : "panel-left-open"} />
      <span className="zhishu-ui-visually-hidden">
        {outlineVisible ? labels.collapseOutline : labels.expandOutline}
      </span>
    </button>
  ) : null;
  const showHeaderOutlineToggle = outline && (!editingControls || Boolean(toolbar));

  useEffect(() => {
    if (!outline || !outlineVisible) return;
    const closeWhenOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(".zhishu-ui-outline") || target.closest(".zhishu-ui-outline-toggle"))
      ) {
        return;
      }
      setOutlineVisible(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside, true);
    return () => document.removeEventListener("pointerdown", closeWhenOutside, true);
  }, [outline, outlineVisible]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !controller || !editingControls || !linkEditor) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[contenteditable="true"]') || controller.editor.state.selection.empty)
        return;
      event.preventDefault();
      event.stopPropagation();
      setLinkOpenRequest((request) => request + 1);
    };
    shell.addEventListener("keydown", keydown);
    return () => shell.removeEventListener("keydown", keydown);
  }, [controller, editingControls, linkEditor]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let active = true;
    const requests = new Map<HTMLElement, AbortController>();
    const updateResourceState = (
      element: HTMLElement,
      state: "loading" | "ready" | "failed" | "unavailable",
    ) => {
      const isImage = element instanceof HTMLImageElement;
      const stateMessage =
        state === "loading"
          ? labels.assetLoading
          : state === "failed"
            ? labels.assetFailed
            : state === "unavailable"
              ? labels.assetUnavailable
              : "";
      element.dataset.assetState = state;
      if (isImage) {
        const figure = element.closest<HTMLElement>("figure[data-asset-id]");
        if (figure) figure.dataset.assetState = state;
        if (state === "ready") element.removeAttribute("aria-description");
        else element.setAttribute("aria-description", stateMessage);
      } else if (element instanceof HTMLAnchorElement) {
        const originalLabel =
          element.dataset.originalAriaLabel ??
          element.getAttribute("aria-label") ??
          `PDF 附件：${element.dataset.fileName ?? element.textContent ?? "document.pdf"}`;
        element.dataset.originalAriaLabel = originalLabel;
        element.setAttribute(
          "aria-label",
          state === "ready" ? originalLabel : `${originalLabel} · ${stateMessage}`,
        );
      }
    };
    const clearResourceState = (element: HTMLElement) => {
      const isImage = element instanceof HTMLImageElement;
      delete element.dataset.assetState;
      delete element.dataset.assetStateId;
      delete element.dataset.loadingAssetId;
      delete element.dataset.unavailableAssetId;
      delete element.dataset.resolvedAssetId;
      delete element.dataset.failedAssetId;
      if (isImage) {
        element.removeAttribute("aria-description");
        const figure = element.closest<HTMLElement>("figure[data-asset-id]");
        if (figure) delete figure.dataset.assetState;
      } else if (element instanceof HTMLAnchorElement && element.dataset.originalAriaLabel) {
        element.setAttribute("aria-label", element.dataset.originalAriaLabel);
      }
    };
    const resolveAssets = () => {
      for (const [element, request] of requests) {
        if (!shell.contains(element)) {
          request.abort();
          requests.delete(element);
        }
      }
      const elements = shell.querySelectorAll<HTMLElement>(
        ".ProseMirror img[data-asset-id], .ProseMirror a[data-pdf-asset-id]",
      );
      for (const element of elements) {
        const assetId = element.dataset.assetId ?? element.dataset.pdfAssetId;
        if (!assetId) continue;
        if (element.dataset.assetStateId && element.dataset.assetStateId !== assetId) {
          requests.get(element)?.abort();
          requests.delete(element);
          if (element instanceof HTMLImageElement) element.removeAttribute("src");
          else if (element instanceof HTMLAnchorElement) element.removeAttribute("href");
          clearResourceState(element);
        }
        element.dataset.assetStateId = assetId;
        if (!resolveAssetURL) {
          requests.get(element)?.abort();
          requests.delete(element);
          if (element instanceof HTMLImageElement) element.removeAttribute("src");
          else if (element instanceof HTMLAnchorElement) element.removeAttribute("href");
          delete element.dataset.resolvedAssetId;
          delete element.dataset.failedAssetId;
          delete element.dataset.loadingAssetId;
          if (element.dataset.unavailableAssetId !== assetId) {
            element.dataset.unavailableAssetId = assetId;
            updateResourceState(element, "unavailable");
          }
          continue;
        }
        if (element.dataset.resolvedAssetId === assetId) continue;
        if (element.dataset.failedAssetId === assetId) continue;
        if (element.dataset.loadingAssetId === assetId) continue;
        requests.get(element)?.abort();
        const request = new AbortController();
        requests.set(element, request);
        element.dataset.loadingAssetId = assetId;
        updateResourceState(element, "loading");
        void resolveAssetURL(assetId, request.signal)
          .then((url) => {
            if (!active || request.signal.aborted) return;
            if ((element.dataset.assetId ?? element.dataset.pdfAssetId) !== assetId) return;
            if (element instanceof HTMLImageElement) element.src = url;
            else if (element instanceof HTMLAnchorElement) element.href = url;
            element.dataset.resolvedAssetId = assetId;
            delete element.dataset.unavailableAssetId;
            if (element instanceof HTMLImageElement) {
              // Keep the placeholder until the browser confirms that the image itself loaded.
              updateResourceState(element, "loading");
            } else {
              delete element.dataset.loadingAssetId;
              updateResourceState(element, "ready");
            }
          })
          .catch(() => {
            if (!active || request.signal.aborted) return;
            if ((element.dataset.assetId ?? element.dataset.pdfAssetId) !== assetId) return;
            element.dataset.failedAssetId = assetId;
            delete element.dataset.loadingAssetId;
            updateResourceState(element, "failed");
          })
          .finally(() => {
            if (requests.get(element) === request) requests.delete(element);
          });
      }
    };
    const onImageLoad = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !shell.contains(image)) return;
      const assetId = image.dataset.assetId;
      if (!assetId || image.dataset.resolvedAssetId !== assetId) return;
      delete image.dataset.loadingAssetId;
      delete image.dataset.failedAssetId;
      updateResourceState(image, "ready");
    };
    const onImageError = (event: Event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !shell.contains(image)) return;
      const assetId = image.dataset.assetId;
      if (!assetId || image.dataset.resolvedAssetId !== assetId) return;
      delete image.dataset.loadingAssetId;
      image.dataset.failedAssetId = assetId;
      updateResourceState(image, "failed");
    };
    const observer = new MutationObserver(resolveAssets);
    observer.observe(shell, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-asset-id", "data-pdf-asset-id"],
    });
    shell.addEventListener("load", onImageLoad, true);
    shell.addEventListener("error", onImageError, true);
    resolveAssets();
    return () => {
      active = false;
      observer.disconnect();
      shell.removeEventListener("load", onImageLoad, true);
      shell.removeEventListener("error", onImageError, true);
      for (const request of requests.values()) request.abort();
      requests.clear();
    };
  }, [labels.assetFailed, labels.assetLoading, labels.assetUnavailable, resolveAssetURL]);

  const keyboardHelpControl =
    editingControls && (keyboardHelp ?? statisticsFooter) ? (
      <EditorKeyboardHelp messages={keyboardHelpMessages} />
    ) : null;

  return (
    <section
      ref={shellRef}
      {...props}
      className={[
        "zhishu-ui-shell",
        compact ? "is-compact" : "",
        stickyToolbar ? "is-toolbar-sticky" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={shellStyle}
      aria-label={ariaLabel}
    >
      {showHeader &&
        (title ||
          headerSlot ||
          (collaborationIndicator && collaborationStatus) ||
          showParticipants ||
          showHeaderOutlineToggle) && (
          <header className="zhishu-ui-header">
            {title && <div className="zhishu-ui-title">{title}</div>}
            {headerSlot}
            {showParticipants && (
              <EditorCollaborationParticipants
                participants={collaborationPresences}
                showCount={collaborationParticipantsCount}
              />
            )}
            {collaborationIndicator && collaborationStatus && (
              <EditorCollaborationIndicator
                status={collaborationStatus}
                className="zhishu-ui-collaboration-status"
              />
            )}
            {showHeaderOutlineToggle && outlineToggle}
          </header>
        )}
      <div className={stickyToolbar ? "zhishu-ui-toolbar-row is-sticky" : "zhishu-ui-toolbar-row"}>
        {editingControls &&
          (toolbar ?? (
            <EditorToolbar
              messages={toolbarMessages}
              onOpenCommandMenu={slashMenu ? requestOpenSlashMenu : undefined}
              outlineToggle={outlineToggle}
              linkEditorOpenRequest={linkEditor ? linkOpenRequest : undefined}
              linkEditorMessages={linkEditorMessages}
            />
          ))}
        {editingControls && tableToolbar && <EditorTableToolbar messages={tableToolbarMessages} />}
        {!editingControls && !showHeader && outlineToggle}
        {find && (
          <>
            <button
              ref={findToggleRef}
              type="button"
              className="zhishu-ui-find-toggle"
              aria-label={findVisible ? labels.closeFind : labels.openFind}
              aria-controls={findPanelId}
              aria-expanded={findVisible}
              title={findVisible ? labels.closeFind : labels.openFind}
              onClick={() => setFindVisible((visible) => !visible)}
            >
              <EditorIcon name="search" />
              <span className="zhishu-ui-visually-hidden">
                {findVisible ? labels.closeFind : labels.openFind}
              </span>
            </button>
            <EditorFindPanel
              id={findPanelId}
              hidden={!findVisible}
              autoFocus={findVisible}
              onClose={() => {
                setFindVisible(false);
                findToggleRef.current?.focus({ preventScroll: true });
              }}
              messages={findMessages}
            />
          </>
        )}
      </div>
      {editingControls && <EditorImageAltEditor messages={imageAltEditorMessages} />}
      {editingControls && <EditorCodeLanguageSelector messages={codeLanguageMessages} />}
      <div className={outline ? "zhishu-ui-body zhishu-ui-with-outline" : "zhishu-ui-body"}>
        {surfaceElement}
        {outlineElement}
      </div>
      {replacementReview && <EditorReplacementReview {...replacementReview} />}
      {(statisticsFooter || footerSlot || footerTrailingSlot || keyboardHelpControl) && (
        <footer className="zhishu-ui-footer">
          {statisticsFooter ? (
            <EditorStatsFooter
              messages={statisticsMessages}
              trailingSlot={
                <div className="zhishu-ui-footer-tools">
                  {keyboardHelpControl}
                  {footerTrailingSlot}
                </div>
              }
            />
          ) : (
            <div className="zhishu-ui-footer-tools">
              {keyboardHelpControl}
              {footerTrailingSlot}
            </div>
          )}
          {footerSlot}
        </footer>
      )}
      {editingControls && selectionMenu && (
        <EditorSelectionMenu
          messages={selectionMenuMessages}
          onOpenLink={linkEditor ? requestOpenLink : undefined}
        />
      )}
      {editingControls && blockMenu && <EditorBlockMenu messages={blockMenuMessages} />}
      {editingControls && slashMenu && (
        <EditorSlashMenu
          capabilities={slashCapabilities}
          messages={slashMenuMessages}
          openRequest={slashOpenRequest.request}
          openSelection={slashOpenRequest.selection}
        />
      )}
    </section>
  );
}
