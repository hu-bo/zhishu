import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getDocument } from '@/api/generated/documents';
import { hasUnconfirmedChanges } from '@/api/transport';
import { DocumentCollaborationEditor } from '@/features/document/document-collaboration-editor';
import { internalTransport } from '@/components/chat/conversation-transport';
import { ResizableSplit } from '@/components/layout/resizable-split';
import { AssistantChat } from './assistant-chat';
import { EditorProposalReview, type PendingProposal } from './editor-proposal-review';

const transport = internalTransport();

/**
 * Independent creation workbench. Before a draft is bound the page is a full-width Chat;
 * once the server confirms a target document the same conversation moves to the right of a
 * real collaborative editor. Layout derives from the server target fact, never local draft
 * text. On narrow screens a document/chat toggle keeps the editor (and its collaboration
 * provider) mounted so switching never rebuilds the session or loses unconfirmed updates.
 */
export function CreationPage({
  sourceWorkspaceId,
  contextDocumentId,
  targetDocumentId,
}: {
  sourceWorkspaceId?: string;
  contextDocumentId?: string;
  targetDocumentId?: string;
}) {
  const search = useSearch({ from: '/_app/ai' });
  const [boundTarget, setBoundTarget] = useState<string | null>(targetDocumentId ?? null);
  const [mobileView, setMobileView] = useState<'chat' | 'document'>('chat');
  const [pendingProposal, setPendingProposal] = useState<PendingProposal | null>(null);
  const selectionRef = useRef<string[]>([]);

  const document = useQuery({
    queryKey: ['document', boundTarget],
    queryFn: () => getDocument(boundTarget!),
    enabled: !!boundTarget,
  });

  const editorContext = useCallback(
    () =>
      boundTarget
        ? {
            documentId: boundTarget,
            selectionBlockIds: selectionRef.current,
            hasUnconfirmedChanges: () => hasUnconfirmedChanges(),
          }
        : null,
    [boundTarget],
  );

  const initialScope = useMemo(
    () =>
      contextDocumentId
        ? { kind: 'documents' as const, documentIds: [contextDocumentId] }
        : { kind: 'all' as const },
    [contextDocumentId],
  );

  const onTargetChange = useCallback((next: string | null) => {
    setBoundTarget(next);
    if (next) setMobileView('document');
  }, []);

  const chat = (
    <AssistantChat
      transport={transport}
      mode="internal"
      scopeKey={[sourceWorkspaceId ?? '', contextDocumentId ?? '', search.conversationId ?? '']}
      initialScope={initialScope}
      initialConversationId={search.conversationId}
      initialTargetDocumentId={targetDocumentId ?? null}
      getEditorContext={editorContext}
      documentLabel={
        contextDocumentId
          ? { documentId: contextDocumentId, title: document.data?.title ?? '当前文档' }
          : undefined
      }
      onTargetChange={onTargetChange}
      onOpenTarget={() => setMobileView('document')}
      onPendingProposalChange={setPendingProposal}
      className="assistant-chat-pane"
    />
  );

  const editor = document.data ? (
    <DocumentCollaborationEditor
      document={document.data}
      viewMode="edit"
      versionsOpen={false}
      onVersionsOpenChange={() => undefined}
      onSelectionBlocksChange={(ids) => {
        selectionRef.current = ids;
      }}
      replacementReview={
        pendingProposal ? (
          <EditorProposalReview transport={transport} proposal={pendingProposal} />
        ) : null
      }
    />
  ) : (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500" role="status">
      正在载入文档…
    </div>
  );

  // One stable tree for both layouts: the chat pane never unmounts when a target binds or
  // unbinds, so the conversation, in-flight runs and drafts survive the layout switch.
  return (
    <div
      className={`assistant-workbench${boundTarget ? ' assistant-split' : ' assistant-chat-only'}`}
    >
      <div className="assistant-mobile-toggle" role="tablist" hidden={!boundTarget}>
        <button
          role="tab"
          aria-selected={mobileView === 'document'}
          className={mobileView === 'document' ? 'active' : ''}
          onClick={() => setMobileView('document')}
        >
          文档
        </button>
        <button
          role="tab"
          aria-selected={mobileView === 'chat'}
          className={mobileView === 'chat' ? 'active' : ''}
          onClick={() => setMobileView('chat')}
        >
          对话
        </button>
      </div>
      <ResizableSplit
        storageKey="zhishu.ai-split-right-width"
        initialWidth={420}
        minWidth={400}
        maxWidth={800}
        leftClassName={mobileView === 'document' ? 'mobile-active' : undefined}
        rightClassName={mobileView === 'chat' ? 'mobile-active' : undefined}
        left={
          <section className="assistant-editor-pane" hidden={!boundTarget}>
            {editor}
          </section>
        }
        right={<aside className="assistant-chat-pane">{chat}</aside>}
      />
    </div>
  );
}
