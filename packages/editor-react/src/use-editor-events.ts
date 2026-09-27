import { useEffect, useRef } from "react";
import type { EditorTransactionEvent, EditorTransactionListener } from "@zhishu/editor-core";
import { useEditorInstance } from "./context.js";

export function useEditorEvents(listener: EditorTransactionListener): void {
  const { controller } = useEditorInstance();
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    return controller.subscribe((event: EditorTransactionEvent) => listenerRef.current(event));
  }, [controller]);
}
