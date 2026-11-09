import { useEffect } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, LoaderCircle } from 'lucide-react';
import { locateDocument } from '@/api/generated/knowledge';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button, buttonVariants } from '@/components/ui/button';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';

export const Route = createFileRoute('/_app/documents/$documentId')({
  component: DocumentLocator,
});

/**
 * Legacy document URL → canonical space document route. The access token lives
 * in memory, so the lookup runs in the component rather than `beforeLoad`.
 */
function DocumentLocator() {
  const { documentId } = Route.useParams();
  const navigate = useNavigate();
  const { identityKey, enabled, authPending } = useKnowledgeWorkspace();
  const locate = useQuery({
    queryKey: ['document-locate', identityKey, documentId],
    queryFn: ({ signal }) => locateDocument(documentId, { signal }),
    staleTime: 30_000,
    enabled,
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  const workspaceId = locate.data?.workspaceId;
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    void navigate({
      to: '/spaces/$workspaceId/doc/$documentId',
      params: { workspaceId, documentId },
      replace: true,
    });
  }, [enabled, workspaceId, documentId, navigate]);

  if (!enabled && !authPending)
    return <p className="p-8 text-center text-sm text-muted-foreground">请登录后打开文档。</p>;

  if (locate.isError) {
    const missing = locate.error instanceof ApiError && locate.error.status === 404;
    return (
      <div role="alert" className="rounded-2xl border bg-card px-6 py-16 text-center">
        <AlertCircle className="mx-auto mb-4 text-muted-foreground" size={32} />
        <h1 className="text-xl font-semibold">
          {missing ? '无法打开这篇文档' : '定位文档时遇到问题'}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {missing ? '文档不存在，或你没有访问权限。' : errorMessage(locate.error)}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            to="/documents"
            search={{ view: 'recent', sort: 'recent', direction: 'desc', limit: 20, offset: 0 }}
            className={buttonVariants({ variant: 'outline' })}
          >
            <ArrowLeft size={16} />
            返回工作台
          </Link>
          {!missing && <Button onClick={() => void locate.refetch()}>重试</Button>}
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground"
    >
      <LoaderCircle className="animate-spin" size={18} />
      正在打开文档…
    </div>
  );
}
