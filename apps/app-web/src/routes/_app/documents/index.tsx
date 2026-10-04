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
} from '@/api/generated/app-api';
import type { ListDocumentsParams } from '@/api/generated/models';
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
  const [newMode, setNewMode] = useState<'collaborative' | 'standard'>('collaborative');
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
      mode: newMode,
      ...(workspaces[0] ? { workspaceId: workspaces[0].id } : {}),
    };
    const fingerprint = JSON.stringify(createInput);
    const idempotencyKey = createRequestKeys.current.get(fingerprint) ?? crypto.randomUUID();
    createRequestKeys.current.set(fingerprint, idempotencyKey);
    try {
      await createDocument(createInput, { headers: { 'Idempotency-Key': idempotencyKey } });
      createRequestKeys.current.delete(fingerprint);
      setCreateOpen(false);
      setNewTitle('');
      setNewMode('collaborative');
      setSearchDraft('');
      changeSearch({ view: 'mine', q: undefined, offset: 0 });
      await refresh();
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
    <div className="space-y-8">
      <section className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-medium text-primary">你的工作空间</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">文档</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            集中查看最近打开和共享给你的内容。你可以从空白文档开始，也可以稍后整理收藏与归档。
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="h-10 gap-2 px-4">
          <Plus aria-hidden="true" />
          新建文档
        </Button>
      </section>

      <section className="rounded-2xl border bg-card p-3 shadow-sm shadow-foreground/[0.02] sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <nav aria-label="文档视图" className="flex gap-1 overflow-x-auto pb-1">
            {views.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => changeSearch({ view: value, offset: 0 })}
                aria-current={search.view === value ? 'page' : undefined}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${search.view === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <form
              onSubmit={submitSearch}
              role="search"
              className="relative min-w-0 flex-1 sm:w-64 sm:flex-none"
            >
              <Search
                size={16}
                className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
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
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>排序</span>
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

        <div className="mt-5 border-t">
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
                className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 pt-1"
              >
                {documents.data.items.map((document) => (
                  <li
                    key={document.id}
                    aria-busy={busyId === document.id}
                    className="group relative flex flex-col rounded-xl border bg-card p-4 shadow-xs transition-colors duration-150 hover:border-primary/40"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-lg">
                        {document.icon ?? (
                          <FileText size={18} className="text-primary" aria-hidden="true" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <Link
                          to="/spaces/$workspaceId"
                          params={{ workspaceId: document.workspaceId }}
                          search={{ doc: document.id }}
                          title={document.title}
                          className="block truncate text-sm font-medium outline-none transition-colors duration-150 hover:text-primary focus-visible:underline"
                        >
                          {document.title}
                        </Link>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {document.workspaceName} · {document.createdBy} ·{' '}
                          {document.mode === 'standard' ? '快照' : '协同'}
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
                    <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
                      {document.excerpt || '暂无内容摘要。'}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3">
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
              <div className="flex items-center justify-between border-t px-2 pt-4 text-sm text-muted-foreground sm:px-3">
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
            <DialogDescription>
              普通快照显式保存；启动实时协同会话时会原子升级为协同模式。
            </DialogDescription>
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
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">编辑模式</legend>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
                <input
                  className="mt-1 accent-primary"
                  type="radio"
                  name="document-mode"
                  value="collaborative"
                  checked={newMode === 'collaborative'}
                  onChange={() => setNewMode('collaborative')}
                />
                <span>
                  <span className="block text-sm font-medium">实时协同</span>
                  <span className="block text-xs text-muted-foreground">
                    多人可同时编辑，变更由服务器自动持久化。
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
                <input
                  className="mt-1 accent-primary"
                  type="radio"
                  name="document-mode"
                  value="standard"
                  checked={newMode === 'standard'}
                  onChange={() => setNewMode('standard')}
                />
                <span>
                  <span className="block text-sm font-medium">普通快照</span>
                  <span className="block text-xs text-muted-foreground">
                    编辑后显式保存；并发修改会提示冲突，不建立实时协同连接。
                  </span>
                </span>
              </label>
            </fieldset>
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
