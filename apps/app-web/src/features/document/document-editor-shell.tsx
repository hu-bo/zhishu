import { useState, type ReactNode } from 'react';
import { EditorShell } from '@zhishu/editor-ui';

/**
 * Editor chrome shared by the standard and collaborative editors.
 * The outline uses EditorShell's built-in floating toggle; document metadata
 * and technical details live in dialogs owned by the document pane, so the
 * shell itself renders a single clean editing surface.
 */
export function DocumentEditorShell({
  ariaLabel,
  editingControls,
  footerSlot,
}: {
  ariaLabel: string;
  editingControls: boolean;
  footerSlot?: ReactNode;
}) {
  const [celebration, setCelebration] = useState(() => {
    try {
      return localStorage.getItem('zhishu.task-celebration') === 'true';
    } catch {
      return false;
    }
  });
  return (
    <EditorShell
      ariaLabel={ariaLabel}
      surfaceLabel="文档正文"
      editingControls={editingControls}
      taskCelebration={celebration}
      outline
      outlinePlacement="end"
      outlineLabel="正文大纲"
      outlineEmptyLabel="文档中暂无标题"
      contentMaxWidth={896}
      stickyToolbar
      toolbarOffset="0px"
      statisticsFooter
      find
      blockMenu
      slashMenu
      selectionMenu
      linkEditor
      footerSlot={
        <div className="flex flex-wrap items-center justify-between gap-3">
          {footerSlot}
          {editingControls && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={celebration}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setCelebration(enabled);
                  try {
                    localStorage.setItem('zhishu.task-celebration', String(enabled));
                  } catch {
                    /* Preference applies for this session. */
                  }
                }}
              />
              任务完成动效
            </label>
          )}
        </div>
      }
    />
  );
}
