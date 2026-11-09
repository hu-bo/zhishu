import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  FilePlus2,
  FolderKanban,
  FolderPlus,
  LoaderCircle,
  Menu,
  Users,
  Settings,
} from 'lucide-react';
import { locateDocument } from '@/api/generated/knowledge';
import { Button, buttonVariants } from '@/components/ui/button';
import { DocumentEditorLoading } from '@/features/document/document-editor-shell';
import { DocumentPane } from '@/features/document/document-pane';
import { CatalogActionDialogs, type CatalogAction } from '@/features/knowledge/catalog-dialogs';
import { CatalogBrowsePanel } from '@/features/knowledge/catalog-browse-panel';
import { CatalogTree } from '@/features/knowledge/catalog-tree';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { WorkspaceSettingsDialog } from '@/features/knowledge/workspace-settings-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export const Route = createFileRoute('/_app/spaces/$workspaceId')({
  validateSearch: (search: Record<string, unknown>): SpaceSearch => {
    const result: SpaceSearch = {};
    if (typeof search.doc === 'string' && DOCUMENT_ID_PATTERN.test(search.doc))
      result.doc = search.doc;
    if (typeof search.cat === 'string' && CATALOG_ID_PATTERN.test(search.cat))
      result.cat = search.cat;
    return result;
  },
  component: SpaceDetailRoute,
});

export type SpaceSearch = { doc?: string; cat?: string };

const DOCUMENT_ID_PATTERN = /^doc_[A-Za-z0-9_-]{1,64}$/;
const CATALOG_ID_PATTERN = /^cat_[A-Za-z0-9_-]{1,64}$/;

function SpaceDetailRoute() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const activeRoute = useRouterState({ select: (state) => state.matches.at(-1) });
  const pathParams = activeRoute?.params as { documentId?: string } | undefined;
  const documentPath =
    typeof pathParams?.documentId === 'string' && DOCUMENT_ID_PATTERN.test(pathParams.documentId);
  return (
    <SpaceDetailPageView
      workspaceId={workspaceId}
      documentId={documentPath ? pathParams?.documentId : search.doc}
      catalogId={search.cat}
      documentPath={documentPath}
      onOpenDocument={(documentId) =>
        void navigate({
          to: '/spaces/$workspaceId/doc/$documentId',
          params: { workspaceId, documentId },
          search: search.cat ? { cat: search.cat } : undefined,
        })
      }
      onCloseDocument={(catalogId) =>
        void navigate({
          to: '/spaces/$workspaceId',
          params: { workspaceId },
          search: catalogId ? { cat: catalogId } : undefined,
        })
      }
      onOpenCatalog={(catalogId) =>
        void navigate({
          to: '/spaces/$workspaceId',
          params: { workspaceId },
          search: { cat: catalogId },
        })
      }
      onCanonicalizeDocument={(targetWorkspaceId, documentId) =>
        void navigate({
          to: '/spaces/$workspaceId/doc/$documentId',
          params: { workspaceId: targetWorkspaceId, documentId },
          search: targetWorkspaceId === workspaceId && search.cat ? { cat: search.cat } : undefined,
          replace: true,
        })
      }
    />
  );
}

export interface SpaceDetailPageViewProps {
  workspaceId: string;
  documentId?: string;
  catalogId?: string;
  documentPath: boolean;
  onOpenDocument: (documentId: string) => void;
  onCloseDocument: (catalogId: string | undefined) => void;
  onOpenCatalog: (catalogId: string) => void;
  onCanonicalizeDocument: (workspaceId: string, documentId: string) => void;
}

export function SpaceDetailPageView({
  workspaceId,
  documentId: docParam,
  catalogId,
  documentPath,
  onOpenDocument,
  onCloseDocument,
  onOpenCatalog,
  onCanonicalizeDocument,
}: SpaceDetailPageViewProps) {
  const navigate = useNavigate();
  const { workspaces, identityKey, enabled, authPending, loading, failed, refreshWorkspaces } =
    useKnowledgeWorkspace();
  const [action, setAction] = useState<CatalogAction | null>(null);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'settings' | 'members' | null>(null);
  const [onlineCount, setOnlineCount] = useState(0);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const rootCatalogId = workspace?.rootCatalogId;
  const browseCatalogId = catalogId ?? rootCatalogId;

  // Locate path of the open document: feeds the tree's forced expansion so the
  // active row is visible after a deep link or search jump.
  const locate = useQuery({
    queryKey: ['document-locate', identityKey, docParam ?? ''],
    queryFn: ({ signal }) => locateDocument(docParam ?? '', { signal }),
    enabled: enabled && !!docParam,
    staleTime: 30_000,
  });
  const expandCatalogIds = docParam
    ? (locate.data?.catalogPath.map((segment) => segment.id) ?? undefined)
    : undefined;

  const documentWorkspaceId = locate.data?.workspaceId;
  useEffect(() => {
    if (!enabled || !docParam || !documentWorkspaceId) return;
    if (documentWorkspaceId !== workspaceId || !documentPath)
      onCanonicalizeDocument(documentWorkspaceId, docParam);
  }, [enabled, docParam, documentWorkspaceId, workspaceId, documentPath, onCanonicalizeDocument]);

  const closeDocument = () => onCloseDocument(browseCatalogId);
  const openCatalog = onOpenCatalog;

  if (loading || (!enabled && authPending)) {
    if (docParam) return <DocumentEditorLoading />;
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />
        {enabled ? '正在加载空间…' : '正在确认登录状态…'}
      </div>
    );
  }

  if (!enabled)
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">请登录后访问空间与文档。</div>
    );

  if (docParam && !workspace) {
    return (
      <main className="flex h-full min-h-0 min-w-0 overflow-hidden">
        <DocumentPane
          key={docParam}
          documentId={docParam}
          workspaceId={workspaceId}
          identityKey={identityKey}
          workspaceName="与我共享"
          canManageWorkspace={false}
          onlineCount={onlineCount}
          onOnlineCountChange={setOnlineCount}
          onBack={() =>
            void navigate({
              to: '/documents',
              search: { view: 'all', sort: 'updated', direction: 'desc', limit: 20, offset: 0 },
            })
          }
        />
      </main>
    );
  }

  if (failed) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6">
        <div className="rounded-2xl border bg-card px-6 py-12 text-center">
          <AlertCircle
            className="mx-auto mb-3 text-muted-foreground"
            size={28}
            aria-hidden="true"
          />
          <p className="text-sm font-medium">空间列表加载失败</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={refreshWorkspaces}>
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  if (!workspace || !rootCatalogId) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border bg-card px-6 py-12 text-center">
          <FolderKanban
            className="mx-auto mb-4 text-muted-foreground"
            size={30}
            aria-hidden="true"
          />
          <h1 className="text-lg font-semibold">空间不存在或无权访问</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            这个空间可能已被删除，或你暂时没有访问权限。
          </p>
          <Link to="/spaces" className={`${buttonVariants({ variant: 'outline' })} mt-6`}>
            <ArrowLeft size={15} aria-hidden="true" />
            返回空间列表
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!docParam && (
        <header className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-2">
          <Link
            to="/spaces"
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            aria-label="返回空间列表"
          >
            <ArrowLeft size={15} />
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            className="lg:hidden"
            aria-label="打开空间目录"
            aria-expanded={mobileTreeOpen}
            onClick={() => setMobileTreeOpen(true)}
          >
            <Menu size={16} />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {workspace.icon} {workspace.name}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`空间成员（${workspace.memberCount} 人）${onlineCount ? `，${onlineCount} 位在线` : ''}`}
            onClick={() => setSettingsTab('members')}
          >
            <Users size={15} />
            <span className="hidden sm:inline">成员</span>
            {onlineCount > 0 && (
              <span className="text-xs text-muted-foreground">{onlineCount}</span>
            )}
          </Button>
          {workspace.canManage && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="空间设置"
              onClick={() => setSettingsTab('settings')}
            >
              <Settings size={15} />
            </Button>
          )}
        </header>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="zhishu-sidebar hidden min-h-0 flex-col border-r border-border/70 lg:flex">
          <header className="flex h-15 shrink-0 items-center gap-2 border-b border-border/70 px-4">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-base"
            >
              {docParam || !workspace.icon ? (
                <FolderKanban size={15} className="text-muted-foreground" />
              ) : (
                workspace.icon
              )}
            </span>
            <h1
              className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
              title={docParam ? '目录' : workspace.name}
            >
              {docParam ? '目录' : workspace.name}
            </h1>
            {browseCatalogId && workspace.canOrganize && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="在当前目录新建文档"
                  title="新建文档"
                  onClick={() => setAction({ kind: 'create-document', catalogId: browseCatalogId })}
                >
                  <FilePlus2 size={15} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="在当前目录新建子目录"
                  title="新建目录"
                  onClick={() => setAction({ kind: 'create-catalog', parentId: browseCatalogId })}
                >
                  <FolderPlus size={15} aria-hidden="true" />
                </Button>
              </>
            )}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CatalogTree
              workspaceId={workspaceId}
              rootCatalogId={rootCatalogId}
              identityKey={identityKey}
              activeDocumentId={docParam}
              activeCatalogId={browseCatalogId}
              expandCatalogIds={expandCatalogIds}
              onOpenDocument={onOpenDocument}
              onOpenCatalog={openCatalog}
              onAction={setAction}
            />
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain">
          {docParam ? (
            <DocumentPane
              key={docParam}
              documentId={docParam}
              workspaceId={workspaceId}
              rootCatalogId={rootCatalogId}
              identityKey={identityKey}
              workspaceName={workspace.name}
              workspaceMemberCount={workspace.memberCount}
              canManageWorkspace={workspace.canManage}
              onlineCount={onlineCount}
              onOpenMembers={() => setSettingsTab('members')}
              onOpenWorkspaceSettings={() => setSettingsTab('settings')}
              onOpenDirectory={() => setMobileTreeOpen(true)}
              onOnlineCountChange={setOnlineCount}
              onBack={closeDocument}
              onOpenCatalog={openCatalog}
              onAction={setAction}
            />
          ) : browseCatalogId ? (
            <CatalogBrowsePanel
              key={browseCatalogId}
              workspaceId={workspaceId}
              catalogId={browseCatalogId}
              identityKey={identityKey}
              workspace={{
                name: workspace.name,
                icon: workspace.icon,
                canOrganize: workspace.canOrganize,
              }}
              onOpenDocument={onOpenDocument}
              onOpenCatalog={openCatalog}
              onAction={setAction}
            />
          ) : null}
        </main>
      </div>

      <Dialog open={mobileTreeOpen} onOpenChange={setMobileTreeOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{workspace.name} · 空间目录</DialogTitle>
          </DialogHeader>
          {workspace.canOrganize && browseCatalogId && (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  setMobileTreeOpen(false);
                  setAction({ kind: 'create-document', catalogId: browseCatalogId });
                }}
              >
                新建文档
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setMobileTreeOpen(false);
                  setAction({ kind: 'create-catalog', parentId: browseCatalogId });
                }}
              >
                新建目录
              </Button>
            </div>
          )}
          <CatalogTree
            workspaceId={workspaceId}
            rootCatalogId={rootCatalogId}
            identityKey={identityKey}
            activeDocumentId={docParam}
            activeCatalogId={browseCatalogId}
            expandCatalogIds={expandCatalogIds}
            onOpenDocument={(id) => {
              setMobileTreeOpen(false);
              onOpenDocument(id);
            }}
            onOpenCatalog={(id) => {
              setMobileTreeOpen(false);
              openCatalog(id);
            }}
            onAction={(next) => {
              setMobileTreeOpen(false);
              setAction(next);
            }}
          />
        </DialogContent>
      </Dialog>
      {settingsTab && (
        <WorkspaceSettingsDialog
          key={workspace.id}
          workspace={workspace}
          initialTab={settingsTab}
          onClose={() => setSettingsTab(null)}
        />
      )}

      <CatalogActionDialogs
        action={action}
        onClose={() => setAction(null)}
        workspaceId={workspaceId}
        rootCatalogId={rootCatalogId}
        identityKey={identityKey}
        onDocumentCreated={(created) => onOpenDocument(created.id)}
      />
    </div>
  );
}
