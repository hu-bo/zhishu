import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HighlightColor } from "@zhishu/editor-core";
import { useEditorInstance } from "@zhishu/editor-react";
import { useEditorSelector } from "@zhishu/editor-react";
import type { EditorAIAction, EditorHostServices, EditorTextSelection } from "@zhishu/editor-react";
import { EditorIcon, type EditorIconName } from "./editor-icon.js";
import { EditorLinkEditor, type EditorLinkEditorMessages } from "./editor-link-editor.js";

export interface EditorToolbarMessages {
  label: string;
  formattingGroup: string;
  historyGroup: string;
  attachmentsGroup: string;
  uploadRecoveryGroup: string;
  alignmentGroup?: string;
  insertGroup?: string;
  comments?: string;
  aiCreate?: string;
  aiContinue?: string;
  aiPolish?: string;
  aiSummarize?: string;
  aiExpand?: string;
  aiTranslate?: string;
  aiUnavailable?: string;
  commentsUnavailable?: string;
  bold: string;
  italic: string;
  strike: string;
  underline: string;
  highlight: string;
  clearFormatting: string;
  blockGroup: string;
  listGroup?: string;
  paragraph: string;
  heading1: string;
  heading2: string;
  heading3: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  bulletList: string;
  orderedList: string;
  commandMenu: string;
  blockStructureUnavailable: string;
  code: string;
  undo: string;
  redo: string;
  editorNotReady: string;
  currentlyReadOnly: string;
  nothingToUndo: string;
  nothingToRedo: string;
  uploadInProgress: string;
  imageUploading: string;
  imageUploadCanceling: string;
  readOnlyReason: string;
  image: string;
  imageUploadFailed: string;
  imageUploadRetry: string;
  imageUploadCancel: string;
}

type ResolvedEditorToolbarMessages = Required<EditorToolbarMessages>;

const defaultMessages: ResolvedEditorToolbarMessages = {
  label: "编辑工具栏",
  formattingGroup: "文字格式",
  historyGroup: "编辑历史",
  attachmentsGroup: "插入附件",
  uploadRecoveryGroup: "附件上传恢复",
  alignmentGroup: "段落与对齐",
  insertGroup: "插入",
  comments: "评论",
  aiCreate: "AI 创作",
  aiContinue: "续写",
  aiPolish: "润色",
  aiSummarize: "总结",
  aiExpand: "扩写",
  aiTranslate: "翻译",
  aiUnavailable: "AI 创作暂未接入",
  commentsUnavailable: "评论暂不可用",
  bold: "加粗",
  italic: "斜体",
  strike: "删除线",
  underline: "下划线",
  highlight: "高亮",
  clearFormatting: "清除格式",
  blockGroup: "段落样式",
  listGroup: "列表",
  paragraph: "正文",
  heading1: "一级标题",
  heading2: "二级标题",
  heading3: "三级标题",
  alignLeft: "左对齐",
  alignCenter: "居中对齐",
  alignRight: "右对齐",
  bulletList: "无序列表",
  orderedList: "有序列表",
  commandMenu: "插入块和命令",
  blockStructureUnavailable: "当前模式暂不支持此块操作",
  code: "行内代码",
  undo: "撤销",
  redo: "重做",
  editorNotReady: "编辑器尚未就绪",
  currentlyReadOnly: "当前为只读",
  nothingToUndo: "没有可撤销的更改",
  nothingToRedo: "没有可重做的更改",
  uploadInProgress: "附件正在上传",
  imageUploading: "正在上传附件…",
  imageUploadCanceling: "正在取消附件上传…",
  readOnlyReason: "只读原因",
  image: "插入图片或 PDF 附件",
  imageUploadFailed: "附件上传失败，请重试。",
  imageUploadRetry: "重试附件上传",
  imageUploadCancel: "取消附件上传",
};

export interface EditorToolbarProps {
  messages?: Partial<EditorToolbarMessages>;
  className?: string;
  onOpenCommandMenu?: (selection: { from: number; to: number } | null) => void;
  outlineToggle?: ReactNode;
  linkEditorOpenRequest?: number;
  linkEditorMessages?: Partial<EditorLinkEditorMessages>;
}

function ToolbarDropdown({
  label,
  icon,
  className,
  pressed,
  children,
}: {
  label: string;
  icon: EditorIconName;
  className?: string;
  pressed?: boolean | "mixed";
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const summaryRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const closeWhenOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !detailsRef.current?.contains(target)) {
        if (detailsRef.current) detailsRef.current.open = false;
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !detailsRef.current?.open) return;
      event.preventDefault();
      detailsRef.current.open = false;
      summaryRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", closeWhenOutside, true);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside, true);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, []);

  function focusFirstItem() {
    if (!detailsRef.current) return;
    detailsRef.current.open = true;
    requestAnimationFrame(() =>
      detailsRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
    );
  }

  function closeAfterAction() {
    if (!detailsRef.current) return;
    detailsRef.current.open = false;
    summaryRef.current?.focus({ preventScroll: true });
  }

  return (
    <details
      ref={detailsRef}
      className={["zhishu-ui-toolbar-menu", className].filter(Boolean).join(" ")}
      onKeyDown={(event) => {
        if (event.target === summaryRef.current && event.key === "ArrowDown") {
          event.preventDefault();
          focusFirstItem();
        }
      }}
      onClick={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const item = target.closest<HTMLButtonElement>("button[data-menu-action]");
        if (item && !item.disabled) closeAfterAction();
      }}
    >
      <summary
        ref={summaryRef}
        className="zhishu-ui-toolbar-menu-trigger"
        aria-label={label}
        aria-pressed={pressed === "mixed" ? "mixed" : pressed}
        title={label}
      >
        <EditorIcon name={icon} />
        <span>{label}</span>
        <EditorIcon name="chevron-down" className="zhishu-ui-toolbar-menu-chevron" />
      </summary>
      <div className="zhishu-ui-toolbar-menu-panel">{children}</div>
    </details>
  );
}

type ToolbarAction = {
  id: string;
  label: string;
  icon: EditorIconName;
  disabled: boolean;
  disabledReason?: string;
  pressed?: boolean | "mixed";
  shortcut?: string;
  keyShortcuts?: string;
  run: () => void;
  showLabel?: boolean;
  visibleLabel?: string;
};

export function EditorToolbar({
  messages,
  className,
  onOpenCommandMenu,
  outlineToggle,
  linkEditorOpenRequest,
  linkEditorMessages,
}: EditorToolbarProps) {
  const { controller, hostServices, collaboration, collaborationStatus } = useEditorInstance();
  const isEditable = useEditorSelector((state) => state.isEditable);
  const readOnlyReason = useEditorSelector((state) => state.readOnlyReason);
  const canUndo = useEditorSelector((state) => state.canUndo);
  const canRedo = useEditorSelector((state) => state.canRedo);
  const formatting = useEditorSelector((state) => state.formatting);
  const block = useEditorSelector((state) => state.block);
  const list = useEditorSelector((state) => state.list);
  const blockStructure = useEditorSelector((state) => state.capabilities.blockStructure);
  const collaborativeStructureAllowed =
    collaboration?.readOnly === false &&
    collaborationStatus?.connection === "connected" &&
    collaborationStatus.sync === "current" &&
    typeof collaboration.submitStructureOperation === "function";
  const selection = useEditorSelector((state) => state.selection);
  const highlightColor = useEditorSelector((state) => state.highlightColor);
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [cancelingImageUpload, setCancelingImageUpload] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryImageFile, setRetryImageFile] = useState<File | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadFileRef = useRef<File | null>(null);
  const uploadHostRef = useRef<EditorHostServices | null>(null);
  const uploadLifecycleRef = useRef({ active: false });
  const hostServicesRef = useRef(hostServices);
  const retryImageFileRef = useRef(retryImageFile);
  hostServicesRef.current = hostServices;
  retryImageFileRef.current = retryImageFile;
  const labels = { ...defaultMessages, ...messages } as ResolvedEditorToolbarMessages;

  function captureSelection() {
    if (controller && !controller.isDestroyed) {
      const { from, to } = controller.editor.state.selection;
      savedSelectionRef.current = { from, to };
    } else if (selection) {
      savedSelectionRef.current = { from: selection.from, to: selection.to };
    }
    return savedSelectionRef.current;
  }

  function runHostAction(action: () => void | Promise<void>, fallback: string) {
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        hostServices.reportError?.(error instanceof Error ? error : new Error(fallback));
      });
  }

  useEffect(() => {
    const lifecycle = { active: true };
    uploadLifecycleRef.current = lifecycle;
    setUploadingImage(false);
    setCancelingImageUpload(false);
    setRetryImageFile(null);
    setUploadError(null);
    return () => {
      lifecycle.active = false;
      const file = uploadFileRef.current ?? retryImageFileRef.current;
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      uploadFileRef.current = null;
      if (file) {
        // The host owns any remote upload session, including one retained after failure.
        const host = uploadHostRef.current ?? hostServicesRef.current;
        void Promise.resolve()
          .then(() => host.cancelUpload?.(file))
          .catch((error: unknown) => {
            host.reportError?.(
              error instanceof Error ? error : new Error(labels.imageUploadFailed),
            );
          });
      }
    };
  }, [controller]);

  async function uploadImage(file: File) {
    if (!controller || !hostServices.requestUpload || uploadingImage) return;
    setRetryImageFile(null);
    const abortController = new AbortController();
    const lifecycle = uploadLifecycleRef.current;
    const afterBlockId = controller.getSnapshot().content.at(-1)?.attrs.blockId;
    uploadAbortRef.current = abortController;
    uploadFileRef.current = file;
    uploadHostRef.current = hostServices;
    setUploadingImage(true);
    setUploadError(null);
    let uploadCompleted = false;
    try {
      const uploaded = await hostServices.requestUpload(file, abortController.signal);
      uploadCompleted = true;
      if (!lifecycle.active || abortController.signal.aborted || controller.isDestroyed) return;
      if (!controller.isEditable) throw new Error("文档已切为只读，未插入附件。");
      if (uploadAbortRef.current === abortController) {
        uploadAbortRef.current = null;
        uploadFileRef.current = null;
      }
      const prepared =
        uploaded.mediaType === "application/pdf"
          ? controller.prepareStructureAction({
              type: "insert-pdf-attachment",
              assetId: uploaded.assetId,
              fileName: uploaded.fileName,
              afterBlockId,
            })
          : controller.prepareStructureAction({
              type: "insert-image",
              assetId: uploaded.assetId,
              mediaType: uploaded.mediaType,
              alt: uploaded.fileName.slice(0, 1_000),
              afterBlockId,
            });
      if (!prepared.success) throw new Error(prepared.result.error.message);
      if (collaboration?.submitStructureOperation) {
        const result = await collaboration.submitStructureOperation(prepared.batch);
        if (result.status !== "accepted" && result.status !== "duplicate") {
          throw new Error("code" in result ? result.code : labels.imageUploadFailed);
        }
      } else {
        const result = controller.applyOperations(prepared.batch);
        if (!result.success) throw new Error(result.error.message);
      }
    } catch (error) {
      if (lifecycle.active && !abortController.signal.aborted && !controller.isDestroyed) {
        const failure = error instanceof Error ? error : new Error(labels.imageUploadFailed);
        setUploadError(failure.message || labels.imageUploadFailed);
        if (!uploadCompleted) setRetryImageFile(file);
        hostServices.reportError?.(failure);
      }
    } finally {
      if (uploadAbortRef.current === abortController) {
        uploadAbortRef.current = null;
        uploadFileRef.current = null;
      }
      if (lifecycle.active && !controller.isDestroyed && !uploadAbortRef.current)
        setUploadingImage(false);
    }
  }

  async function cancelCurrentUpload() {
    const file = uploadFileRef.current;
    const abortController = uploadAbortRef.current;
    const lifecycle = uploadLifecycleRef.current;
    if (!file || !abortController || cancelingImageUpload) return;
    setRetryImageFile(file);
    setCancelingImageUpload(true);
    abortController.abort();
    try {
      await hostServices.cancelUpload?.(file);
      if (!lifecycle.active) return;
      setRetryImageFile(null);
      setUploadError(null);
    } catch (error) {
      if (!lifecycle.active) return;
      const failure = error instanceof Error ? error : new Error(labels.imageUploadFailed);
      setUploadError(failure.message || labels.imageUploadFailed);
      hostServices.reportError?.(failure);
    } finally {
      if (lifecycle.active) {
        if (uploadAbortRef.current === abortController) {
          uploadAbortRef.current = null;
          uploadFileRef.current = null;
          setUploadingImage(false);
        }
        setCancelingImageUpload(false);
      }
    }
  }

  async function cancelFailedUpload(file: File) {
    if (cancelingImageUpload) return;
    const lifecycle = uploadLifecycleRef.current;
    setCancelingImageUpload(true);
    try {
      await hostServices.cancelUpload?.(file);
      if (!lifecycle.active) return;
      setRetryImageFile(null);
      setUploadError(null);
    } catch (error) {
      if (!lifecycle.active) return;
      const failure = error instanceof Error ? error : new Error(labels.imageUploadFailed);
      setUploadError(failure.message || labels.imageUploadFailed);
      hostServices.reportError?.(failure);
    } finally {
      if (lifecycle.active) setCancelingImageUpload(false);
    }
  }

  const groups: Array<{ id: string; label: string; actions: ToolbarAction[] }> = [
    {
      id: "formatting",
      label: labels.formattingGroup,
      actions: [
        {
          id: "bold",
          label: labels.bold,
          icon: "bold",
          disabled: !controller || !isEditable,
          disabledReason: !controller
            ? labels.editorNotReady
            : !isEditable
              ? (readOnlyReason ?? labels.currentlyReadOnly)
              : undefined,
          pressed: formatting.bold,
          shortcut: "Ctrl/Cmd+B",
          keyShortcuts: "Control+B Meta+B",
          run: () => controller?.toggleBold(),
        },
        {
          id: "italic",
          label: labels.italic,
          icon: "italic",
          disabled: !controller || !isEditable,
          disabledReason: !controller
            ? labels.editorNotReady
            : !isEditable
              ? (readOnlyReason ?? labels.currentlyReadOnly)
              : undefined,
          pressed: formatting.italic,
          shortcut: "Ctrl/Cmd+I",
          keyShortcuts: "Control+I Meta+I",
          run: () => controller?.toggleItalic(),
        },
        {
          id: "strike",
          label: labels.strike,
          icon: "strike",
          disabled: !controller || !isEditable,
          disabledReason: !controller
            ? labels.editorNotReady
            : !isEditable
              ? (readOnlyReason ?? labels.currentlyReadOnly)
              : undefined,
          pressed: formatting.strike,
          shortcut: "Ctrl/Cmd+Shift+S",
          keyShortcuts: "Control+Shift+S Meta+Shift+S",
          run: () => controller?.toggleStrike(),
        },
        {
          id: "underline",
          label: labels.underline,
          icon: "underline",
          disabled: !controller || !isEditable,
          disabledReason: !controller
            ? labels.editorNotReady
            : !isEditable
              ? (readOnlyReason ?? labels.currentlyReadOnly)
              : undefined,
          pressed: formatting.underline,
          keyShortcuts: "Control+U Meta+U",
          run: () => controller?.toggleUnderline(),
        },
        {
          id: "clear-formatting",
          label: labels.clearFormatting,
          icon: "clear-format",
          disabled: !controller || !isEditable,
          disabledReason: !controller
            ? labels.editorNotReady
            : !isEditable
              ? (readOnlyReason ?? labels.currentlyReadOnly)
              : undefined,
          run: () => controller?.clearFormatting(),
        },
        {
          id: "code",
          label: labels.code,
          icon: "code",
          disabled: !controller || !isEditable,
          disabledReason: !controller
            ? labels.editorNotReady
            : !isEditable
              ? (readOnlyReason ?? labels.currentlyReadOnly)
              : undefined,
          pressed: formatting.code,
          shortcut: "Ctrl/Cmd+E",
          keyShortcuts: "Control+E Meta+E",
          run: () => controller?.toggleCode(),
        },
      ],
    },
    {
      id: "alignment",
      label: labels.blockGroup,
      actions: [
        {
          id: "align-left",
          label: labels.alignLeft,
          icon: "align-left",
          disabled: !controller || !isEditable || !block,
          pressed: block?.alignment === "left" || block?.alignment === null,
          run: () => controller?.setTextAlignment("left"),
        },
        {
          id: "align-center",
          label: labels.alignCenter,
          icon: "align-center",
          disabled: !controller || !isEditable || !block,
          pressed: block?.alignment === "center",
          run: () => controller?.setTextAlignment("center"),
        },
        {
          id: "align-right",
          label: labels.alignRight,
          icon: "align-right",
          disabled: !controller || !isEditable || !block,
          pressed: block?.alignment === "right",
          run: () => controller?.setTextAlignment("right"),
        },
      ],
    },
    {
      id: "lists",
      label: labels.blockGroup,
      actions: [
        {
          id: "bullet-list",
          label: labels.bulletList,
          icon: "list",
          disabled: !controller || !blockStructure.allowed,
          disabledReason: !controller
            ? labels.editorNotReady
            : !blockStructure.allowed
              ? blockStructure.reason === "read-only"
                ? (readOnlyReason ?? labels.currentlyReadOnly)
                : labels.blockStructureUnavailable
              : undefined,
          pressed: list.bullet,
          run: () => controller?.toggleBulletList(),
        },
        {
          id: "ordered-list",
          label: labels.orderedList,
          icon: "ordered-list",
          disabled: !controller || !blockStructure.allowed,
          disabledReason: !controller
            ? labels.editorNotReady
            : !blockStructure.allowed
              ? blockStructure.reason === "read-only"
                ? (readOnlyReason ?? labels.currentlyReadOnly)
                : labels.blockStructureUnavailable
              : undefined,
          pressed: list.ordered,
          run: () => controller?.toggleOrderedList(),
        },
        ...(onOpenCommandMenu
          ? [
              {
                id: "insert-menu",
                label: labels.commandMenu,
                icon: "more" as const,
                disabled:
                  !controller || (!blockStructure.allowed && !collaborativeStructureAllowed),
                disabledReason: !controller
                  ? labels.editorNotReady
                  : !blockStructure.allowed && !collaborativeStructureAllowed
                    ? blockStructure.reason === "read-only"
                      ? (readOnlyReason ?? labels.currentlyReadOnly)
                      : labels.blockStructureUnavailable
                    : undefined,
                run: () => {
                  onOpenCommandMenu(captureSelection());
                },
              },
            ]
          : []),
      ],
    },
    {
      id: "history",
      label: labels.historyGroup,
      actions: [
        {
          id: "undo",
          label: labels.undo,
          icon: "undo",
          disabled: !controller || !canUndo,
          disabledReason: !controller
            ? labels.editorNotReady
            : !canUndo
              ? labels.nothingToUndo
              : undefined,
          shortcut: "Ctrl/Cmd+Z",
          keyShortcuts: "Control+Z Meta+Z",
          run: () => controller?.undo(),
        },
        {
          id: "redo",
          label: labels.redo,
          icon: "redo",
          disabled: !controller || !canRedo,
          disabledReason: !controller
            ? labels.editorNotReady
            : !canRedo
              ? labels.nothingToRedo
              : undefined,
          shortcut: "Ctrl/Cmd+Shift+Z",
          keyShortcuts: "Control+Shift+Z Meta+Shift+Z",
          run: () => controller?.redo(),
        },
      ],
    },
    ...(hostServices.requestUpload
      ? [
          {
            id: "attachments",
            label: labels.attachmentsGroup,
            actions: [
              {
                id: "image",
                label: labels.image,
                icon: "image" as const,
                disabled: !controller || !isEditable || uploadingImage,
                disabledReason: !controller
                  ? labels.editorNotReady
                  : uploadingImage
                    ? labels.uploadInProgress
                    : !isEditable
                      ? (readOnlyReason ?? labels.currentlyReadOnly)
                      : undefined,
                showLabel: true,
                visibleLabel: "附件",
                run: () => imageInputRef.current?.click(),
              },
            ],
          },
        ]
      : []),
    ...(uploadingImage && uploadFileRef.current
      ? [
          {
            id: "upload-recovery",
            label: labels.uploadRecoveryGroup,
            actions: [
              {
                id: "cancel-image-upload",
                label: labels.imageUploadCancel,
                icon: "x" as const,
                disabled: cancelingImageUpload,
                showLabel: true,
                run: () => void cancelCurrentUpload(),
              },
            ],
          },
        ]
      : retryImageFile
        ? [
            {
              id: "upload-recovery",
              label: labels.uploadRecoveryGroup,
              actions: [
                {
                  id: "retry-image",
                  label: labels.imageUploadRetry,
                  icon: "refresh" as const,
                  disabled: !controller || !isEditable || uploadingImage || cancelingImageUpload,
                  disabledReason: !controller
                    ? labels.editorNotReady
                    : uploadingImage || cancelingImageUpload
                      ? labels.uploadInProgress
                      : !isEditable
                        ? (readOnlyReason ?? labels.currentlyReadOnly)
                        : undefined,
                  showLabel: true,
                  run: () => void uploadImage(retryImageFile),
                },
                {
                  id: "cancel-image-upload",
                  label: labels.imageUploadCancel,
                  icon: "x" as const,
                  disabled: uploadingImage || cancelingImageUpload,
                  run: () => void cancelFailedUpload(retryImageFile),
                },
              ],
            },
          ]
        : []),
  ];
  const allActions = groups.flatMap((group) => group.actions);
  const actionById = (id: string) => allActions.find((action) => action.id === id);
  const formattingActions = groups.find((group) => group.id === "formatting")?.actions ?? [];
  const historyActions = groups.find((group) => group.id === "history")?.actions ?? [];
  const recoveryActions = groups.find((group) => group.id === "upload-recovery")?.actions ?? [];
  const currentBlockLabel =
    block?.type === "heading-1"
      ? labels.heading1
      : block?.type === "heading-2"
        ? labels.heading2
        : block?.type === "heading-3"
          ? labels.heading3
          : block?.type === "mixed"
            ? "多种格式"
            : labels.paragraph;
  const currentBlockIcon: EditorIconName = block?.type.startsWith("heading-")
    ? "heading"
    : "paragraph";

  function renderAction(action: ToolbarAction, menuItem = false) {
    return (
      <button
        key={action.id}
        type="button"
        className={
          menuItem
            ? "zhishu-ui-toolbar-button zhishu-ui-toolbar-menu-item"
            : "zhishu-ui-toolbar-button"
        }
        data-action={action.id}
        data-menu-action={menuItem ? "" : undefined}
        disabled={action.disabled}
        aria-label={action.label}
        aria-pressed={action.pressed === "mixed" ? "mixed" : action.pressed}
        aria-description={action.disabledReason}
        aria-keyshortcuts={action.keyShortcuts}
        title={[action.label, action.shortcut, action.disabledReason].filter(Boolean).join(" · ")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={action.run}
      >
        <EditorIcon name={action.icon} />
        <span className={menuItem || action.showLabel ? undefined : "zhishu-ui-visually-hidden"}>
          {action.visibleLabel ?? action.label}
        </span>
      </button>
    );
  }

  const paragraphActions: ToolbarAction[] = [
    {
      id: "paragraph",
      label: labels.paragraph,
      icon: "paragraph",
      disabled: !controller || !isEditable,
      pressed: block?.type === "paragraph",
      run: () => controller?.setParagraph(),
    },
    ...([1, 2, 3] as const).map((level) => ({
      id: `heading-${level}`,
      label: level === 1 ? labels.heading1 : level === 2 ? labels.heading2 : labels.heading3,
      icon: "heading" as const,
      disabled: !controller || !isEditable,
      pressed: block?.type === `heading-${level}`,
      run: () => controller?.setHeading(level),
    })),
  ];
  const alignmentActions = groups.find((group) => group.id === "alignment")?.actions ?? [];
  const listActions = groups.find((group) => group.id === "lists")?.actions ?? [];
  const insertionActions = [
    ...(actionById("insert-menu") ? [actionById("insert-menu")] : []),
    ...(actionById("image") ? [actionById("image")] : []),
  ].filter((action): action is ToolbarAction => action !== undefined);
  const currentSelection = (): EditorTextSelection | null => captureSelection();

  return (
    <div
      className={className ? `zhishu-ui-toolbar ${className}` : "zhishu-ui-toolbar"}
      role="group"
      aria-label={labels.label}
    >
      <div
        className="zhishu-ui-toolbar-group zhishu-ui-toolbar-history"
        role="group"
        aria-label={labels.historyGroup}
      >
        {historyActions.map((action) => renderAction(action))}
      </div>
      {outlineToggle}
      <ToolbarDropdown label={currentBlockLabel} icon={currentBlockIcon} className="is-block-menu">
        <p className="zhishu-ui-toolbar-menu-heading">{labels.blockGroup}</p>
        <div className="zhishu-ui-toolbar-menu-section" role="group" aria-label={labels.blockGroup}>
          {paragraphActions.map((action) => renderAction(action, true))}
        </div>
        <div className="zhishu-ui-toolbar-menu-divider" />
        <p className="zhishu-ui-toolbar-menu-heading">{labels.alignmentGroup}</p>
        <div
          className="zhishu-ui-toolbar-menu-section"
          role="group"
          aria-label={labels.alignmentGroup}
        >
          {alignmentActions.map((action) => renderAction(action, true))}
        </div>
        <div className="zhishu-ui-toolbar-menu-divider" />
        <p className="zhishu-ui-toolbar-menu-heading">{labels.listGroup}</p>
        <div className="zhishu-ui-toolbar-menu-section" role="group" aria-label={labels.listGroup}>
          {listActions
            .filter((action) => action.id !== "insert-menu")
            .map((action) => renderAction(action, true))}
        </div>
      </ToolbarDropdown>
      <div
        className="zhishu-ui-toolbar-group zhishu-ui-toolbar-formatting"
        role="group"
        aria-label={labels.formattingGroup}
      >
        {formattingActions.map((action) => renderAction(action))}
      </div>
      <ToolbarDropdown
        label={labels.highlight}
        icon="highlight"
        className="is-highlight-menu"
        pressed={formatting.highlight}
      >
        <div className="zhishu-ui-toolbar-menu-section" role="group" aria-label={labels.highlight}>
          {(
            [
              ["yellow", "黄色高亮"],
              ["green", "绿色高亮"],
              ["blue", "蓝色高亮"],
              ["pink", "粉色高亮"],
              ["purple", "紫色高亮"],
            ] as const
          ).map(([color, label]) => (
            <button
              key={color}
              type="button"
              className="zhishu-ui-toolbar-button zhishu-ui-toolbar-menu-item"
              data-menu-action=""
              data-highlight-color={color}
              disabled={!controller || !isEditable}
              aria-pressed={highlightColor === color}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller?.setHighlightColor(color as HighlightColor)}
            >
              <span className="zhishu-ui-highlight-swatch" aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="zhishu-ui-toolbar-menu-divider" />
        <div
          className="zhishu-ui-toolbar-menu-section"
          role="group"
          aria-label={labels.formattingGroup}
        >
          {renderAction(
            {
              id: "remove-highlight",
              label: "取消高亮",
              icon: "clear-format",
              disabled: !controller || !isEditable,
              run: () => controller?.unsetHighlight(),
            },
            true,
          )}
        </div>
      </ToolbarDropdown>
      {linkEditorOpenRequest !== undefined && (
        <EditorLinkEditor messages={linkEditorMessages} openRequest={linkEditorOpenRequest} />
      )}
      {insertionActions.length > 0 && (
        <ToolbarDropdown label={labels.insertGroup} icon="more" className="is-insert-menu">
          <div
            className="zhishu-ui-toolbar-menu-section"
            role="group"
            aria-label={labels.insertGroup}
          >
            {insertionActions.map((action) => renderAction(action, true))}
          </div>
        </ToolbarDropdown>
      )}
      {hostServices.requestAIAction && (
        <ToolbarDropdown label={labels.aiCreate} icon="sparkles" className="is-ai-menu">
          {hostServices.requestAIAction ? (
            <div
              className="zhishu-ui-toolbar-menu-section"
              role="group"
              aria-label={labels.aiCreate}
            >
              {(
                [
                  ["continue", labels.aiContinue],
                  ["polish", labels.aiPolish],
                  ["summarize", labels.aiSummarize],
                  ["expand", labels.aiExpand],
                  ["translate", labels.aiTranslate],
                ] as const
              ).map(([action, label]) => (
                <button
                  key={action}
                  type="button"
                  className="zhishu-ui-toolbar-button zhishu-ui-toolbar-menu-item"
                  data-menu-action=""
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() =>
                    runHostAction(
                      () =>
                        hostServices.requestAIAction?.({
                          action: action as EditorAIAction,
                          selection: currentSelection(),
                        }),
                      labels.aiUnavailable,
                    )
                  }
                >
                  <EditorIcon name="sparkles" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="zhishu-ui-toolbar-menu-note">{labels.aiUnavailable}</p>
          )}
        </ToolbarDropdown>
      )}
      {recoveryActions.length > 0 && (
        <div
          className="zhishu-ui-toolbar-group zhishu-ui-toolbar-recovery"
          role="group"
          aria-label={labels.uploadRecoveryGroup}
        >
          {recoveryActions.map((action) => renderAction(action))}
        </div>
      )}
      {hostServices.requestUpload && (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf,.pdf"
          hidden
          aria-label={labels.image}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (retryImageFile && retryImageFile !== file) {
              void hostServices.cancelUpload?.(retryImageFile);
              setRetryImageFile(null);
            }
            if (file) void uploadImage(file);
          }}
        />
      )}
      {(uploadingImage || cancelingImageUpload) && (
        <span className="zhishu-ui-toolbar-status" role="status">
          <EditorIcon name="loader" className="is-spinning" />
          {cancelingImageUpload ? labels.imageUploadCanceling : labels.imageUploading}
        </span>
      )}
      {uploadError && (
        <span className="zhishu-ui-toolbar-status is-error" role="alert">
          {uploadError}
        </span>
      )}
      {hostServices.openComments && (
        <button
          type="button"
          className="zhishu-ui-toolbar-button zhishu-ui-toolbar-labeled-button"
          data-action="comments"
          aria-label={labels.comments}
          title={labels.comments}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            runHostAction(
              () => hostServices.openComments?.(currentSelection()),
              labels.commentsUnavailable,
            )
          }
        >
          <EditorIcon name="comment" />
          <span>{labels.comments}</span>
        </button>
      )}
    </div>
  );
}
