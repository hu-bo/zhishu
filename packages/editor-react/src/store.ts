import {
  calculateDocumentStatistics,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  type DocumentStatistics,
} from "@zhishu/editor-core";
import type { EditorCapability, EditorController } from "@zhishu/editor-core";

export type MarkActivity = boolean | "mixed";
function statisticsText(doc: EditorController["editor"]["state"]["doc"]): string {
  return doc.textBetween(0, doc.content.size, "\n", (node) => {
    if (node.type.name === "statusTag") {
      const status = DOCUMENT_STATUSES.find((value) => value === node.attrs.status) ?? "todo";
      return DOCUMENT_STATUS_LABELS[status];
    }
    if (node.type.name === "horizontalRule" && typeof node.attrs.label === "string")
      return node.attrs.label;
    return "\n";
  });
}
export interface EditorListState {
  bullet: MarkActivity;
  ordered: MarkActivity;
}

export interface EditorStoreSnapshot {
  status: "initializing" | "ready" | "failed" | "disposed";
  revision: number;
  isEditable: boolean;
  readOnlyReason?: string;
  canUndo: boolean;
  canRedo: boolean;
  selection: { from: number; to: number; empty: boolean } | null;
  block: { type: string | "mixed"; alignment: string | null | "mixed" } | null;
  list: EditorListState;
  table: { rows: number; columns: number } | null;
  formatting: {
    bold: MarkActivity;
    italic: MarkActivity;
    strike: MarkActivity;
    underline: MarkActivity;
    code: MarkActivity;
    highlight: MarkActivity;
  };
  highlightColor: string | null | "mixed";
  capabilities: {
    write: EditorCapability;
    blockStructure: EditorCapability;
    tableStructure: EditorCapability;
  };
  statistics: DocumentStatistics;
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

function getBlockState(controller: EditorController): EditorStoreSnapshot["block"] {
  const { editor } = controller;
  const selection = editor.state.selection;
  const blockTypes = new Set<string>();
  const alignments = new Set<string | null>();
  const addBlock = (node: typeof editor.state.doc) => {
    if (!node.isTextblock) return;
    const alignment = node.attrs.align;
    blockTypes.add(
      node.type.name === "heading"
        ? `heading-${typeof node.attrs.level === "number" ? node.attrs.level : 1}`
        : node.type.name,
    );
    alignments.add(typeof alignment === "string" ? alignment : null);
  };

  if (selection.empty) addBlock(selection.$from.parent);
  else {
    editor.state.doc.nodesBetween(selection.from, selection.to, (node) => {
      addBlock(node);
    });
  }

  if (blockTypes.size === 0) return null;
  return {
    type: blockTypes.size > 1 ? "mixed" : (blockTypes.values().next().value ?? "mixed"),
    alignment: alignments.size > 1 ? "mixed" : (alignments.values().next().value ?? null),
  };
}

function getListState(controller: EditorController): EditorListState {
  const { doc, selection } = controller.editor.state;
  const lists = new Set<"bullet" | "ordered" | null>();
  const addAt = (position: number) => {
    const $position = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
    for (let depth = $position.depth; depth > 0; depth -= 1) {
      const name = $position.node(depth).type.name;
      if (name === "bulletList") {
        lists.add("bullet");
        return;
      }
      if (name === "orderedList") {
        lists.add("ordered");
        return;
      }
    }
    lists.add(null);
  };

  if (selection.empty) addAt(selection.from);
  else {
    addAt(selection.from);
    doc.nodesBetween(selection.from, selection.to, (node, position) => {
      if (node.isTextblock) addAt(position + 1);
      if (node.type.name === "bulletList") lists.add("bullet");
      if (node.type.name === "orderedList") lists.add("ordered");
    });
  }
  const mixed = lists.size > 1;
  return {
    bullet: lists.has("bullet") ? (mixed ? "mixed" : true) : false,
    ordered: lists.has("ordered") ? (mixed ? "mixed" : true) : false,
  };
}

function getHighlightColor(controller: EditorController): string | null | "mixed" {
  const { editor } = controller;
  const selection = editor.state.selection;
  const colors = new Set<string>();
  const addColors = (node: typeof editor.state.doc) => {
    if (!node.isText) return;
    for (const mark of node.marks) {
      if (mark.type.name === "highlight" && typeof mark.attrs.color === "string") {
        colors.add(mark.attrs.color);
      }
    }
  };
  if (selection.empty) {
    const mark = editor.state.storedMarks?.find((item) => item.type.name === "highlight");
    const active = mark ?? selection.$from.marks().find((item) => item.type.name === "highlight");
    return typeof active?.attrs.color === "string" ? active.attrs.color : null;
  }
  editor.state.doc.nodesBetween(selection.from, selection.to, addColors);
  if (colors.size > 1) return "mixed";
  return colors.values().next().value ?? null;
}

const initialSnapshot: EditorStoreSnapshot = {
  status: "initializing",
  revision: 0,
  isEditable: false,
  canUndo: false,
  canRedo: false,
  selection: null,
  block: null,
  list: { bullet: false, ordered: false },
  table: null,
  formatting: {
    bold: false,
    italic: false,
    strike: false,
    underline: false,
    code: false,
    highlight: false,
  },
  highlightColor: null,
  capabilities: {
    write: { allowed: false, reason: "destroyed" },
    blockStructure: { allowed: false, reason: "destroyed" },
    tableStructure: { allowed: false, reason: "destroyed" },
  },
  statistics: { wordCount: 0, characterCount: 0, readingTimeMinutes: 0 },
};

export class EditorStore {
  private snapshot = initialSnapshot;
  private readonly listeners = new Set<() => void>();
  private unsubscribeController?: () => void;
  private statisticsTimer?: ReturnType<typeof setTimeout>;

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
    if (this.statisticsTimer) clearTimeout(this.statisticsTimer);
    this.statisticsTimer = undefined;
    const refresh = (statistics = this.snapshot.statistics) => {
      const selection = controller.editor.state.selection;
      this.publish({
        status: "ready",
        revision: this.snapshot.revision + 1,
        isEditable: controller.isEditable,
        readOnlyReason: controller.readonlyReason,
        canUndo: controller.canExecute("undo").allowed,
        canRedo: controller.canExecute("redo").allowed,
        selection: { from: selection.from, to: selection.to, empty: selection.empty },
        block: getBlockState(controller),
        list: getListState(controller),
        table: controller.getTableDimensions(),
        formatting: {
          bold: getMarkActivity(controller, "bold"),
          italic: getMarkActivity(controller, "italic"),
          strike: getMarkActivity(controller, "strike"),
          underline: getMarkActivity(controller, "underline"),
          code: getMarkActivity(controller, "code"),
          highlight: getMarkActivity(controller, "highlight"),
        },
        highlightColor: getHighlightColor(controller),
        capabilities: {
          write: controller.canExecute("write"),
          blockStructure: controller.canExecute("block-structure"),
          tableStructure: controller.canExecute("table-structure"),
        },
        statistics,
      });
    };
    const recomputeStatistics = () => {
      if (this.statisticsTimer) clearTimeout(this.statisticsTimer);
      this.statisticsTimer = setTimeout(() => {
        this.statisticsTimer = undefined;
        if (controller.isDestroyed) return;
        const doc = controller.editor.state.doc;
        refresh(calculateDocumentStatistics(statisticsText(doc)));
      }, 160);
    };
    const releaseController = controller.subscribe((event) => {
      refresh();
      if (event.docChanged) recomputeStatistics();
    });
    this.unsubscribeController = releaseController;
    const initialDoc = controller.editor.state.doc;
    refresh(calculateDocumentStatistics(statisticsText(initialDoc)));
    return () => {
      releaseController();
      if (this.unsubscribeController === releaseController) {
        this.unsubscribeController = undefined;
        if (this.statisticsTimer) clearTimeout(this.statisticsTimer);
        this.statisticsTimer = undefined;
      }
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
      block: getBlockState(controller),
      list: getListState(controller),
      table: controller.getTableDimensions(),
      formatting: {
        bold: getMarkActivity(controller, "bold"),
        italic: getMarkActivity(controller, "italic"),
        strike: getMarkActivity(controller, "strike"),
        underline: getMarkActivity(controller, "underline"),
        code: getMarkActivity(controller, "code"),
        highlight: getMarkActivity(controller, "highlight"),
      },
      highlightColor: getHighlightColor(controller),
      capabilities: {
        write: controller.canExecute("write"),
        blockStructure: controller.canExecute("block-structure"),
        tableStructure: controller.canExecute("table-structure"),
      },
      statistics: this.snapshot.statistics,
    });
  }

  dispose(): void {
    this.unsubscribeController?.();
    this.unsubscribeController = undefined;
    if (this.statisticsTimer) clearTimeout(this.statisticsTimer);
    this.statisticsTimer = undefined;
    this.setStatus("disposed");
  }

  private publish(next: EditorStoreSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
