import { useEffect, useMemo, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Ban, Clock, FileQuestion, LoaderCircle } from 'lucide-react';
import {
  getPublicShare,
  getPublicShareAssetAccess,
  getPublicShareContent,
  joinShare,
} from '@/api/generated/app-api';
import type { GetPublicShare200 } from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { getAccessToken, subscribeAccessToken } from '@/api/transport';
import { Button } from '@/components/ui/button';
import { DocumentReadonlyView } from '@/features/document/document-readonly-view';
import type { EditorHostServices } from '@zhishu/editor-react';

export const Route = createFileRoute('/share/$shareId')({
  component: PublicSharePage,
});

// Top-level route on purpose: the public reader renders without AppShell chrome.

const shareDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatShareDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : shareDateFormatter.format(date);
}

const stateCards = {
  expired: {
    icon: Clock,
    title: '分享链接已过期',
    hint: (share: GetPublicShare200) =>
      `这条链接已于 ${formatShareDate(share.expiresAt)} 停止生效。`,
  },
  revoked: {
    icon: Ban,
    title: '分享链接已被撤销',
    hint: () => '创建者已停止这条链接的访问，请联系文档所有者获取新链接。',
  },
  unknown: {
    icon: FileQuestion,
    title: '分享链接不存在',
    hint: () => '链接可能有误，或对应的文档已被移除。',
  },
} as const;

function InactiveShareCard({ share }: { share: GetPublicShare200 }) {
  const card = stateCards[share.state === 'active' ? 'unknown' : share.state];
  const Icon = card.icon;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md rounded-2xl border border-dashed bg-card p-8 text-center shadow-xs">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-secondary">
          <Icon size={26} className="text-muted-foreground" aria-hidden="true" />
        </span>
        <h1 className="mt-4 text-lg font-semibold">{card.title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{card.hint(share)}</p>
        <Button variant="outline" className="mt-6" render={<Link to="/" />}>
          回到知书首页
        </Button>
      </div>
    </div>
  );
}

function PublicSharePage() {
  const { shareId } = Route.useParams();
  const navigate = useNavigate();

  const detail = useQuery({
    queryKey: ['public-share', shareId],
    queryFn: ({ signal }) => getPublicShare(shareId, { signal }),
    staleTime: 30_000,
  });
  const active = detail.data?.state === 'active' ? detail.data : null;
  const content = useQuery({
    queryKey: ['public-share-content', shareId],
    queryFn: ({ signal }) => getPublicShareContent(shareId, { signal }),
    enabled: !!active,
  });

  const [hasToken, setHasToken] = useState(() => !!getAccessToken());
  useEffect(() => {
    const unsubscribe = subscribeAccessToken((token) => setHasToken(!!token));
    return () => {
      unsubscribe();
    };
  }, []);

  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const hostServices = useMemo<EditorHostServices>(
    () => ({
      resolveAssetURL: async (assetId, signal) => {
        const access = await getPublicShareAssetAccess(shareId, assetId, { signal });
        return access.url;
      },
    }),
    [shareId],
  );

  const join = async () => {
    setJoinBusy(true);
    setJoinError(null);
    try {
      const result = await joinShare(shareId);
      await navigate({
        to: '/spaces/$workspaceId',
        params: { workspaceId: result.workspaceId },
        search: { doc: result.documentId },
      });
    } catch (cause) {
      setJoinError(errorMessage(cause));
      setJoinBusy(false);
    }
  };

  if (detail.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
          <LoaderCircle className="animate-spin" size={18} aria-hidden="true" />
          正在打开分享链接…
        </div>
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
        <div role="alert" className="w-full max-w-md rounded-2xl border bg-card p-8 text-center">
          <h1 className="text-lg font-semibold">无法打开分享链接</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {detail.isError ? errorMessage(detail.error) : '分享信息不可用。'}
          </p>
          <Button variant="outline" className="mt-6" render={<Link to="/" />}>
            回到知书首页
          </Button>
        </div>
      </div>
    );
  }

  if (!active) return <InactiveShareCard share={detail.data} />;

  const document = active.document;
  const body = content.data?.content;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
          aria-hidden="true"
        >
          知
        </span>
        <p className="truncate text-sm font-semibold">共享文档</p>
        <span
          className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
            active.permission === 'edit'
              ? 'bg-primary/10 text-primary'
              : 'bg-secondary text-secondary-foreground'
          }`}
        >
          {active.permission === 'edit' ? '可编辑' : '可阅读'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {hasToken && (
            <Button size="sm" disabled={joinBusy} onClick={() => void join()}>
              {joinBusy && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
              {joinBusy ? '正在加入…' : '加入并打开'}
            </Button>
          )}
        </div>
      </header>
      {joinError && (
        <p
          role="alert"
          className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-xs text-destructive"
        >
          {joinError}
        </p>
      )}

      <main className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col px-3 sm:px-4">
        <div className="shrink-0 px-1 pb-3 pt-6">
          <div className="flex items-start gap-3">
            {document?.icon && (
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-2xl">
                {document.icon}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight break-words">
                {document?.title ?? '共享文档'}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                更新于 {formatShareDate(document?.updatedAt)} · 链接有效期至{' '}
                {formatShareDate(active.expiresAt)}
              </p>
            </div>
          </div>
        </div>

        {content.isPending ? (
          <div
            role="status"
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            正在加载正文…
          </div>
        ) : content.isError ? (
          <div role="alert" className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-md rounded-2xl border border-dashed bg-card px-6 py-10 text-center">
              <p className="text-sm font-medium">正文暂时无法加载</p>
              <p className="mt-2 text-xs text-muted-foreground">{errorMessage(content.error)}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => void content.refetch()}
              >
                重试
              </Button>
            </div>
          </div>
        ) : body ? (
          <DocumentReadonlyView
            instanceKey={`share:${shareId}:${document?.generationId ?? ''}`}
            content={body}
            readOnlyReason="共享文档只读。"
            ariaLabel="共享文档正文"
            surfaceLabel="共享文档正文"
            className="zhishu-share-shell min-h-0 flex-1"
            editingControls={false}
            hostServices={hostServices}
          />
        ) : (
          <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            这篇文档暂时没有正文内容。
          </p>
        )}
      </main>

      <footer className="shrink-0 border-t px-4 py-2 text-center text-xs text-muted-foreground">
        此页面由知书公开链接分享 · 内容只读
      </footer>
    </div>
  );
}
