import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ConversationSnapshot } from '@zhishu/chat-contracts';
import { ArtifactCard } from '@zhishu/chat-ui';
import { apiBaseUrl, getAccessToken } from '../../api/transport';

type ImageJob =
  | { id: string; status: 'pending' | 'unknown' | 'failed'; code?: string }
  | {
      id: string;
      status: 'ready';
      assets: { assetId: string; mime: string; width: number; height: number }[];
    };

/** Image jobs from the writing conversation: states, manual refresh and controlled access. */
export function ImageArtifacts({
  conversationId,
  snapshot,
}: {
  transport: unknown;
  conversationId: string | null;
  snapshot: ConversationSnapshot | null;
}) {
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const token = getAccessToken();
  const imageArtifacts = (snapshot?.artifacts ?? []).filter(
    (artifact) => artifact.kind === 'image',
  );
  const jobsQuery = useQuery({
    queryKey: ['writing-images', conversationId, snapshot?.cursor ?? ''],
    enabled: !!conversationId && !!token,
    queryFn: async () => {
      const response = await fetch(
        `${apiBaseUrl}/api/ai/writing/conversations/${conversationId}/images`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error('图片任务读取失败');
      return (await response.json()) as { key: string; runId: string; job: ImageJob }[];
    },
  });
  const jobs = jobsQuery.data ?? [];
  const error = refreshError ?? (jobsQuery.isError ? '图片任务读取失败' : null);

  if (!imageArtifacts.length && !jobs.length) return null;
  return (
    <div className="writing-images">
      {jobs.map(({ key, job }) => (
        <ArtifactCard key={key} title="生成图片">
          {job.status === 'ready' ? (
            <PrivateImage conversationId={conversationId} assetId={job.assets[0].assetId} />
          ) : job.status === 'unknown' ? (
            <p>外部生成结果尚未确认；系统不会自动重试计费，请手动查询。</p>
          ) : job.status === 'failed' ? (
            <p className="image-failed">生成失败{job.code ? `（${job.code}）` : ''}。</p>
          ) : (
            <>
              <p>正在保存到私有资源库…</p>
              <button type="button" onClick={() => void refresh(key)}>
                刷新
              </button>
            </>
          )}
        </ArtifactCard>
      ))}
      {error ? <p className="image-error">{error}</p> : null}
    </div>
  );

  async function refresh(key: string) {
    if (!conversationId || !token) return;
    setRefreshError(null);
    const response = await fetch(
      `${apiBaseUrl}/api/ai/writing/conversations/${conversationId}/images/${encodeURIComponent(key)}/refresh`,
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
  assetId: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const token = getAccessToken();
  useEffect(() => {
    if (!conversationId || !token) return;
    let cancelled = false;
    void fetch(
      `${apiBaseUrl}/api/ai/writing/conversations/${conversationId}/images/${assetId}/access`,
      { headers: { authorization: `Bearer ${token}` } },
    )
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
