import { useEffect, type ReactNode } from 'react';
import {
  EditorCollaborationIndicator,
  EditorShell,
  type EditorReplacementReviewProps,
} from '@zhishu/editor-ui';
import {
  useEditorCollaborationPresences,
  useEditorCollaborationStatus,
  type EditorCollaborationPresence,
} from '@zhishu/editor-react';

/**
 * Editor chrome shared by the collaborative editors.
 * The outline uses EditorShell's built-in floating toggle; document metadata
 * and technical details live in dialogs owned by the document pane, so the
 * shell itself renders a single clean editing surface.
 */
export function DocumentEditorShell({
  ariaLabel,
  editingControls,
  className,
  footerSlot,
  onCollaborationPresenceChange,
  replacementReview,
}: {
  ariaLabel: string;
  editingControls: boolean;
  className?: string;
  footerSlot?: ReactNode;
  onCollaborationPresenceChange?: (participants: readonly EditorCollaborationPresence[]) => void;
  replacementReview?: EditorReplacementReviewProps;
}) {
  const collaborationStatus = useEditorCollaborationStatus();
  const collaborationPresences = useEditorCollaborationPresences();

  useEffect(() => {
    onCollaborationPresenceChange?.(collaborationPresences);
  }, [collaborationPresences, onCollaborationPresenceChange]);
  useEffect(() => () => onCollaborationPresenceChange?.([]), [onCollaborationPresenceChange]);

  return (
    <EditorShell
      ariaLabel={ariaLabel}
      surfaceLabel="文档正文"
      className={['zhishu-ui-document-editor', className].filter(Boolean).join(' ')}
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
      blockMenu
      slashMenu
      selectionMenu
      linkEditor
      footerTrailingSlot={
        collaborationStatus ? <EditorCollaborationIndicator status={collaborationStatus} /> : null
      }
      footerSlot={footerSlot}
    />
  );
}
