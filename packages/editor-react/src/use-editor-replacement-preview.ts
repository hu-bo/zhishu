import { useEffect, useRef, useState } from "react";
import {
  setReplacementPreview,
  scrollToReplacementPreview,
  type EditorReplacementPreviewData,
  type EditorReplacementPreviewActions,
} from "@zhishu/editor-core";
import { useEditorInstance } from "./context.js";

export function useEditorReplacementPreview(
  preview: EditorReplacementPreviewData | null,
  onInvalidated: () => void,
  actions: EditorReplacementPreviewActions = {},
) {
  const { controller } = useEditorInstance();
  const callback = useRef(onInvalidated);
  const actionCallbacks = useRef(actions);
  useEffect(() => {
    callback.current = onInvalidated;
    actionCallbacks.current = actions;
  }, [onInvalidated, actions]);
  const [state, setState] = useState<{ id: string; count: number; index: number } | null>(null);
  const interactive = !!actions.onAccept && !!actions.onReject;
  useEffect(() => {
    if (!controller || !preview) return;
    const count = setReplacementPreview(controller.editor, preview, {
      disabled: actions.disabled,
      onAccept: interactive ? (blockId) => actionCallbacks.current.onAccept?.(blockId) : undefined,
      onReject: interactive ? (blockId) => actionCallbacks.current.onReject?.(blockId) : undefined,
    });
    if (count === null) {
      callback.current();
      return;
    }
    setState({ id: preview.id, count, index: 0 });
    const release = controller.subscribe((event) => {
      if (event.docChanged) callback.current();
    });
    return () => {
      release();
      if (!controller.isDestroyed) setReplacementPreview(controller.editor, null);
    };
  }, [controller, preview, actions.disabled, interactive]);
  const current = state?.id === preview?.id ? state : null;
  return {
    count: current?.count ?? 0,
    index: current?.index ?? 0,
    navigate: (direction: number) => {
      if (!current?.count || !controller) return;
      const index = (current.index + direction + current.count) % current.count;
      scrollToReplacementPreview(controller.editor, index);
      setState({ ...current, index });
    },
  };
}
