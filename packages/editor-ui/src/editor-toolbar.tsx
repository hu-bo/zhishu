import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useEditorInstance } from "@zhishu/editor-react";
import { useEditorSelector } from "@zhishu/editor-react";

export interface EditorToolbarMessages {
  label: string;
  bold: string;
  italic: string;
  strike: string;
  code: string;
  undo: string;
  redo: string;
  readOnlyReason: string;
  image: string;
  imageUploadFailed: string;
}

const defaultMessages: EditorToolbarMessages = {
  label: "编辑工具栏",
  bold: "加粗",
  italic: "斜体",
  strike: "删除线",
  code: "行内代码",
  undo: "撤销",
  redo: "重做",
  readOnlyReason: "只读原因",
  image: "插入图片",
  imageUploadFailed: "图片上传失败，请重试。",
};

export interface EditorToolbarProps {
  messages?: Partial<EditorToolbarMessages>;
  className?: string;
}

export function EditorToolbar({ messages, className }: EditorToolbarProps) {
  const { controller, hostServices, collaboration } = useEditorInstance();
  const isEditable = useEditorSelector((state) => state.isEditable);
  const readOnlyReason = useEditorSelector((state) => state.readOnlyReason);
  const canUndo = useEditorSelector((state) => state.canUndo);
  const canRedo = useEditorSelector((state) => state.canRedo);
  const formatting = useEditorSelector((state) => state.formatting);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [rovingIndex, setRovingIndex] = useState(0);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const labels = { ...defaultMessages, ...messages };

  useEffect(
    () => () => {
      uploadAbortRef.current?.abort();
    },
    [],
  );

  async function uploadImage(file: File) {
    if (!controller || !hostServices.requestUpload || uploadingImage) return;
    const abortController = new AbortController();
    uploadAbortRef.current = abortController;
    setUploadingImage(true);
    setUploadError(null);
    try {
      const uploaded = await hostServices.requestUpload(file, abortController.signal);
      const prepared = controller.prepareStructureAction({
        type: "insert-image",
        assetId: uploaded.assetId,
        mediaType: uploaded.mediaType,
        alt: file.name.slice(0, 1_000),
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
      if (!abortController.signal.aborted) {
        const failure = error instanceof Error ? error : new Error(labels.imageUploadFailed);
        setUploadError(failure.message || labels.imageUploadFailed);
        hostServices.reportError?.(failure);
      }
    } finally {
      if (uploadAbortRef.current === abortController) uploadAbortRef.current = null;
      setUploadingImage(false);
    }
  }

  const actions = [
    {
      id: "bold",
      label: labels.bold,
      disabled: !controller || !isEditable,
      pressed: formatting.bold,
      run: () => controller?.toggleBold(),
    },
    {
      id: "italic",
      label: labels.italic,
      disabled: !controller || !isEditable,
      pressed: formatting.italic,
      run: () => controller?.toggleItalic(),
    },
    {
      id: "strike",
      label: labels.strike,
      disabled: !controller || !isEditable,
      pressed: formatting.strike,
      run: () => controller?.toggleStrike(),
    },
    {
      id: "code",
      label: labels.code,
      disabled: !controller || !isEditable,
      pressed: formatting.code,
      run: () => controller?.toggleCode(),
    },
    {
      id: "undo",
      label: labels.undo,
      disabled: !controller || !canUndo,
      run: () => controller?.undo(),
    },
    {
      id: "redo",
      label: labels.redo,
      disabled: !controller || !canRedo,
      run: () => controller?.redo(),
    },
    ...(hostServices.requestUpload
      ? [
          {
            id: "image",
            label: labels.image,
            disabled: !controller || !isEditable || uploadingImage,
            run: () => imageInputRef.current?.click(),
          },
        ]
      : []),
  ];
  const enabledIndexes = actions.flatMap((action, index) => (action.disabled ? [] : [index]));
  const tabStopIndex = enabledIndexes.includes(rovingIndex)
    ? rovingIndex
    : (enabledIndexes[0] ?? -1);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    if (enabledIndexes.length === 0) return;
    const buttons =
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    if (!buttons?.length) return;
    const currentIndex = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? enabledIndexes.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + enabledIndexes.length) %
            enabledIndexes.length;
    event.preventDefault();
    setRovingIndex(enabledIndexes[nextIndex] ?? 0);
    buttons.item(nextIndex)?.focus();
  }

  return (
    <div
      ref={toolbarRef}
      className={className ? `zhishu-ui-toolbar ${className}` : "zhishu-ui-toolbar"}
      role="toolbar"
      aria-label={labels.label}
      onKeyDown={onKeyDown}
    >
      {actions.map((action, index) => (
        <button
          key={action.id}
          type="button"
          disabled={action.disabled}
          aria-label={action.label}
          aria-pressed={action.pressed === "mixed" ? "mixed" : action.pressed}
          tabIndex={tabStopIndex === index ? 0 : -1}
          title={
            !isEditable && action.id !== "undo" && action.id !== "redo" ? readOnlyReason : undefined
          }
          onFocus={() => setRovingIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
      {hostServices.requestUpload && (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label={labels.image}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void uploadImage(file);
          }}
        />
      )}
      {uploadingImage && <span role="status">{labels.image}…</span>}
      {uploadError && <span role="alert">{uploadError}</span>}
      {!isEditable && readOnlyReason && (
        <span className="zhishu-ui-readonly" role="status">
          {labels.readOnlyReason}：{readOnlyReason}
        </span>
      )}
    </div>
  );
}
