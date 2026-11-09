import { useEffect, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import {
  EditorCollaborationIndicator,
  EditorShell,
  type EditorReplacementReviewProps,
} from '@zhishu/editor-ui';
import {
  EditorProvider,
  useEditorCollaborationPresences,
  useEditorCollaborationStatus,
  useEditorInstance,
  type EditorCollaborationPresence,
} from '@zhishu/editor-react';

export function DocumentEditorLoading({ editingControls = true }: { editingControls?: boolean }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <EditorProvider loading>
        <DocumentEditorShell ariaLabel="文档编辑器" editingControls={editingControls} />
      </EditorProvider>
    </div>
  );
}

/**
 * Editor chrome shared by the collaborative editors.
 * The outline uses EditorShell's built-in floating toggle; document metadata
 * and technical details live in dialogs owned by the document pane, so the
 * shell itself renders a single clean editing surface.
 */
export function DocumentEditorShell({
  ariaLabel,
  editingControls,
  loading = false,
  className,
  footerSlot,
  onCollaborationPresenceChange,
  replacementReview,
}: {
  ariaLabel: string;
  editingControls: boolean;
  loading?: boolean;
  className?: string;
  footerSlot?: ReactNode;
  onCollaborationPresenceChange?: (participants: readonly EditorCollaborationPresence[]) => void;
  replacementReview?: EditorReplacementReviewProps;
}) {
  const collaborationStatus = useEditorCollaborationStatus();
  const collaborationPresences = useEditorCollaborationPresences();
  const { status } = useEditorInstance();
  const busy = loading || status === 'initializing';

  useEffect(() => {
    onCollaborationPresenceChange?.(collaborationPresences);
  }, [collaborationPresences, onCollaborationPresenceChange]);
  useEffect(() => () => onCollaborationPresenceChange?.([]), [onCollaborationPresenceChange]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <EditorShell
        inert={busy}
        surfaceClassName={status === 'initializing' ? 'text-transparent' : undefined}
        ariaLabel={ariaLabel}
        surfaceLabel="文档正文"
        className={['zhishu-ui-document-editor', busy && 'isolate', className]
          .filter(Boolean)
          .join(' ')}
        editingControls={editingControls}
        replacementReview={replacementReview}
        showHeader={false}
        collaborationIndicator={false}
        collaborationParticipantsCount={false}
        outline
        outlinePlacement="end"
        outlineLabel="正文大纲"
        outlineEmptyLabel="文档中暂无标题"
        contentMaxWidth={896}
        stickyToolbar
        toolbarOffset="0px"
        statisticsFooter
        find
        slashMenu
        selectionMenu
        linkEditor
        footerTrailingSlot={
          collaborationStatus ? <EditorCollaborationIndicator status={collaborationStatus} /> : null
        }
        footerSlot={footerSlot}
      />
      {busy && (
        <div
          role="status"
          className="absolute inset-0 z-10 grid place-items-center bg-background/40 backdrop-blur-xs"
        >
          <span className="inline-flex items-center gap-2 rounded-full border bg-background/90 px-4 py-2 text-sm text-muted-foreground shadow-sm">
            <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden="true" />
            正在打开文档…
          </span>
        </div>
      )}
    </div>
  );
}
