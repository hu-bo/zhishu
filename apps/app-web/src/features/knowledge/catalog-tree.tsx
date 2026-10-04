import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  FilePlus2,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  FolderInput,
  Trash2,
} from 'lucide-react';
import { listCatalogChildren } from '@/api/generated/app-api';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import type { CatalogAction } from './catalog-dialogs';

const EMPTY_SET = new Set<string>();

export interface CatalogTreeProps {
  workspaceId: string;
  rootCatalogId: string;
  identityKey: string;
  activeDocumentId?: string;
  activeCatalogId?: string;
  /** Extra catalog ids to force-expand (e.g. the locate path of the open document). */
  expandCatalogIds?: string[];
  onOpenDocument: (documentId: string) => void;
  onOpenCatalog: (catalogId: string) => void;
  onAction: (action: CatalogAction) => void;
}

function useAutoScrollIntoView(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return ref;
}

function CatalogRow({
  catalog,
  depth,
  expanded,
  active,
  onToggle,
  onOpenCatalog,
  onAction,
}: {
  catalog: {
    id: string;
    name: string;
    icon: string | null;
    hasChildren: boolean;
    canManage: boolean;
  };
  depth: number;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  onOpenCatalog: () => void;
  onAction: (action: CatalogAction) => void;
}) {
  const ref = useAutoScrollIntoView(active);
  return (
    <div
      ref={ref}
      className={`group/row flex items-center rounded-lg pr-1 transition-colors duration-150 ${
        active ? 'bg-muted font-medium text-foreground' : 'hover:bg-muted/60'
      }`}
      style={{ paddingLeft: depth * 14 }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={expanded ? `收起 ${catalog.name}` : `展开 ${catalog.name}`}
        disabled={!catalog.hasChildren}
        onClick={onToggle}
        className={`flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-transform ${
          catalog.hasChildren ? 'hover:bg-muted hover:text-foreground' : 'invisible'
        }`}
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      <button
        type="button"
        onClick={onOpenCatalog}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm text-foreground"
      >
        <span aria-hidden="true" className="shrink-0 text-xs leading-none">
          {catalog.icon || (
            <Folder size={14} className="text-muted-foreground" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{catalog.name}</span>
      </button>
      {catalog.canManage && (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${catalog.name} 的目录操作`}
                className="shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </Button>
            }
          />
          <MenuContent align="end">
            <MenuItem onClick={() => onAction({ kind: 'create-catalog', parentId: catalog.id })}>
              <FolderPlus size={14} aria-hidden="true" />
              新建子目录
            </MenuItem>
            <MenuItem onClick={() => onAction({ kind: 'create-document', catalogId: catalog.id })}>
              <FilePlus2 size={14} aria-hidden="true" />
              在此新建文档
            </MenuItem>
            <MenuSeparator />
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
                onAction({ kind: 'move-catalog', catalog: { id: catalog.id, name: catalog.name } })
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
  );
}

function DocumentRow({
  document,
  depth,
  active,
  onOpenDocument,
  onAction,
}: {
  document: {
    id: string;
    title: string;
    icon: string | null;
    metadataRevision: number;
    canManage: boolean;
  };
  depth: number;
  active: boolean;
  onOpenDocument: () => void;
  onAction: (action: CatalogAction) => void;
}) {
  const ref = useAutoScrollIntoView(active);
  return (
    <div
      ref={ref}
      className={`group/row flex items-center rounded-lg pr-1 transition-colors duration-150 ${
        active
          ? 'bg-secondary font-medium text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      }`}
      style={{ paddingLeft: depth * 14 + 24 }}
    >
      <button
        type="button"
        onClick={onOpenDocument}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-sm"
      >
        <span aria-hidden="true" className="shrink-0 text-xs leading-none">
          {document.icon || <FileText size={14} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{document.title}</span>
      </button>
      {document.canManage && (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${document.title} 的文档操作`}
                className="shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
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
      )}
    </div>
  );
}

function TreeBranch({
  workspaceId,
  catalogId,
  depth,
  identityKey,
  activeDocumentId,
  activeCatalogId,
  expanded,
  toggle,
  onOpenDocument,
  onOpenCatalog,
  onAction,
}: Omit<CatalogTreeProps, 'rootCatalogId' | 'expandCatalogIds'> & {
  catalogId: string;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const children = useQuery({
    queryKey: ['catalog-children', identityKey, workspaceId, catalogId],
    queryFn: ({ signal }) => listCatalogChildren(workspaceId, catalogId, { signal }),
    staleTime: 30_000,
  });
  if (children.isPending)
    return (
      <p
        className="flex items-center gap-1.5 py-1.5 text-xs text-muted-foreground"
        style={{ paddingLeft: depth * 14 + 24 }}
      >
        <LoaderCircle size={12} className="animate-spin" aria-hidden="true" />
        正在加载…
      </p>
    );
  if (children.isError)
    return (
      <p
        className="flex items-center gap-2 py-1.5 text-xs text-destructive"
        style={{ paddingLeft: depth * 14 + 24 }}
      >
        加载失败
        <button type="button" className="underline" onClick={() => void children.refetch()}>
          重试
        </button>
      </p>
    );
  return (
    <>
      {children.data.catalogs.map((catalog) => (
        <div key={catalog.id}>
          <CatalogRow
            catalog={catalog}
            depth={depth}
            expanded={expanded.has(catalog.id)}
            active={activeCatalogId === catalog.id}
            onToggle={() => toggle(catalog.id)}
            onOpenCatalog={() => onOpenCatalog(catalog.id)}
            onAction={onAction}
          />
          {expanded.has(catalog.id) && (
            <TreeBranch
              workspaceId={workspaceId}
              catalogId={catalog.id}
              depth={depth + 1}
              identityKey={identityKey}
              activeDocumentId={activeDocumentId}
              activeCatalogId={activeCatalogId}
              expanded={expanded}
              toggle={toggle}
              onOpenDocument={onOpenDocument}
              onOpenCatalog={onOpenCatalog}
              onAction={onAction}
            />
          )}
        </div>
      ))}
      {children.data.documents.map((document) => (
        <DocumentRow
          key={document.id}
          document={document}
          depth={depth}
          active={activeDocumentId === document.id}
          onOpenDocument={() => onOpenDocument(document.id)}
          onAction={onAction}
        />
      ))}
    </>
  );
}

/**
 * Lazily-loaded catalog tree. One query per expanded node
 * (['catalog-children', identityKey, workspaceId, catalogId]); mutations
 * invalidate the coarse ['catalog-children', identityKey, workspaceId] prefix.
 */
export function CatalogTree({
  workspaceId,
  rootCatalogId,
  identityKey,
  activeDocumentId,
  activeCatalogId,
  expandCatalogIds,
  onOpenDocument,
  onOpenCatalog,
  onAction,
}: CatalogTreeProps) {
  // Expansion is derived, never effect-synced: the user's own expansions plus
  // the forced locate path, minus explicit collapses. Collapses are scoped to
  // the expandKey generation they were made under, so navigating to another
  // document re-expands its locate path.
  const expandKey = expandCatalogIds?.join(',') ?? '';
  const [userExpanded, setUserExpanded] = useState<Set<string>>(() => new Set([rootCatalogId]));
  const [userCollapsed, setUserCollapsed] = useState<{ key: string; ids: Set<string> }>(() => ({
    key: '',
    ids: EMPTY_SET,
  }));
  const collapsed = userCollapsed.key === expandKey ? userCollapsed.ids : EMPTY_SET;
  const expanded = useMemo(() => {
    const next = new Set(userExpanded);
    if (expandKey) for (const id of expandKey.split(',')) next.add(id);
    for (const id of collapsed) next.delete(id);
    return next;
  }, [userExpanded, expandKey, collapsed]);

  const toggle = (id: string) => {
    if (expanded.has(id)) {
      setUserCollapsed((previous) => {
        const ids = previous.key === expandKey ? new Set(previous.ids) : new Set<string>();
        ids.add(id);
        return { key: expandKey, ids };
      });
    } else {
      setUserExpanded((previous) => new Set(previous).add(id));
      setUserCollapsed((previous) => {
        if (previous.key !== expandKey || !previous.ids.has(id)) return previous;
        const ids = new Set(previous.ids);
        ids.delete(id);
        return { key: expandKey, ids };
      });
    }
  };

  return (
    <nav aria-label="空间目录" className="px-2 py-2">
      <TreeBranch
        workspaceId={workspaceId}
        catalogId={rootCatalogId}
        depth={0}
        identityKey={identityKey}
        activeDocumentId={activeDocumentId}
        activeCatalogId={activeCatalogId}
        expanded={expanded}
        toggle={toggle}
        onOpenDocument={onOpenDocument}
        onOpenCatalog={onOpenCatalog}
        onAction={onAction}
      />
    </nav>
  );
}
