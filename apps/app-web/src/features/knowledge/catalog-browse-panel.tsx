import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  FolderInput,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { listCatalogChildren } from '@/api/generated/app-api';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { relativeTime } from '@/lib/time';
import type { CatalogAction } from './catalog-dialogs';

export interface CatalogBrowsePanelProps {
  workspaceId: string;
  catalogId: string;
  identityKey: string;
  workspace: { name: string; icon: string | null; canOrganize: boolean };
  onOpenDocument: (documentId: string) => void;
  onOpenCatalog: (catalogId: string) => void;
  onAction: (action: CatalogAction) => void;
}

function EmptyState({
  onAction,
  catalogId,
  canOrganize,
}: {
  onAction: (action: CatalogAction) => void;
  catalogId: string;
  canOrganize: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/80 px-6 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Folder size={20} aria-hidden="true" />
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">这里还是空的</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          创建第一篇文档，或建立子目录来组织内容。
        </p>
      </div>
      {canOrganize && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onAction({ kind: 'create-document', catalogId })}>
            <FilePlus2 size={14} aria-hidden="true" />
            新建文档
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAction({ kind: 'create-catalog', parentId: catalogId })}
          >
            <FolderPlus size={14} aria-hidden="true" />
            新建子目录
          </Button>
        </div>
      )}
    </div>
  );
}

export function CatalogBrowsePanel({
  workspaceId,
  catalogId,
  identityKey,
  workspace,
  onOpenDocument,
  onOpenCatalog,
  onAction,
}: CatalogBrowsePanelProps) {
  const children = useQuery({
    queryKey: ['catalog-children', identityKey, workspaceId, catalogId],
    queryFn: ({ signal }) => listCatalogChildren(workspaceId, catalogId, { signal }),
    staleTime: 30_000,
  });

  if (children.isPending)
    return (
      <div className="flex flex-1 items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
        <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
        正在加载目录…
      </div>
    );
  if (children.isError)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-sm">
        <p className="text-muted-foreground">目录加载失败，请稍后重试。</p>
        <Button size="sm" variant="outline" onClick={() => void children.refetch()}>
          重新加载
        </Button>
      </div>
    );

  const { catalog, catalogs, documents } = children.data;
  const isRoot = catalog.isRoot;
  const parentId = catalog.parentId;
  const headerName = isRoot ? workspace.name : catalog.name;
  const headerIcon = isRoot ? workspace.icon : catalog.icon;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-20 shrink-0 flex-wrap items-center gap-3 border-b border-border/70 bg-card/95 px-5 py-4 backdrop-blur sm:px-8">
        {!isRoot && parentId && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="返回上级目录"
            onClick={() => onOpenCatalog(parentId)}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </Button>
        )}
        <span
          aria-hidden="true"
          className="flex size-8 items-center justify-center rounded-lg bg-secondary text-base"
        >
          {headerIcon || '📁'}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-foreground">{headerName}</h1>
          <p className="text-xs text-muted-foreground">
            {catalogs.length} 个目录 · {documents.length} 篇文档
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {workspace.canOrganize && (
            <Button size="sm" onClick={() => onAction({ kind: 'create-document', catalogId })}>
              <FilePlus2 size={14} aria-hidden="true" />
              新建文档
            </Button>
          )}
          {workspace.canOrganize && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAction({ kind: 'create-catalog', parentId: catalogId })}
            >
              <FolderPlus size={14} aria-hidden="true" />
              新建目录
            </Button>
          )}
          {!isRoot && catalog.canManage && (
            <Menu>
              <MenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="目录操作">
                    <MoreHorizontal size={15} aria-hidden="true" />
                  </Button>
                }
              />
              <MenuContent align="end">
                <MenuItem
                  onClick={() =>
                    onAction({
                      kind: 'rename-catalog',
                      catalog: { id: catalog.id, name: catalog.name, icon: catalog.icon },
                    })
                  }
                >
                  <Pencil size={14} aria-hidden="true" />
                  重命名…
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    onAction({
                      kind: 'move-catalog',
                      catalog: { id: catalog.id, name: catalog.name },
                    })
                  }
                >
                  <FolderInput size={14} aria-hidden="true" />
                  移动到…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={() =>
                    onAction({
                      kind: 'delete-catalog',
                      catalog: { id: catalog.id, name: catalog.name },
                    })
                  }
                >
                  <Trash2 size={14} aria-hidden="true" />
                  删除目录
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-8">
        {catalogs.length === 0 && documents.length === 0 ? (
          <EmptyState
            onAction={onAction}
            catalogId={catalogId}
            canOrganize={workspace.canOrganize}
          />
        ) : (
          <div className="space-y-5">
            {catalogs.length > 0 && (
              <section aria-label="子目录">
                <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
                  目录
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {catalogs.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => onOpenCatalog(item.id)}
                        className="zhishu-card flex w-full items-center gap-3 px-4 py-4 text-left"
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-base"
                        >
                          {item.icon || <Folder size={16} className="text-muted-foreground" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground transition-colors duration-150 group-hover:text-primary">
                            {item.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">目录</span>
                        </span>
                        <ChevronRight
                          size={14}
                          className="shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {documents.length > 0 && (
              <section aria-label="文档">
                <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
                  文档
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {documents.map((document) => (
                    <li key={document.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onOpenDocument(document.id)}
                        className="zhishu-card flex min-h-24 w-full items-start gap-3 px-4 py-4 text-left"
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-base"
                        >
                          {document.icon || (
                            <FileText size={16} className="text-muted-foreground" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground transition-colors duration-150 group-hover:text-primary">
                            {document.title}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            更新于 {relativeTime(document.updatedAt)}
                          </span>
                        </span>
                      </button>
                      {document.canManage && (
                        <div className="absolute top-2 right-2 transition-opacity duration-150 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                          <Menu>
                            <MenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`${document.title} 的文档操作`}
                                  className="bg-card/80 backdrop-blur"
                                >
                                  <MoreHorizontal size={14} aria-hidden="true" />
                                </Button>
                              }
                            />
                            <MenuContent align="end">
                              <MenuItem
                                onClick={() =>
                                  onAction({
                                    kind: 'move-document',
                                    document: {
                                      id: document.id,
                                      title: document.title,
                                      metadataRevision: document.metadataRevision,
                                    },
                                  })
                                }
                              >
                                <FolderInput size={14} aria-hidden="true" />
                                移动到…
                              </MenuItem>
                            </MenuContent>
                          </Menu>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
