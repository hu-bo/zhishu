import { useEffect, useRef, useState } from "react";
import type { EditorController, EditorStructureAction } from "@zhishu/editor-core";
import type { OperationBatch } from "@zhishu/document-contracts";
import { useEditorInstance, type EditorCollaborationSession } from "./context.js";

/** Keeps one prepared batch for an uncertain network retry; conflicts require a fresh action. */
export function useEditorStructureAction() {
  const { controller, collaboration, collaborationStatus, hostServices } = useEditorInstance();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{
    controller: EditorController;
    session: EditorCollaborationSession | null;
    batch: OperationBatch;
    baseStructureRevision?: number;
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  useEffect(() => {
    mounted.current = true;
    pending.current = null;
    inFlight.current = false;
    setBusy(false);
    setError(null);
    return () => {
      lifecycle.current += 1;
      mounted.current = false;
      pending.current = null;
    };
  }, [controller, collaboration]);
  const allowed = Boolean(
    controller?.canExecute("write").allowed &&
    (collaboration
      ? !collaboration.readOnly &&
        collaborationStatus?.connection === "connected" &&
        collaborationStatus.sync === "current" &&
        collaboration.submitStructureOperation &&
        collaboration.getStructureRevision
      : controller.canExecute("block-structure").allowed),
  );

  async function submit(prepared: NonNullable<typeof pending.current>): Promise<boolean> {
    if (
      !allowed ||
      inFlight.current ||
      prepared.controller !== controller ||
      prepared.session !== collaboration
    )
      return false;
    const scope = lifecycle.current;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (prepared.session?.submitStructureOperation) {
        const result = await prepared.session.submitStructureOperation(
          prepared.batch,
          prepared.baseStructureRevision,
        );
        if (!mounted.current || lifecycle.current !== scope) return false;
        if (result.status !== "accepted" && result.status !== "duplicate") {
          pending.current = null;
          throw new Error("内容已变化或操作被拒绝，请重新选择后操作。");
        }
      } else {
        const result = prepared.controller.applyOperations(prepared.batch);
        if (!result.success) {
          pending.current = null;
          throw new Error("当前内容无法执行此操作，请重新选择。");
        }
      }
      pending.current = null;
      return true;
    } catch {
      if (mounted.current && lifecycle.current === scope) {
        const message = pending.current
          ? "操作尚未确认，可以重试。"
          : "内容已变化或操作被拒绝，请重新选择后操作。";
        setError(message);
        hostServices.reportError?.(new Error(message));
      }
      return false;
    } finally {
      if (lifecycle.current === scope) {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  }

  async function run(action: EditorStructureAction): Promise<boolean> {
    if (!controller || !allowed || inFlight.current || pending.current) return false;
    const prepared = controller.prepareStructureAction(action);
    if (!prepared.success) {
      setError("当前选区无法执行此操作。");
      return false;
    }
    const request = {
      controller,
      session: collaboration,
      batch: prepared.batch,
      ...(collaboration ? { baseStructureRevision: collaboration.getStructureRevision?.() } : {}),
    };
    pending.current = request;
    return submit(request);
  }

  return {
    run,
    busy,
    error,
    allowed,
    retry: () => (pending.current ? submit(pending.current) : Promise.resolve(false)),
    canRetry: Boolean(error && pending.current),
    dismissError: () => {
      if (!inFlight.current) {
        pending.current = null;
        setError(null);
      }
    },
  };
}
