import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDocumentComment,
  deleteDocumentComment,
  listDocumentComments,
} from '@/api/generated/documents';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { PanelDialog } from '@/components/ui/panel-dialog';
import { MemberPicker, type MemberChoice } from '@/features/knowledge/member-picker';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';

export function DocumentComments({
  documentId,
  open,
  onOpenChange,
  reading,
}: {
  documentId: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  reading: boolean;
}) {
  const { identityKey } = useKnowledgeWorkspace();
  const client = useQueryClient();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<MemberChoice[]>([]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['document-comments', identityKey, documentId],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      listDocumentComments(documentId, { offset: pageParam }, { signal }),
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.flatMap((p) => p.items).length : undefined,
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['document-comments', identityKey, documentId] });
    await client.invalidateQueries({ queryKey: ['notifications', identityKey] });
  };
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createDocumentComment(documentId, {
        id: requestId,
        body,
        mentionIds: mentions.map((m) => m.identityId),
      });
      setBody('');
      setMentions([]);
      setRequestId(crypto.randomUUID());
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteDocumentComment(documentId, id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog
      open={open}
      onOpenChange={onOpenChange}
      title="文档评论"
      description="围绕这篇文档讨论，也可以提及有访问权限的成员。"
    >
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取评论…
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
          <ul className="max-h-[38dvh] divide-y overflow-y-auto">
            {query.data.pages
              .flatMap((p) => p.items)
              .map((comment) => (
                <li key={comment.id} className="space-y-2 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{comment.authorName}</span>
                    <time className="text-xs text-muted-foreground">
                      {new Date(comment.createdAt).toLocaleString('zh-CN')}
                    </time>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6">
                    {comment.body}
                  </p>
                  {comment.canDelete && !reading && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void remove(comment.id)}
                    >
                      删除评论
                    </Button>
                  )}
                </li>
              ))}
          </ul>
          {!query.data.pages[0]?.items.length && (
            <p className="py-5 text-center text-sm text-muted-foreground">还没有评论</p>
          )}
          {query.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              加载更多评论
            </Button>
          )}
          {query.data.pages[0]?.canComment && !reading ? (
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label className="block space-y-2 text-sm">
                <span>写下评论</span>
                <Textarea
                  required
                  maxLength={5000}
                  disabled={busy}
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setRequestId(crypto.randomUUID());
                  }}
                  placeholder="写下想法或反馈…"
                />
              </label>
              {mentions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {mentions.map((m) => (
                    <button
                      key={m.identityId}
                      type="button"
                      disabled={busy}
                      className="rounded-full bg-secondary px-2 py-1 text-xs"
                      aria-label={`取消提及 ${m.displayName}`}
                      onClick={() => {
                        setMentions((old) =>
                          old.filter((member) => member.identityId !== m.identityId),
                        );
                        setRequestId(crypto.randomUUID());
                      }}
                    >
                      @{m.displayName} ×
                    </button>
                  ))}
                </div>
              )}
              {mentions.length < 10 && (
                <MemberPicker
                  value={null}
                  documentId={documentId}
                  disabled={busy}
                  label="@ 提及成员"
                  onChange={(member) => {
                    if (member && !mentions.some((m) => m.identityId === member.identityId)) {
                      setMentions((old) => [...old, member]);
                      setBody(
                        (old) =>
                          `${old}${old && !old.endsWith(' ') ? ' ' : ''}@${member.displayName} `,
                      );
                      setRequestId(crypto.randomUUID());
                    }
                  }}
                />
              )}
              <Button type="submit" size="sm" disabled={busy || !body.trim()}>
                {busy ? '正在发送…' : '发送评论'}
              </Button>
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">
              {reading
                ? '切换到编辑模式后可发表评论。'
                : '你目前可以查看评论，发表评论需要评论权限。'}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </PanelDialog>
  );
}
