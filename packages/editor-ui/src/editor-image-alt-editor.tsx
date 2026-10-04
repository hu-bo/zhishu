import { useEffect, useId, useState, type FormEvent } from "react";
import { useEditorInstance, useEditorSelector } from "@zhishu/editor-react";

export interface EditorImageAltEditorMessages {
  label: string;
  alt: string;
  altHelp: string;
  save: string;
  updated: string;
  changed: string;
  width: string;
  height: string;
  invalidDimension: string;
}

const defaultMessages: EditorImageAltEditorMessages = {
  label: "图片属性",
  alt: "替代文本",
  altHelp: "装饰性图片可留空。",
  save: "保存图片属性",
  updated: "图片属性已更新",
  changed: "图片已变化，请重新选择后再编辑",
  width: "宽度（px）",
  height: "高度（px）",
  invalidDimension: "尺寸须为 1 到 32768 之间的整数",
};

export interface EditorImageAltEditorProps {
  messages?: Partial<EditorImageAltEditorMessages>;
  className?: string;
}

export function EditorImageAltEditor({ messages, className }: EditorImageAltEditorProps) {
  const { controller } = useEditorInstance();
  const hintId = useId();
  const revision = useEditorSelector((snapshot) => snapshot.revision);
  const isEditable = useEditorSelector((snapshot) => snapshot.isEditable);
  const [draft, setDraft] = useState("");
  const [widthDraft, setWidthDraft] = useState("");
  const [heightDraft, setHeightDraft] = useState("");
  const [status, setStatus] = useState("");
  const labels = { ...defaultMessages, ...messages };
  void revision;

  const selection = controller?.editor.state.selection;
  const selectionWithNode = selection as
    { node?: { type: { name: string }; attrs: Record<string, unknown> } } | undefined;
  const selectedNode = selectionWithNode?.node;
  const image =
    selectedNode?.type.name === "image" &&
    typeof selectedNode.attrs.blockId === "string" &&
    typeof selectedNode.attrs.assetId === "string"
      ? {
          blockId: selectedNode.attrs.blockId,
          assetId: selectedNode.attrs.assetId,
          alt: typeof selectedNode.attrs.alt === "string" ? selectedNode.attrs.alt : "",
          width: typeof selectedNode.attrs.width === "number" ? selectedNode.attrs.width : null,
          height: typeof selectedNode.attrs.height === "number" ? selectedNode.attrs.height : null,
        }
      : undefined;

  useEffect(() => {
    setDraft(image?.alt ?? "");
    setWidthDraft(image?.width === null || image?.width === undefined ? "" : String(image.width));
    setHeightDraft(
      image?.height === null || image?.height === undefined ? "" : String(image.height),
    );
  }, [image?.blockId, image?.assetId, image?.alt, image?.width, image?.height]);

  useEffect(() => {
    setStatus("");
  }, [image?.blockId, image?.assetId]);

  const selectedImage = image;
  if (!selectedImage || !controller || controller.isDestroyed) return null;
  const targetBlockId = selectedImage.blockId;
  const targetAssetId = selectedImage.assetId;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    if (!controller || controller.isDestroyed || !controller.canExecute("write").allowed) return;

    const current = controller.findBlock(targetBlockId);
    const node = current ? controller.editor.state.doc.nodeAt(current.position) : undefined;
    if (
      !current ||
      current.type !== "image" ||
      node?.type.name !== "image" ||
      node.attrs.assetId !== targetAssetId
    ) {
      setStatus(labels.changed);
      return;
    }
    if (node.attrs.alt === draft) {
      if (
        (node.attrs.width ?? null) === (widthDraft === "" ? null : Number(widthDraft)) &&
        (node.attrs.height ?? null) === (heightDraft === "" ? null : Number(heightDraft))
      ) {
        setStatus(labels.updated);
        return;
      }
    }

    const width = parseDimension(widthDraft);
    const height = parseDimension(heightDraft);
    if (width === null || height === null) {
      setStatus(labels.invalidDimension);
      return;
    }

    const attrs = { ...node.attrs, alt: draft } as Record<string, unknown>;
    if (width === undefined) delete attrs.width;
    else attrs.width = width;
    if (height === undefined) delete attrs.height;
    else attrs.height = height;

    const transaction = controller.editor.state.tr.setNodeMarkup(current.position, undefined, {
      ...attrs,
    });
    transaction.setMeta("zhishu-origin", "host-command");
    controller.editor.view.dispatch(transaction);
    setStatus(labels.updated);
  }

  function parseDimension(value: string): number | undefined | null {
    if (value === "") return undefined;
    const dimension = Number(value);
    return Number.isInteger(dimension) && dimension >= 1 && dimension <= 32_768 ? dimension : null;
  }

  return (
    <form
      className={
        className ? `zhishu-ui-image-alt-editor ${className}` : "zhishu-ui-image-alt-editor"
      }
      aria-label={labels.label}
      noValidate
      onSubmit={save}
    >
      <label>
        {labels.alt}
        <textarea
          aria-describedby={hintId}
          value={draft}
          maxLength={1_000}
          rows={2}
          disabled={!isEditable}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setStatus("");
          }}
        />
        <span id={hintId} className="zhishu-ui-image-alt-editor__hint">
          {labels.altHelp}
        </span>
      </label>
      <label className="zhishu-ui-image-alt-editor__dimension">
        {labels.width}
        <input
          type="number"
          min={1}
          max={32_768}
          step={1}
          value={widthDraft}
          disabled={!isEditable}
          onChange={(event) => {
            setWidthDraft(event.currentTarget.value);
            setStatus("");
          }}
        />
      </label>
      <label className="zhishu-ui-image-alt-editor__dimension">
        {labels.height}
        <input
          type="number"
          min={1}
          max={32_768}
          step={1}
          value={heightDraft}
          disabled={!isEditable}
          onChange={(event) => {
            setHeightDraft(event.currentTarget.value);
            setStatus("");
          }}
        />
      </label>
      <button
        type="submit"
        disabled={
          !isEditable ||
          (draft === selectedImage.alt &&
            widthDraft === (selectedImage.width === null ? "" : String(selectedImage.width)) &&
            heightDraft === (selectedImage.height === null ? "" : String(selectedImage.height)))
        }
      >
        {labels.save}
      </button>
      <span role="status" aria-live="polite">
        {status}
      </span>
    </form>
  );
}
