import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  FilePlus2,
  FolderKanban,
  FolderPlus,
  LoaderCircle,
} from 'lucide-react';
import { locateDocument } from '@/api/generated/app-api';
import { Button, buttonVariants } from '@/components/ui/button';
import { DocumentPane } from '@/features/document/document-pane';
import { CatalogActionDialogs, type CatalogAction } from '@/features/knowledge/catalog-dialogs';
import { CatalogBrowsePanel } from '@/features/knowledge/catalog-browse-panel';
import { CatalogTree } from '@/features/knowledge/catalog-tree';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';

export const Route = createFileRoute('/_app/spaces/$workspaceId')({
  validateSearch: (search: Record<string, unknown>): SpaceSearch => {
    const result: SpaceSearch = {};
    if (typeof search.doc === 'string' && DOCUMENT_ID_PATTERN.test(search.doc))
      result.doc = search.doc;
    if (typeof search.cat === 'string' && CATALOG_ID_PATTERN.test(search.cat))
      result.cat = search.cat;
    return result;
  },
  component: SpaceDetailPage,
});

export type SpaceSearch = { doc?: string; cat?: string };

const DOCUMENT_ID_PATTERN = /^doc_[A-Za-z0-9_-]{1,64}$/;
const CATALOG_ID_PATTERN = /^cat_[A-Za-z0-9_-]{1,64}$/;

function SpaceDetailPage() {
  const { workspaceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { workspaces, identityKey, loading, failed, refreshWorkspaces } = useKnowledgeWorkspace();
  const [action, setAction] = useState<CatalogAction | null>(null);

  const workspace = workspaces.find((item) => item.id === workspaceId);
  const rootCatalogId = workspace?.rootCatalogId;
  const browseCatalogId = search.cat ?? rootCatalogId;

  // Locate path of the open document: feeds the tree's forced expansion so the
  // active row is visible after a deep link or search jump.
  const docParam = search.doc;
  const locate = useQuery({
    queryKey: ['document-locate', identityKey, docParam ?? ''],
    queryFn: ({ signal }) => locateDocument(docParam ?? '', { signal }),
    enabled: !!docParam,
    staleTime: 30_000,
  });
  const expandCatalogIds = search.doc
    ? (locate.data?.catalogPath.map((segment) => segment.id) ?? undefined)
    : undefined;

  const openDocument = (documentId: string) =>
    void navigate({ search: (previous: SpaceSearch) => ({ ...previous, doc: documentId }) });
  const closeDocument = () =>
    void navigate({ search: (previous: SpaceSearch) => ({ ...previous, doc: undefined }) });
  const openCatalog = (catalogId: string) => void navigate({ search: () => ({ cat: catalogId }) });

  if (loading) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />
        正在加载空间…
      </div>
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
            这个空间可能已被删除，或者不在你的租户内。
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
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden min-h-0 flex-col border-r border-border bg-card lg:flex">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-base"
          >
            {workspace.icon || <FolderKanban size={15} className="text-muted-foreground" />}
          </span>
          <h1
            className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
            title={workspace.name}
          >
            {workspace.name}
          </h1>
          {browseCatalogId && (
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
            activeDocumentId={search.doc}
            activeCatalogId={browseCatalogId}
            expandCatalogIds={expandCatalogIds}
            onOpenDocument={openDocument}
            onOpenCatalog={openCatalog}
            onAction={setAction}
          />
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col">
        {search.doc ? (
          <DocumentPane
            key={search.doc}
            documentId={search.doc}
            workspaceId={workspaceId}
            rootCatalogId={rootCatalogId}
            identityKey={identityKey}
            workspaceName={workspace.name}
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
            workspace={{ name: workspace.name, icon: workspace.icon }}
            onOpenDocument={openDocument}
            onOpenCatalog={openCatalog}
            onAction={setAction}
          />
        ) : null}
      </main>

      <CatalogActionDialogs
        action={action}
        onClose={() => setAction(null)}
        workspaceId={workspaceId}
        rootCatalogId={rootCatalogId}
        identityKey={identityKey}
        onDocumentCreated={(created) => openDocument(created.id)}
      />
    </div>
  );
}
