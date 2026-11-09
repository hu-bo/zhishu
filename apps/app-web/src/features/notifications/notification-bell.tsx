import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/api/generated/notifications';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { PanelDialog } from '@/components/ui/panel-dialog';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';

export function NotificationBell() {
  const { identityKey, enabled } = useKnowledgeWorkspace();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['notifications', identityKey, unread],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listNotifications(
        { limit: 20, unread: unread ? 'true' : 'false', before: pageParam },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const count = query.data?.pages[0]?.unreadCount ?? 0;
  const read = async (id?: string) => {
    setBusy(true);
    setError(null);
    try {
      if (id) await markNotificationRead(id);
      else await markAllNotificationsRead();
      await client.invalidateQueries({ queryKey: ['notifications', identityKey] });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="relative"
        aria-label={`通知中心${count ? `，${count} 条未读` : ''}`}
        title="通知中心"
        onClick={() => setOpen(true)}
      >
        <Bell size={17} aria-hidden="true" />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Button>
      <PanelDialog
        open={open}
        onOpenChange={setOpen}
        title="通知中心"
        description="评论、提及以及与你有关的权限和文档动态。"
      >
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />
            仅看未读
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !count}
            onClick={() => void read()}
          >
            <CheckCheck size={15} />
            全部已读
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在加载通知…
          </p>
        ) : query.isError ? (
          <div role="alert">
            <p className="text-sm text-destructive">{errorMessage(query.error)}</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <ul className="max-h-[55dvh] divide-y overflow-y-auto">
              {query.data.pages
                .flatMap((page) => page.items)
                .map((n) => (
                  <li key={n.id} className="flex gap-3 py-4">
                    <span
                      className={`mt-1.5 size-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-primary'}`}
                      aria-label={n.readAt ? '已读' : '未读'}
                    />
                    <div className="min-w-0 flex-1">
                      {n.documentTitle && (
                        <p className="mb-1 truncate text-sm font-medium">{n.documentTitle}</p>
                      )}
                      <p className="text-sm">{n.message}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {n.actorName} · {new Date(n.createdAt).toLocaleString('zh-CN')}
                      </p>
                      {n.available && n.documentId ? (
                        <Link
                          to="/documents/$documentId"
                          params={{ documentId: n.documentId }}
                          className="mt-2 inline-block text-xs text-primary"
                          onClick={() => {
                            void read(n.id);
                            setOpen(false);
                          }}
                        >
                          打开文档
                        </Link>
                      ) : n.documentId ? (
                        <p className="mt-2 text-xs text-muted-foreground">文档已不可访问</p>
                      ) : null}
                    </div>
                    {!n.readAt && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void read(n.id)}
                      >
                        已读
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
            {!query.data.pages[0]?.items.length && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {unread ? '没有未读通知' : '还没有通知'}
              </p>
            )}
            {query.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                加载更多
              </Button>
            )}
          </>
        )}
      </PanelDialog>
    </>
  );
}
