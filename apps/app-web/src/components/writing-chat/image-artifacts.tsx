import { useQuery } from '@tanstack/react-query';
import { ArtifactCard } from '@zhishu/chat-ui';
import {
  getWritingImageAccess,
  listWritingImages,
  refreshWritingImage,
} from '@/api/generated/writing-chat';
import { errorMessage } from '@/api/api-error';
import { useState } from 'react';

export function ImageArtifacts({
  identityKey,
  conversationId,
  generating,
}: {
  identityKey: string;
  conversationId: string;
  generating: boolean;
}) {
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['writing-images', identityKey, conversationId],
    queryFn: ({ signal }) => listWritingImages(conversationId, { signal }),
    enabled: !!conversationId,
    refetchInterval: generating ? 2000 : false,
  });
  return (
    <>
      {query.data?.map((job) => (
        <ArtifactCard key={job.id} title="生成图片">
          {job.status === 'ready' ? (
            job.assets.map((asset) => (
              <PrivateImage
                key={asset.assetId}
                identityKey={identityKey}
                conversationId={conversationId}
                assetId={asset.assetId}
              />
            ))
          ) : (
            <p>
              {job.status === 'unknown'
                ? '外部生成结果未确认，不能自动重新生成或撤销费用。'
                : job.status === 'failed'
                  ? '图片生成失败。'
                  : '图片已生成，正在保存到私有资源库。'}
            </p>
          )}
          {job.status === 'pending' && (
            <button
              onClick={() => {
                void refreshWritingImage(conversationId, job.id)
                  .then(() => query.refetch())
                  .catch((cause) => setError(errorMessage(cause)));
              }}
            >
              重试保存图片
            </button>
          )}
        </ArtifactCard>
      ))}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
function PrivateImage({
  identityKey,
  conversationId,
  assetId,
}: {
  identityKey: string;
  conversationId: string;
  assetId: string;
}) {
  const query = useQuery({
    queryKey: ['writing-image-access', identityKey, conversationId, assetId],
    queryFn: ({ signal }) => getWritingImageAccess(conversationId, assetId, { signal }),
    staleTime: 30000,
    retry: false,
  });
  return (
    <>
      {query.data && (
        <img
          className="max-h-48 max-w-full rounded-lg object-contain"
          src={query.data.url}
          alt="AI 生成的文章配图"
        />
      )}
      <button onClick={() => void query.refetch()}>刷新图片预览</button>
      {query.isError && <p>图片不可访问，请刷新授权。</p>}
    </>
  );
}
