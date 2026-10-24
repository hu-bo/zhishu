import { useCallback, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, LoaderCircle } from 'lucide-react';
import {
  getDocument,
  locateDocument,
  trashDocument,
  updateDocumentMetadata,
} from '@/api/generated/app-api';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import type { EditorCollaborationPresence } from '@zhishu/editor-react';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PanelDialog } from '@/components/ui/panel-dialog';
import type { CatalogAction } from '@/features/knowledge/catalog-dialogs';
import { invalidateSpaceData } from '@/features/knowledge/space-data';
import {
  DocumentCollaborationEditor,
  type DocumentCollaborationSnapshot,
} from './document-collaboration-editor';
import { DocumentInfoDialog } from './document-info-dialog';
import { DocumentMetadata } from './document-metadata';
import { DocumentShareDialog } from './document-share-dialog';
import { DocumentTopbar } from './document-topbar';
import { DocumentTransferActions } from './document-transfer-actions';

export interface DocumentPaneProps {
  documentId: string;
  workspaceId: string;
  rootCatalogId: string;
  identityKey: string;
  workspaceName: string;
  workspaceMemberCount: number;
  canManageWorkspace: boolean;
  onlineCount: number;
  onOpenMembers: () => void;
  onOpenWorkspaceSettings: () => void;
  onOpenDirectory: () => void;
  onOnlineCountChange?: (count: number) => void;
  onBack: () => void;
  onOpenCatalog: (catalogId: string) => void;
  onAction: (action: CatalogAction) => void;
}

/**
 * Editing surface for `/spaces/$workspaceId/doc/$documentId`: one slim topbar plus the
 * editor. Metadata, details, sharing, import/export and trash all live in
 * dialogs owned here.
 */
export function DocumentPane({
  documentId,
  workspaceId,
  rootCatalogId,
  identityKey,
  workspaceName,
  workspaceMemberCount,
  canManageWorkspace,
  onlineCount,
  onOpenMembers,
  onOpenWorkspaceSettings,
  onOpenDirectory,
  onOnlineCountChange,
  onBack,
  onOpenCatalog,
  onAction,
}: DocumentPaneProps) {
  const queryClient = useQueryClient();
  const { workspaces } = useKnowledgeWorkspace();
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const personalTarget = workspace?.kind === 'personal' && workspace.role === 'owner';
  const noRetryOn404 = (count: number, error: unknown) =>
    !(error instanceof ApiError && error.status === 404) && count < 2;

  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: ({ signal }) => getDocument(documentId, { signal }),
    retry: noRetryOn404,
  });
  const locate = useQuery({
    queryKey: ['document-locate', identityKey, documentId],
    queryFn: ({ signal }) => locateDocument(documentId, { signal }),
    staleTime: 30_000,
    retry: noRetryOn404,
  });

  const viewStorageKey = `zhishu.document-view.${documentId}`;
  const [viewMode, setViewMode] = useState<'edit' | 'read'>(() => {
    try {
      return localStorage.getItem(viewStorageKey) === 'read' ? 'read' : 'edit';
    } catch {
      return 'edit';
    }
  });
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(() =>
    viewMode === 'read' ? '当前为阅读模式。' : null,
  );
  const toggleViewMode = () =>
    setViewMode((previous) => {
      const next = previous === 'edit' ? 'read' : 'edit';
      try {
        localStorage.setItem(viewStorageKey, next);
      } catch {
        /* Preference applies for this session only. */
      }
      return next;
    });

  const [versionsOpen, setVersionsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [collabSnapshot, setCollabSnapshot] = useState<DocumentCollaborationSnapshot | null>(null);
  const onCollaborationPresenceChange = useCallback(
    (participants: readonly EditorCollaborationPresence[]) =>
      onOnlineCountChange?.(participants.length),
    [onOnlineCountChange],
  );

  const document = documentQuery.data;
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  const saveTitle = async (nextTitle: string) => {
    if (!document || !nextTitle || nextTitle === document.title) return;
    setTitleSaving(true);
    setTitleError(null);
    try {
      const updated = await updateDocumentMetadata(documentId, {
        title: nextTitle,
        metadataRevision: document.metadataRevision,
      });
      queryClient.setQueryData(['document', documentId], updated);
      invalidateSpaceData(queryClient, identityKey, workspaceId);
    } catch (cause) {
      setTitleError(errorMessage(cause));
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
    } finally {
      setTitleSaving(false);
    }
  };

  if (documentQuery.isPending) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
        正在加载文档…
      </div>
    );
  }

  if (documentQuery.isError || !document) {
    const missing = documentQuery.error instanceof ApiError && documentQuery.error.status === 404;
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border bg-card px-6 py-12 text-center">
          <AlertCircle
            className="mx-auto mb-4 text-muted-foreground"
            size={30}
            aria-hidden="true"
          />
          <h2 className="text-lg font-semibold">{missing ? '无法打开这篇文档' : '文档加载失败'}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {missing ? '文档不存在，或你没有访问权限。' : errorMessage(documentQuery.error)}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Button variant="outline" onClick={onBack}>
              返回目录
            </Button>
            {!missing && <Button onClick={() => void documentQuery.refetch()}>重试</Button>}
          </div>
        </div>
      </div>
    );
  }

  const catalogPath =
    locate.data?.catalogPath.filter((segment) => segment.id !== rootCatalogId) ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <DocumentTopbar
        aiEntry={
          <Link
            to="/ai"
            search={{
              sourceWorkspaceId: workspaceId,
              contextDocumentId: documentId,
              targetDocumentId: personalTarget ? documentId : undefined,
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={personalTarget ? 'AI 创作' : '讨论与创作'}
          >
            <Sparkles size={14} />
            <span className="hidden xl:inline">{personalTarget ? 'AI 创作' : '讨论与创作'}</span>
          </Link>
        }
        workspaceName={workspaceName}
        workspaceMemberCount={workspaceMemberCount}
        canManageWorkspace={canManageWorkspace}
        onlineCount={onlineCount}
        onOpenMembers={onOpenMembers}
        onOpenWorkspaceSettings={onOpenWorkspaceSettings}
        onOpenDirectory={onOpenDirectory}
        catalogPath={catalogPath}
        title={document.title}
        icon={document.icon}
        canManage={document.canManage}
        readOnlyReason={viewMode === 'read' ? '当前为阅读模式。' : readOnlyReason}
        titleSaving={titleSaving}
        onTitleSave={(nextTitle) => void saveTitle(nextTitle)}
        viewMode={viewMode}
        onViewModeToggle={toggleViewMode}
        onBack={onBack}
        onOpenWorkspaceRoot={onBack}
        onOpenCatalog={onOpenCatalog}
        onShare={() => setShareOpen(true)}
        onVersions={() => setVersionsOpen(true)}
        onTransfer={() => setTransferOpen(true)}
        onMetadata={() => setMetadataOpen(true)}
        onInfo={() => setInfoOpen(true)}
        onMove={() =>
          onAction({
            kind: 'move-document',
            document: {
              id: document.id,
              title: document.title,
              metadataRevision: document.metadataRevision,
            },
          })
        }
        onTrash={() => setTrashOpen(true)}
      />
      {titleError && (
        <p
          role="alert"
          className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-xs text-destructive"
        >
          标题保存失败：{titleError}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        <DocumentCollaborationEditor
          key={`collaborative-${document.generationId}`}
          document={document}
          viewMode={viewMode}
          onStatusChange={setCollabSnapshot}
          onReadOnlyReasonChange={setReadOnlyReason}
          onCollaborationPresenceChange={onCollaborationPresenceChange}
          versionsOpen={versionsOpen}
          onVersionsOpenChange={setVersionsOpen}
        />
      </div>

      <DocumentShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        documentId={documentId}
        canManage={document.canManage}
      />
      <PanelDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        title="导入导出"
        description="在本地文件与这篇文档之间交换内容。"
      >
        <DocumentTransferActions documentId={documentId} title={document.title} />
      </PanelDialog>
      <PanelDialog
        open={metadataOpen}
        onOpenChange={setMetadataOpen}
        title="图标与标签"
        description="为文档添上专属标记，让内容更容易辨认与查找。"
      >
        <DocumentMetadata document={document} editable={document.canManage} />
      </PanelDialog>
      <DocumentInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        document={document}
        snapshot={collabSnapshot}
      />
      <ConfirmDialog
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title="把这篇文档移入回收站？"
        description="文档会离开目录，稍后可以在工作台的回收站中还原。"
        confirmLabel="移入回收站"
        destructive
        onConfirm={async () => {
          await trashDocument(documentId);
          invalidateSpaceData(queryClient, identityKey, workspaceId);
          void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
          onBack();
        }}
      />
    </div>
  );
}
