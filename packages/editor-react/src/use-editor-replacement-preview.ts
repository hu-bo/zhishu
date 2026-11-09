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
  actions: EditorReplacementPreviewActions & { waitForOriginal?: boolean } = {},
) {
  const { controller } = useEditorInstance();
  const callback = useRef(onInvalidated);
  const actionCallbacks = useRef(actions);
  useEffect(() => {
    callback.current = onInvalidated;
    actionCallbacks.current = actions;
  }, [onInvalidated, actions]);
  const [state, setState] = useState<{
    preview: EditorReplacementPreviewData;
    count: number;
    index: number;
  } | null>(null);
  const interactive = !!actions.onAccept && !!actions.onReject;
  useEffect(() => {
    if (!controller || !preview) return;
    let active = true;
    let installed = false;
    const install = () => {
      if (!active || installed || controller.isDestroyed) return;
      const count = setReplacementPreview(controller.editor, preview, {
        disabled: actions.disabled,
        onAccept: interactive
          ? (blockId) => actionCallbacks.current.onAccept?.(blockId)
          : undefined,
        onReject: interactive
          ? (blockId) => actionCallbacks.current.onReject?.(blockId)
          : undefined,
      });
      if (count === null) {
        if (!actions.waitForOriginal) callback.current();
        return;
      }
      installed = true;
      setState({ preview, count, index: 0 });
    };
    const release = controller.subscribe((event) => {
      if (!event.docChanged) return;
      if (installed) callback.current();
      else if (actions.waitForOriginal) queueMicrotask(install);
    });
    install();
    return () => {
      active = false;
      release();
      if (installed && !controller.isDestroyed) setReplacementPreview(controller.editor, null);
    };
  }, [controller, preview, actions.disabled, actions.waitForOriginal, interactive]);
  const current = state?.preview === preview ? state : null;
  return {
    ready: !!current,
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
