import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type PropsWithChildren,
} from "react";
import {
  createEditor,
  type CreateEditorOptions,
  type EditorTransactionEvent,
} from "@zhishu/editor-core";
import type { DocumentContent } from "@zhishu/document-contracts";
import {
  editorContext,
  type EditorCollaborationSession,
  type EditorCollaborationPresence,
  type EditorCollaborationStatus,
  type EditorHostServices,
  type EditorInstanceContextValue,
} from "./context.js";
import { EditorStore } from "./store.js";
import {
  createSafeReactNodeViewRenderer,
  type ReactNodeViewProps,
  type SafeReactNodeViewRendererOptions,
} from "./react-node-view.js";

export interface EditorReactNodeView {
  component: ComponentType<ReactNodeViewProps>;
  options?: SafeReactNodeViewRendererOptions;
}

const emptyOptions = {};
const emptyHostServices: EditorHostServices = Object.freeze({});

export interface EditorProviderProps extends PropsWithChildren {
  options?: Omit<
    CreateEditorOptions,
    | "element"
    | "onLinkClick"
    | "codeBlockNodeView"
    | "calloutNodeView"
    | "dividerNodeView"
    | "statusTagNodeView"
  >;
  nodeViews?: {
    codeBlock?: EditorReactNodeView;
    callout?: EditorReactNodeView;
    horizontalRule?: EditorReactNodeView;
    statusTag?: EditorReactNodeView;
  };
  instanceKey?: string;
  loading?: boolean;
  editable?: boolean;
  readOnlyReason?: string;
  hostServices?: EditorHostServices;
  collaboration?: EditorCollaborationSession;
  onTransaction?: (event: EditorTransactionEvent) => void;
  onUpdate?: (content: DocumentContent, event: EditorTransactionEvent) => void;
}

export function EditorProvider({
  options = emptyOptions,
  nodeViews,
  instanceKey,
  loading = false,
  editable,
  readOnlyReason,
  hostServices = emptyHostServices,
  collaboration,
  onTransaction,
  onUpdate,
  children,
}: EditorProviderProps) {
  const storeRef = useRef<EditorStore | null>(null);
  if (!storeRef.current) storeRef.current = new EditorStore();
  const store = storeRef.current;
  const optionsRef = useRef(options);
  const nodeViewsRef = useRef(nodeViews);
  const collaborationRef = useRef(collaboration);
  const hostRef = useRef(hostServices);
  const callbacksRef = useRef({ onTransaction, onUpdate });
  optionsRef.current = options;
  nodeViewsRef.current = nodeViews;
  collaborationRef.current = collaboration;
  hostRef.current = hostServices;
  callbacksRef.current = { onTransaction, onUpdate };
  const [controllerState, setControllerState] = useState<{
    lifecycleKey: string;
    controller: ReturnType<typeof createEditor>;
  } | null>(null);
  const [failure, setFailure] = useState<{ lifecycleKey: string; error: Error } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [collaborationReadOnly, setCollaborationReadOnly] = useState(false);
  const [collaborationStatus, setCollaborationStatus] = useState<EditorCollaborationStatus | null>(
    null,
  );
  const [collaborationPresences, setCollaborationPresences] = useState<
    readonly EditorCollaborationPresence[]
  >([]);

  const retry = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);

  const documentKey = `${instanceKey ?? "embedded"}:${options.documentId ?? "document"}:${options.generationId ?? "base"}`;
  const lifecycleKey = `${documentKey}:mode-${options.collaborative ? "collaborative" : "standalone"}:${collaboration?.key ?? "none"}:attempt-${retryCount}`;
  const controller =
    !loading &&
    controllerState?.lifecycleKey === lifecycleKey &&
    !controllerState.controller.isDestroyed
      ? controllerState.controller
      : null;
  const error = failure?.lifecycleKey === lifecycleKey ? failure.error : undefined;

  useEffect(() => {
    let active = true;
    let currentController: ReturnType<typeof createEditor> | undefined;
    setFailure(null);
    store.setStatus("initializing");
    if (loading) {
      return () => {
        store.setStatus("disposed");
      };
    }
    let releaseStoreSubscription: (() => void) | undefined;
    let releaseCollaborationSubscription: (() => void) | undefined;
    let releasePresenceSubscription: (() => void) | undefined;
    const initialize = async () => {
      try {
        const currentOptions = optionsRef.current;
        const session = collaborationRef.current;
        if (currentOptions.collaborative && !session) {
          throw new TypeError("Collaborative editors require a collaboration session.");
        }
        if (!currentOptions.collaborative && session) {
          throw new TypeError("A collaboration session requires collaborative editor mode.");
        }
        const applyCollaborationAccess = () => {
          if (!session) {
            setCollaborationReadOnly(false);
            setCollaborationStatus(null);
            setCollaborationPresences([]);
            return false;
          }
          const status = session.getStatus();
          setCollaborationStatus(status);
          setCollaborationPresences(session.getPresences?.() ?? []);
          const sessionReadOnly =
            session.readOnly ||
            status.connection === "denied" ||
            status.connection === "closed" ||
            status.sync === "incompatible";
          setCollaborationReadOnly(sessionReadOnly);
          if (sessionReadOnly && currentController && !currentController.isDestroyed) {
            currentController.setEditable(false, "当前协同会话仅允许查看");
            store.refresh(currentController);
          }
          return sessionReadOnly;
        };
        applyCollaborationAccess();
        releaseCollaborationSubscription = session?.subscribe(() => {
          applyCollaborationAccess();
        });
        releasePresenceSubscription = session?.subscribePresence?.((presences) => {
          setCollaborationPresences(presences);
        });
        if (session) await session.waitUntilSynced();
        if (!active) return;

        const sessionReadOnly = applyCollaborationAccess();
        const collaborationExtensions = (await session?.createEditorExtensions?.()) ?? [];
        if (!active) return;
        currentController = createEditor({
          ...currentOptions,
          codeBlockNodeView: nodeViewsRef.current?.codeBlock
            ? createSafeReactNodeViewRenderer(
                nodeViewsRef.current.codeBlock.component,
                nodeViewsRef.current.codeBlock.options,
              )
            : undefined,
          calloutNodeView: nodeViewsRef.current?.callout
            ? createSafeReactNodeViewRenderer(
                nodeViewsRef.current.callout.component,
                nodeViewsRef.current.callout.options,
              )
            : undefined,
          dividerNodeView: nodeViewsRef.current?.horizontalRule
            ? createSafeReactNodeViewRenderer(
                nodeViewsRef.current.horizontalRule.component,
                nodeViewsRef.current.horizontalRule.options,
              )
            : undefined,
          statusTagNodeView: nodeViewsRef.current?.statusTag
            ? createSafeReactNodeViewRenderer(
                nodeViewsRef.current.statusTag.component,
                nodeViewsRef.current.statusTag.options,
              )
            : undefined,
          extensions: [...(currentOptions.extensions ?? []), ...collaborationExtensions],
          editable: sessionReadOnly ? false : (editable ?? currentOptions.editable),
          readOnlyReason: sessionReadOnly
            ? (readOnlyReason ?? currentOptions.readOnlyReason ?? "当前会话仅允许查看")
            : (readOnlyReason ?? currentOptions.readOnlyReason),
          onLinkClick: (href) => {
            const host = hostRef.current;
            if (!host.openExternalLink) return;
            let confirmed = false;
            try {
              confirmed = host.confirmExternalLink?.(href) ?? false;
            } catch (caught) {
              host.reportError?.(
                caught instanceof Error ? caught : new Error("Could not confirm external link."),
              );
              return;
            }
            if (!confirmed) return;
            try {
              void Promise.resolve(host.openExternalLink(href)).catch((caught: unknown) => {
                host.reportError?.(
                  caught instanceof Error ? caught : new Error("Could not open external link."),
                );
              });
            } catch (caught) {
              host.reportError?.(
                caught instanceof Error ? caught : new Error("Could not open external link."),
              );
            }
          },
          onLimitExceeded: (reason) => {
            optionsRef.current.onLimitExceeded?.(reason);
            const labels = {
              "document-size": "文档结构大小超过编辑上限，已拒绝本次修改。",
              "document-nodes": "文档节点数超过编辑上限，已拒绝本次修改。",
              "transaction-steps": "单次编辑操作超过事务上限，已拒绝本次修改。",
            };
            hostRef.current.reportError?.(new Error(labels[reason]));
          },
        });
        if (active) {
          setControllerState({ lifecycleKey, controller: currentController });
          releaseStoreSubscription = store.bind(currentController);
        } else currentController.destroy();
      } catch (caught) {
        const nextError =
          caught instanceof Error ? caught : new Error("Editor initialization failed.");
        if (active) {
          setFailure({ lifecycleKey, error: nextError });
          store.setStatus("failed");
          hostRef.current.reportError?.(nextError);
        }
      }
    };
    void initialize();
    return () => {
      active = false;
      store.setStatus("disposed");
      releaseStoreSubscription?.();
      releaseCollaborationSubscription?.();
      releasePresenceSubscription?.();
      currentController?.destroy();
    };
  }, [lifecycleKey, loading, store]);

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    const sessionReadOnly = collaborationReadOnly && optionsRef.current.collaborative === true;
    controller.setEditable(
      sessionReadOnly ? false : (editable ?? optionsRef.current.editable ?? true),
      sessionReadOnly
        ? (readOnlyReason ?? optionsRef.current.readOnlyReason ?? "当前会话仅允许查看")
        : readOnlyReason,
    );
    store.refresh(controller);
  }, [collaborationReadOnly, controller, editable, readOnlyReason, store]);

  useEffect(() => {
    if (!controller || controller.isDestroyed) return;
    return controller.subscribe((event) => {
      callbacksRef.current.onTransaction?.(event);
      if (event.docChanged) callbacksRef.current.onUpdate?.(controller.getSnapshot(), event);
    });
  }, [controller]);

  const status = loading
    ? "initializing"
    : error
      ? "failed"
      : controller
        ? "ready"
        : "initializing";
  const contextValue = useMemo<EditorInstanceContextValue>(
    () => ({
      status,
      controller,
      error,
      retry,
      store,
      hostServices,
      collaborationStatus,
      collaborationPresences,
      collaboration: collaboration ?? null,
    }),
    [
      collaborationPresences,
      collaborationStatus,
      collaboration,
      controller,
      error,
      hostServices,
      retry,
      status,
      store,
    ],
  );
  return <editorContext.Provider value={contextValue}>{children}</editorContext.Provider>;
}
