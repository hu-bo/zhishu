import type { EditorController } from "@zhishu/editor-core";

export type MarkActivity = boolean | "mixed";

export interface EditorStoreSnapshot {
  status: "initializing" | "ready" | "failed" | "disposed";
  revision: number;
  isEditable: boolean;
  readOnlyReason?: string;
  canUndo: boolean;
  canRedo: boolean;
  selection: { from: number; to: number; empty: boolean } | null;
  formatting: {
    bold: MarkActivity;
    italic: MarkActivity;
    strike: MarkActivity;
    code: MarkActivity;
  };
}

function getMarkActivity(controller: EditorController, markName: string): MarkActivity {
  const { editor } = controller;
  const selection = editor.state.selection;
  if (selection.empty) return editor.isActive(markName);

  let hasMarkedText = false;
  let hasUnmarkedText = false;
  editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (!node.isText) return;
    if (node.marks.some((mark) => mark.type.name === markName)) hasMarkedText = true;
    else hasUnmarkedText = true;
  });

  if (hasMarkedText && hasUnmarkedText) return "mixed";
  return hasMarkedText;
}

const initialSnapshot: EditorStoreSnapshot = {
  status: "initializing",
  revision: 0,
  isEditable: false,
  canUndo: false,
  canRedo: false,
  selection: null,
  formatting: { bold: false, italic: false, strike: false, code: false },
};

export class EditorStore {
  private snapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeController?: () => void;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): EditorStoreSnapshot => this.snapshot;

  setStatus(status: EditorStoreSnapshot["status"]): void {
    this.publish({ ...this.snapshot, status, revision: this.snapshot.revision + 1 });
  }

  bind(controller: EditorController): () => void {
    this.unsubscribeController?.();
    const refresh = () => {
      const selection = controller.editor.state.selection;
      this.publish({
        status: "ready",
        revision: this.snapshot.revision + 1,
        isEditable: controller.isEditable,
        readOnlyReason: controller.readonlyReason,
        canUndo: controller.canExecute("undo").allowed,
        canRedo: controller.canExecute("redo").allowed,
        selection: { from: selection.from, to: selection.to, empty: selection.empty },
        formatting: {
          bold: getMarkActivity(controller, "bold"),
          italic: getMarkActivity(controller, "italic"),
          strike: getMarkActivity(controller, "strike"),
          code: getMarkActivity(controller, "code"),
        },
      });
    };
    this.unsubscribeController = controller.subscribe(refresh);
    refresh();
    return () => {
      this.unsubscribeController?.();
      this.unsubscribeController = undefined;
    };
  }

  refresh(controller: EditorController): void {
    const selection = controller.editor.state.selection;
    this.publish({
      status: "ready",
      revision: this.snapshot.revision + 1,
      isEditable: controller.isEditable,
      readOnlyReason: controller.readonlyReason,
      canUndo: controller.canExecute("undo").allowed,
      canRedo: controller.canExecute("redo").allowed,
      selection: { from: selection.from, to: selection.to, empty: selection.empty },
      formatting: {
        bold: getMarkActivity(controller, "bold"),
        italic: getMarkActivity(controller, "italic"),
        strike: getMarkActivity(controller, "strike"),
        code: getMarkActivity(controller, "code"),
      },
    });
  }

  dispose(): void {
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    this.setStatus("disposed");
  }

  private publish(next: EditorStoreSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
