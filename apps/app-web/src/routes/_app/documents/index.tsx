import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  FileText,
  FolderOpen,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
} from 'lucide-react';
import {
  archiveDocument,
  createDocument,
  favoriteDocument,
  listDocuments,
  permanentlyDeleteDocument,
  restoreDocument,
  trashDocument,
  unfavoriteDocument,
} from '@/api/generated/documents';
import type { ListDocumentsParams } from '@/api/generated/app-api.schemas';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { relativeTime } from '@/lib/time';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const views = [
  { value: 'recent', label: '最近使用', icon: FolderOpen },
  { value: 'mine', label: '我的文档', icon: FileText },
  { value: 'all', label: '全部文档', icon: FileText },
  { value: 'favorites', label: '收藏', icon: Star },
  { value: 'archived', label: '已归档', icon: Archive },
  { value: 'trash', label: '回收站', icon: Trash2 },
] as const satisfies ReadonlyArray<{
  value: NonNullable<ListDocumentsParams['view']>;
  label: string;
  icon: typeof FolderOpen;
}>;

type DocumentSearch = Required<
  Pick<ListDocumentsParams, 'view' | 'sort' | 'direction' | 'limit' | 'offset'>
> &
  Pick<ListDocumentsParams, 'q'>;

function validateSearch(search: Record<string, unknown>): DocumentSearch {
  const validViews = views.map((item) => item.value) as string[];
  const sortValues = ['recent', 'updated', 'created', 'title'] as const;
  return {
    view: validViews.includes(String(search.view))
      ? (String(search.view) as NonNullable<ListDocumentsParams['view']>)
      : 'recent',
    q: typeof search.q === 'string' ? search.q.slice(0, 200) : undefined,
    sort: sortValues.includes(search.sort as (typeof sortValues)[number])
      ? (search.sort as (typeof sortValues)[number])
      : 'recent',
    direction: search.direction === 'asc' ? 'asc' : 'desc',
    limit: typeof search.limit === 'number' && search.limit > 0 ? Math.min(search.limit, 100) : 20,
    offset: typeof search.offset === 'number' && search.offset >= 0 ? search.offset : 0,
  };
}

const sortLabels = {
  recent: '最近访问',
  updated: '最近更新',
  created: '创建时间',
  title: '标题',
} as const;

const emptyHints = {
  recent: '你最近还没有打开过文档；从空间或搜索进入一篇文档后会出现在这里。',
  mine: '你还没有创建过文档，从右上角「新建文档」开始。',
  all: '团队知识库中还没有你可见的文档。',
  favorites: '还没有收藏；在文档卡片上点击星标即可收藏。',
  archived: '没有已归档的文档。',
  trash: '回收站是空的。',
} as const satisfies Record<(typeof views)[number]['value'], string>;

export const Route = createFileRoute('/_app/documents/')({
  validateSearch,
  component: DocumentsPage,
});

function DocumentsPage() {
  const { workspaces, identityKey, enabled } = useKnowledgeWorkspace();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: '/documents/' });
  const queryClient = useQueryClient();
  const [searchDraft, setSearchDraft] = useState(search.q ?? '');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const createRequestKeys = useRef(new Map<string, string>());

  // Resync the search box when the URL query changes (render-phase adjust,
  // no effect).
  const [syncedQuery, setSyncedQuery] = useState(search.q ?? '');
  if (syncedQuery !== (search.q ?? '')) {
    setSyncedQuery(search.q ?? '');
    setSearchDraft(search.q ?? '');
  }

  const documents = useQuery({
    queryKey: ['documents', identityKey, search],
    queryFn: ({ signal }) => listDocuments({ ...search, q: search.q || undefined }, { signal }),
    enabled,
  });

  const currentView = views.find((view) => view.value === search.view) ?? views[0];
  const page = Math.floor(search.offset / search.limit) + 1;

  const changeSearch = (patch: Partial<DocumentSearch>) => {
    void navigate({
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    });
  };

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['documents'] });
    await queryClient.invalidateQueries({ queryKey: ['catalog-children'] });
    await queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces'] });
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    changeSearch({ q: searchDraft.trim(), offset: 0 });
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActionError(null);
    setBusyId('create');
    const createInput = {
      title: newTitle.trim() || '未命名文档',
      ...(workspaces[0] ? { workspaceId: workspaces[0].id } : {}),
    };
    const fingerprint = JSON.stringify(createInput);
    const idempotencyKey = createRequestKeys.current.get(fingerprint) ?? crypto.randomUUID();
    createRequestKeys.current.set(fingerprint, idempotencyKey);
    try {
      const created = await createDocument(createInput, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      createRequestKeys.current.delete(fingerprint);
      void navigate({
        to: '/spaces/$workspaceId/doc/$documentId',
        params: { workspaceId: created.workspaceId, documentId: created.id },
      });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  };

  const runAction = async (documentId: string, action: () => Promise<unknown>) => {
    setActionError(null);
    setBusyId(documentId);
    try {
      await action();
      await refresh();
      return true;
    } catch (error) {
      setActionError(errorMessage(error));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="zhishu-page space-y-5">
      <section className="flex items-center justify-between gap-4">
        <h1 className="zhishu-page-heading">我的文档</h1>
        <Button onClick={() => setCreateOpen(true)} className="h-10 gap-2 px-3 sm:px-4">
          <Plus aria-hidden="true" />
          新建文档
        </Button>
      </section>

      <section className="space-y-4">
        <div className="flex min-w-0 flex-col gap-4">
          <nav
            aria-label="文档视图"
            className="flex gap-1 overflow-x-auto border-b border-border pb-2"
          >
            {views.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => changeSearch({ view: value, offset: 0 })}
                aria-current={search.view === value ? 'page' : undefined}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${search.view === value ? 'bg-primary/8 font-medium text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-2.5">
            <form
              onSubmit={submitSearch}
              role="search"
              className="relative min-w-0 basis-full sm:max-w-80 sm:basis-auto sm:flex-1"
            >
              <Search
                size={16}
                className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="搜索文档标题"
                placeholder="搜索文档标题"
                className="h-9 pl-9"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </form>
            <div className="ml-auto flex shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
              <span className="hidden whitespace-nowrap sm:inline">排序</span>
              <Select
                value={search.sort}
                onValueChange={(value) => {
                  if (value) changeSearch({ sort: value, offset: 0 });
                }}
                items={{
                  ...sortLabels,
                  recent: search.view === 'recent' ? '最近访问' : '最近更新',
                }}
              >
                <SelectTrigger aria-label="文档排序方式" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(sortLabels).map(([value, label]) => (
                    <SelectItem key={value} value={value as DocumentSearch['sort']}>
                      {value === 'recent' && search.view !== 'recent' ? '最近更新' : label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              size="icon"
              aria-label={search.direction === 'desc' ? '切换为升序' : '切换为降序'}
              title={search.direction === 'desc' ? '当前降序' : '当前升序'}
              onClick={() =>
                changeSearch({ direction: search.direction === 'desc' ? 'asc' : 'desc', offset: 0 })
              }
            >
              {search.direction === 'desc' ? (
                <ArrowDown aria-hidden="true" />
              ) : (
                <ArrowUp aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>

        {actionError && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {actionError}
          </p>
        )}

        <div>
          {!enabled ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              登录后查看你的文档与团队知识库。
            </p>
          ) : documents.isPending ? (
            <div
              role="status"
              className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
              正在加载文档…
            </div>
          ) : documents.isError ? (
            <div
              role="alert"
              className="flex min-h-56 flex-col items-center justify-center text-center"
            >
              <p className="font-medium">
                {documents.error instanceof ApiError && documents.error.status === 401
                  ? '登录后查看文档'
                  : '暂时无法加载文档'}
              </p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                {errorMessage(documents.error)}
              </p>
              <Button className="mt-4" variant="outline" onClick={() => void documents.refetch()}>
                重新加载
              </Button>
            </div>
          ) : documents.data.items.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed px-4 py-10 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-secondary text-primary">
                <currentView.icon size={22} aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-base font-semibold">
                {search.q ? '没有找到匹配的文档' : `${currentView.label}还是空的`}
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                {search.q
                  ? '试试缩短关键词，或切换到其他文档视图。'
                  : emptyHints[currentView.value]}
              </p>
              {!search.q && search.view !== 'trash' && search.view !== 'archived' && (
                <Button variant="outline" className="mt-4" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden="true" /> 创建文档
                </Button>
              )}
            </div>
          ) : (
            <>
              <ul
                aria-label={`${currentView.label}列表`}
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3"
              >
                {documents.data.items.map((document) => (
                  <li
                    key={document.id}
                    aria-busy={busyId === document.id}
                    className="zhishu-card group relative flex min-w-0 flex-col p-4"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-background text-xl">
                        {document.icon ?? (
                          <FileText
                            size={18}
                            className="text-muted-foreground"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          to="/spaces/$workspaceId/doc/$documentId"
                          params={{ workspaceId: document.workspaceId, documentId: document.id }}
                          title={document.title}
                          className="line-clamp-2 text-sm font-semibold leading-6 outline-none transition-colors duration-150 hover:text-primary focus-visible:underline"
                        >
                          {document.title}
                        </Link>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {document.workspaceName}
                          {search.view === 'trash' && ' · 已移入回收站'}
                        </p>
                      </div>
                      {document.isFavorite && (
                        <Star
                          size={14}
                          className="mt-0.5 shrink-0 fill-amber-400 text-amber-500"
                          aria-label="已收藏"
                        />
                      )}
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-11 text-[13px] leading-[1.7] text-muted-foreground">
                      {document.excerpt || '空白文档，等你写下第一个想法。'}
                    </p>
                    <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                      <span className="truncate text-xs text-muted-foreground">
                        {search.view === 'trash' ? '移入' : '更新'}于{' '}
                        {relativeTime(
                          search.view === 'trash'
                            ? (document.deletedAt ?? document.updatedAt)
                            : document.updatedAt,
                        )}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 transition-opacity duration-150 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                        {search.view !== 'trash' && search.view !== 'archived' && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
                            aria-label={
                              document.isFavorite
                                ? `取消收藏 ${document.title}`
                                : `收藏 ${document.title}`
                            }
                            title={document.isFavorite ? '取消收藏' : '收藏'}
                            disabled={busyId === document.id}
                            onClick={() =>
                              void runAction(document.id, () =>
                                document.isFavorite
                                  ? unfavoriteDocument(document.id)
                                  : favoriteDocument(document.id),
                              )
                            }
                          >
                            <Star
                              size={15}
                              className={document.isFavorite ? 'fill-amber-400 text-amber-500' : ''}
                              aria-hidden="true"
                            />
                          </Button>
                        )}
                        {search.view === 'trash' ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
                              aria-label={`恢复 ${document.title}`}
                              title="恢复文档"
                              disabled={busyId === document.id || !document.canManage}
                              onClick={() =>
                                void runAction(document.id, () => restoreDocument(document.id))
                              }
                            >
                              <RotateCcw size={15} aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
                              aria-label={`永久删除 ${document.title}`}
                              title="永久删除"
                              disabled={busyId === document.id || !document.canManage}
                              onClick={() =>
                                setPendingDelete({ id: document.id, title: document.title })
                              }
                            >
                              <Trash2 size={15} className="text-destructive" aria-hidden="true" />
                            </Button>
                          </>
                        ) : search.view === 'archived' ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
                            aria-label={`取消归档 ${document.title}`}
                            title="取消归档"
                            disabled={busyId === document.id || !document.canManage}
                            onClick={() =>
                              void runAction(document.id, () => restoreDocument(document.id))
                            }
                          >
                            <RotateCcw size={15} aria-hidden="true" />
                          </Button>
                        ) : document.canManage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
                              aria-label={`归档 ${document.title}`}
                              title="归档"
                              disabled={busyId === document.id}
                              onClick={() =>
                                void runAction(document.id, () => archiveDocument(document.id))
                              }
                            >
                              <Archive size={15} aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
                              aria-label={`移入回收站 ${document.title}`}
                              title="移入回收站"
                              disabled={busyId === document.id}
                              onClick={() =>
                                void runAction(document.id, () => trashDocument(document.id))
                              }
                            >
                              <Trash2 size={15} aria-hidden="true" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex items-center justify-between border-t px-1 pt-3 text-xs text-muted-foreground">
                <span>第 {page} 页</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={search.offset === 0 || documents.isFetching}
                    onClick={() =>
                      changeSearch({ offset: Math.max(0, search.offset - search.limit) })
                    }
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!documents.data.hasMore || documents.isFetching}
                    onClick={() => changeSearch({ offset: search.offset + search.limit })}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建文档</DialogTitle>
            <DialogDescription>给想法起个名字。支持多人协作，内容会自动保存。</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitCreate} className="space-y-4">
            <label className="block space-y-2 text-sm font-medium">
              文档名称
              <Input
                autoFocus
                maxLength={200}
                placeholder="未命名文档"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
              />
            </label>
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={busyId === 'create'}>
                {busyId === 'create' ? '正在创建…' : '创建文档'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && busyId === null) setPendingDelete(null);
        }}
        title="永久删除文档？"
        description={
          pendingDelete
            ? `“${pendingDelete.title}”及其可访问历史将被永久删除，此操作无法撤销。`
            : ''
        }
        confirmLabel="永久删除"
        destructive
        error={actionError}
        onConfirm={async () => {
          if (!pendingDelete) return false;
          const deleted = await runAction(pendingDelete.id, () =>
            permanentlyDeleteDocument(pendingDelete.id),
          );
          if (deleted) setPendingDelete(null);
          return deleted;
        }}
      />
    </div>
  );
}
