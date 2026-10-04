import type { ReactNode } from 'react';
import { EditorProvider } from '@zhishu/editor-react';
import type { EditorHostServices } from '@zhishu/editor-react';
import { defaultEditorNodeViews, EditorShell } from '@zhishu/editor-ui';

export interface DocumentReadonlyViewProps {
  /** Stable key for this snapshot; the editor instance remounts when it changes. */
  instanceKey: string;
  content: unknown;
  readOnlyReason?: string;
  ariaLabel: string;
  surfaceLabel?: string;
  /** Extra classes on the EditorShell root (sizing / chrome overrides). */
  className?: string;
  toolbar?: ReactNode;
  /**
   * EditorShell gates the toolbar row behind this flag; keep it on when a
   * toolbar label should show (history preview), turn it off for chrome-free
   * readers (public share page).
   */
  editingControls?: boolean;
  hostServices?: EditorHostServices;
}

/**
 * Read-only document surface shared by the history preview and the public
 * share reader: a non-editable editor instance with outline, find and stats.
 */
export function DocumentReadonlyView({
  instanceKey,
  content,
  readOnlyReason,
  ariaLabel,
  surfaceLabel,
  className,
  toolbar,
  editingControls = true,
  hostServices,
}: DocumentReadonlyViewProps) {
  return (
    <EditorProvider
      key={instanceKey}
      instanceKey={instanceKey}
      options={{
        documentId: instanceKey,
        content,
        editable: false,
        ...(readOnlyReason ? { readOnlyReason } : {}),
      }}
      editable={false}
      readOnlyReason={readOnlyReason}
      nodeViews={defaultEditorNodeViews}
      hostServices={hostServices}
    >
      <EditorShell
        className={className}
        ariaLabel={ariaLabel}
        surfaceLabel={surfaceLabel}
        surfaceClassName="overflow-y-auto overscroll-contain"
        compact
        contentMaxWidth={896}
        outline
        outlinePlacement="end"
        statisticsFooter
        find
        editingControls={editingControls}
        toolbar={toolbar}
      />
    </EditorProvider>
  );
}
