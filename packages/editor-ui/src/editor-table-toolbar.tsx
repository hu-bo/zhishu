import { useState } from "react";
import type { EditorTableCommand } from "@zhishu/editor-core";
import { useEditorInstance, useEditorSelector } from "@zhishu/editor-react";

export interface EditorTableToolbarMessages {
  label: string;
  rowsAndColumns: (rows: number, columns: number) => string;
  addRowBefore: string;
  addRowAfter: string;
  deleteRow: string;
  addColumnBefore: string;
  addColumnAfter: string;
  deleteColumn: string;
  toggleHeaderRow: string;
  mergeCells: string;
  splitCell: string;
  operationFailed: string;
  readOnly: string;
  rowLimit: string;
  columnLimit: string;
  selectCellsToMerge: string;
  cellCannotSplit: string;
  unsupportedSelection: string;
}

const defaultMessages: EditorTableToolbarMessages = {
  label: "表格操作",
  rowsAndColumns: (rows, columns) => `${rows} 行 · ${columns} 列`,
  addRowBefore: "上方插入行",
  addRowAfter: "下方插入行",
  deleteRow: "删除当前行",
  addColumnBefore: "左侧插入列",
  addColumnAfter: "右侧插入列",
  deleteColumn: "删除当前列",
  toggleHeaderRow: "切换表头行",
  mergeCells: "合并单元格",
  splitCell: "拆分单元格",
  operationFailed: "表格操作未执行，请调整选区后重试。",
  readOnly: "当前为只读，无法修改表格。",
  rowLimit: "表格最多 100 行。",
  columnLimit: "表格最多 20 列。",
  selectCellsToMerge: "请先选中多个相邻单元格。",
  cellCannotSplit: "当前单元格无法拆分。",
  unsupportedSelection: "当前选区不支持此操作。",
};

const commands: Array<{ command: EditorTableCommand; message: keyof EditorTableToolbarMessages }> =
  [
    { command: "addRowBefore", message: "addRowBefore" },
    { command: "addRowAfter", message: "addRowAfter" },
    { command: "deleteRow", message: "deleteRow" },
    { command: "addColumnBefore", message: "addColumnBefore" },
    { command: "addColumnAfter", message: "addColumnAfter" },
    { command: "deleteColumn", message: "deleteColumn" },
    { command: "toggleHeaderRow", message: "toggleHeaderRow" },
    { command: "mergeCells", message: "mergeCells" },
    { command: "splitCell", message: "splitCell" },
  ];

export function EditorTableToolbar({
  messages,
}: {
  messages?: Partial<EditorTableToolbarMessages>;
}) {
  const { controller } = useEditorInstance();
  const table = useEditorSelector((snapshot) => snapshot.table);
  const tableStructure = useEditorSelector((snapshot) => snapshot.capabilities.tableStructure);
  const [feedback, setFeedback] = useState("");
  const labels = { ...defaultMessages, ...messages };

  if (!controller || !table) return null;

  const getDisabledReason = (command: EditorTableCommand): string | undefined => {
    if (!tableStructure.allowed) return labels.readOnly;
    if ((command === "addRowBefore" || command === "addRowAfter") && table.rows >= 100) {
      return labels.rowLimit;
    }
    if ((command === "addColumnBefore" || command === "addColumnAfter") && table.columns >= 20) {
      return labels.columnLimit;
    }
    if (controller.canRunTableCommand(command)) return undefined;
    if (command === "mergeCells") return labels.selectCellsToMerge;
    if (command === "splitCell") return labels.cellCannotSplit;
    return labels.unsupportedSelection;
  };

  return (
    <details className="zhishu-ui-table-toolbar">
      <summary aria-label={labels.label} title={labels.label}>
        <span>{labels.label}</span>
        <span className="zhishu-ui-table-toolbar-dimensions">
          {labels.rowsAndColumns(table.rows, table.columns)}
        </span>
      </summary>
      <div className="zhishu-ui-table-toolbar-panel" role="group" aria-label={labels.label}>
        {commands.map(({ command, message }) => {
          const label = labels[message];
          if (typeof label !== "string") return null;
          const disabledReason = getDisabledReason(command);
          return (
            <button
              key={command}
              type="button"
              disabled={disabledReason !== undefined}
              title={disabledReason}
              aria-label={disabledReason ? `${label}（${disabledReason}）` : label}
              onClick={() => {
                const success = controller.runTableCommand(command);
                setFeedback(success ? `${label}已完成` : labels.operationFailed);
              }}
            >
              {label}
            </button>
          );
        })}
        {feedback && (
          <p className="zhishu-ui-table-toolbar-feedback" role="status" aria-live="polite">
            {feedback}
          </p>
        )}
      </div>
    </details>
  );
}
