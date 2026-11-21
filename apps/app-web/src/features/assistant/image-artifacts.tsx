import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConversationSnapshot } from '@zhishu/chat-contracts';
import { ActionCard, type CardTone } from '@zhishu/chat-ui';
import { Button } from '../../components/ui/button';
import { AlertTriangle, Clock, Image, RefreshCw } from 'lucide-react';
import { apiBaseUrl, getAccessToken } from '../../api/transport';
import { CARD_BUTTON_CLASS } from './picker-shared';

type ImageJob =
  | { id: string; status: 'pending' | 'unknown' | 'failed'; code?: string }
  | {
      id: string;
      status: 'ready';
      assets: { assetId: string; mime: string; width: number; height: number }[];
    };

/** Job status → card presentation; states come from ai_image_jobs facts, never from chat text. */
const JOB_VIEW = {
  pending: {
    tone: 'info',
    badge: '保存中',
    spinner: true,
    icon: Clock,
    text: '正在保存到私有资源库…',
  },
  ready: { tone: 'success', badge: '已生成', spinner: false, icon: Image, text: '' },
  unknown: {
    tone: 'warning',
    badge: '结果未知',
    spinner: false,
    icon: AlertTriangle,
    text: '外部生成结果尚未确认；系统不会自动重试计费，请手动查询。',
  },
  failed: { tone: 'danger', badge: '生成失败', spinner: false, icon: AlertTriangle, text: '' },
} as const satisfies Record<
  ImageJob['status'],
  { tone: CardTone; badge: string; spinner: boolean; icon: typeof Clock; text: string }
>;

/** Image job facts come from ai_image_jobs; chat text never claims a paid call succeeded. */
function jobSubtitle(job: ImageJob): string {
  if (job.status === 'ready') {
    const asset = job.assets[0];
    return `${asset?.width ?? ''} × ${asset?.height ?? ''} · 已保存到私有资源库`;
  }
  if (job.status === 'failed') {
    return `生成失败${job.code ? `（${job.code}）` : ''}；不会自动重试计费，可发起新的生成。`;
  }
  return JOB_VIEW[job.status].text;
}

/** Image jobs from the assistant conversation: states, manual refresh and controlled access. */
export function ImageArtifacts({
  conversationId,
  snapshot,
}: {
  conversationId: string | null;
  snapshot: ConversationSnapshot | null;
}) {
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const token = getAccessToken();
  const jobsQuery = useQuery({
    queryKey: ['assistant-images', conversationId, snapshot?.cursor ?? ''],
    enabled: !!conversationId && !!token,
    queryFn: async () => {
      const response = await fetch(`${apiBaseUrl}/api/ai/conversations/${conversationId}/images`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('图片任务读取失败');
      return (await response.json()) as { key: string; runId: string; job: ImageJob }[];
    },
  });
  const jobs = jobsQuery.data ?? [];
  const error = refreshError ?? (jobsQuery.isError ? '图片任务读取失败' : null);

  if (!jobs.length) return null;
  return (
    <div className="writing-images">
      {jobs.map(({ key, job }) => {
        const view = JOB_VIEW[job.status];
        return (
          <ActionCard
            key={key}
            label="生成图片"
            tone={view.tone}
            icon={<view.icon className="size-4" />}
            title="生成图片"
            subtitle={jobSubtitle(job)}
            badge={{ text: view.badge, spinner: view.spinner }}
            footer={
              job.status === 'pending' || job.status === 'unknown' ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className={`${CARD_BUTTON_CLASS} ms-auto`}
                  onPress={() => void refresh(key)}
                >
                  <RefreshCw className="size-3.5" />
                  {job.status === 'pending' ? '刷新' : '手动查询'}
                </Button>
              ) : undefined
            }
          >
            {job.status === 'ready' ? (
              <PrivateImage conversationId={conversationId} assetId={job.assets[0]?.assetId} />
            ) : null}
          </ActionCard>
        );
      })}
      {error ? <p className="image-error">{error}</p> : null}
    </div>
  );

  async function refresh(key: string) {
    if (!conversationId || !token) return;
    setRefreshError(null);
    const response = await fetch(
      `${apiBaseUrl}/api/ai/conversations/${conversationId}/images/${encodeURIComponent(key)}/refresh`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      setRefreshError('刷新失败，请稍后重试');
      return;
    }
    await jobsQuery.refetch();
  }
}

function PrivateImage({
  conversationId,
  assetId,
}: {
  conversationId: string | null;
  assetId?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const token = getAccessToken();
  useEffect(() => {
    if (!conversationId || !token || !assetId) return;
    let cancelled = false;
    void fetch(`${apiBaseUrl}/api/ai/conversations/${conversationId}/images/${assetId}/access`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((response) => response.json() as Promise<{ url: string }>)
      .then((body) => !cancelled && setUrl(body.url))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [conversationId, assetId, token]);
  if (!url) return <p>正在载入图片…</p>;
  return <img className="writing-image" src={url} alt="生成图片" />;
}
