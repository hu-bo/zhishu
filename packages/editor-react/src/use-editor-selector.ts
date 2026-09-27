import { useCallback, useRef, useSyncExternalStore } from "react";
import { useEditorInstance } from "./context.js";
import type { EditorStoreSnapshot } from "./store.js";

export function useEditorSelector<T>(
  selector: (snapshot: EditorStoreSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const { store } = useEditorInstance();
  const selectorRef = useRef(selector);
  const equalityRef = useRef(isEqual);
  const cacheRef = useRef<{ source: EditorStoreSnapshot; value: T } | null>(null);
  selectorRef.current = selector;
  equalityRef.current = isEqual;

  const getSnapshot = useCallback(() => {
    const source = store.getSnapshot();
    const previous = cacheRef.current;
    if (previous?.source === source) return previous.value;
    const value = selectorRef.current(source);
    if (previous && equalityRef.current(previous.value, value)) {
      cacheRef.current = { source, value: previous.value };
      return previous.value;
    }
    cacheRef.current = { source, value };
    return value;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
