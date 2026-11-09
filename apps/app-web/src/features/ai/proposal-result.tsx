import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Copy,
  FileDiff,
  Link2,
  LoaderCircle,
  Plus,
  RotateCcw,
  ArrowUpRight,
  AlertCircle,
} from 'lucide-react';
import { acceptAiProposal, getAiTask, resumeAiTask } from '@/api/generated/ai';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { proposalText, type ProposalMessage } from './proposal-client';
import { isReplacementProposal } from '@zhishu/ai-contracts';
import { MessageParts } from '@zhishu/chat-ui';

const errors: Record<string, string> = {
  MODEL_FAILED: '生成服务暂时不可用，请稍后重试。',
  TIMEOUT: '本次生成超时，已保留收到的草稿。',
  BUDGET_EXCEEDED: '本轮生成已达到上限，请缩小资料或问题范围。',
  INVALID_CITATION: '来源未通过校验，请重新生成。',
  INSUFFICIENT_EVIDENCE: '所选资料中没有足够证据，请补充资料。',
  TARGET_CONFLICT: '文档已更新，本次未写入。草稿已保留。',
  ACCESS_REVOKED: '资料权限已变化，请重新选择资料。',
  CANCELLED: '已停止生成，部分草稿可能不完整。',
};
export function ProposalResult({
  message,
  identityKey,
  onRegenerate,
  onResend,
  onForgetPreview,
  onReviewFinished,
  reviewStale,
}: {
  message: ProposalMessage;
  identityKey: string;
  onRegenerate: () => void;
  onResend: () => void;
  onForgetPreview: (id: string) => void;
  onReviewFinished: (id: string) => void;
  reviewStale?: boolean;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<string | null>(null),
    [diff, setDiff] = useState(false);
  const query = useQuery({
    queryKey: ['writing-task', identityKey, message.id],
    queryFn: async ({ signal }) => {
      const task = await getAiTask(message.id, { signal });
      if (task.kind !== 'authoring') throw new Error('此记录不属于文章提案');
      return task;
    },
    enabled: message.registered,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
    retry: (count, error) =>
      !(error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) && count < 1,
  });
  const task = query.data;
  const unauthorized = query.error instanceof ApiError && [401, 403].includes(query.error.status);
  useEffect(() => {
    if (unauthorized) onForgetPreview(message.id);
  }, [unauthorized, message.id, onForgetPreview]);
  const result = task?.status === 'completed' ? task.result : null;
  const text = result
    ? proposalText(result)
    : message.registered && task
      ? (message.preview ?? '')
      : '';
  const proposal = result && 'operationBatch' in result ? result : null;
  const running = task?.status === 'running' || (!task && !message.error && !query.isError);
  const applied = task?.application.state === 'applied';
  const conflict = task?.application.state === 'conflict';
  const replacing = !!proposal && isReplacementProposal(message.body.request, proposal);
  const reviewFinished =
    task?.status === 'failed' ||
    task?.status === 'cancelled' ||
    (task?.status === 'completed' &&
      (!replacing || applied || task.application.state === 'rejected'));
  useEffect(() => {
    if (reviewFinished && message.reviewPending !== false) onReviewFinished(message.id);
  }, [reviewFinished, message.reviewPending, message.id, onReviewFinished]);
  if (unauthorized)
    return (
      <p role="alert" className="flex gap-2 text-sm text-muted-foreground">
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        资料授权已变化，相关回复和草稿已隐藏。
      </p>
    );
  const action = async (callback: () => Promise<unknown>) => {
    setBusy(true);
    setFeedback(null);
    try {
      await callback();
      await query.refetch();
      void queryClient.invalidateQueries({ queryKey: ['writing-context'] });
    } catch (error) {
      setFeedback(errorMessage(error));
      await query.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="space-y-3">
        {running && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle size={13} className="animate-spin" />
            正在生成提案…
          </p>
        )}
        {text && !replacing && (
          <MessageParts parts={[{ id: `${message.id}:text`, kind: 'text', text }]} />
        )}
        {task?.status === 'interrupted' && (
          <div className="space-y-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-xs leading-6">
            <p>连接已中断，草稿可能不完整。恢复后可继续检查建议。</p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void action(() => resumeAiTask(message.id))}
            >
              <RotateCcw size={13} />
              恢复任务
            </Button>
          </div>
        )}
        {task?.status === 'cancelled' && (
          <p className="text-xs leading-6 text-muted-foreground">
            已停止。当前草稿可能不完整，不会写入正文。
          </p>
        )}
        {task?.status === 'failed' && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/5 p-3 text-xs leading-6 text-destructive"
          >
            {errors[task.errorCode ?? ''] ?? '本次生成未完成，请重新生成。'}
          </p>
        )}
        {message.error && !running && task?.status !== 'completed' && (
          <p className="text-xs leading-6 text-muted-foreground">{message.error}</p>
        )}
        {query.isError && (
          <div role="alert" className="space-y-2 rounded-lg border p-3 text-xs leading-6">
            <p>任务结果待确认，已保留本机草稿。</p>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              查询原任务
            </Button>
            {query.error instanceof ApiError && query.error.status === 404 && (
              <Button size="sm" variant="ghost" onClick={onResend}>
                再次发送同一请求
              </Button>
            )}
          </div>
        )}
        {replacing && (
          <p role="status" className="text-xs leading-6 text-muted-foreground">
            {applied
              ? '已确认的修改已保存。'
              : task?.application.state === 'rejected'
                ? '已拒绝剩余修改建议。'
                : conflict || reviewStale
                  ? '原文已更新，请重新生成修改建议。'
                  : '修改建议已生成，请在文档中审阅。'}
          </p>
        )}
        {proposal && !replacing && (
          <div
            className={`space-y-3 rounded-xl border p-3 ${applied ? 'border-success/25 bg-success/5' : conflict ? 'border-warning/30 bg-warning/5' : 'border-border/80 bg-card'}`}
          >
            <div className="flex items-start gap-2 text-xs leading-6">
              {applied ? (
                <Check size={15} className="mt-1 shrink-0 text-success" />
              ) : conflict ? (
                <AlertCircle size={15} className="mt-1 shrink-0 text-warning" />
              ) : (
                <FileDiff size={15} className="mt-1 shrink-0 text-muted-foreground" />
              )}
              <p>
                {applied
                  ? '已写入个人文档，服务器已确认保存。'
                  : conflict
                    ? '文档已更新，本次未写入。草稿已保留。'
                    : task?.application.code === 'WRITE_UNCONFIRMED'
                      ? '写入结果待确认，请查询原任务；重试将核对同一提案，不会重复写入。'
                      : task?.application.state === 'blocked'
                        ? '本轮未写入，草稿已保留。'
                        : '完整草稿已就绪，等待接受。'}
              </p>
            </div>
            <Link
              to="/documents/$documentId"
              params={{ documentId: message.body.request.document.documentId }}
              className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <span className="shrink-0">写入位置：</span>
              <span className="truncate">{message.targetTitle ?? '本轮选定的个人文档'}</span>
              <ArrowUpRight size={12} className="shrink-0" />
            </Link>
            <p className="text-xs leading-6 text-muted-foreground">{proposal.summary}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-haspopup="dialog"
                className="border-border bg-card font-medium hover:bg-secondary"
                onClick={() => setDiff(true)}
              >
                <FileDiff aria-hidden="true" className="text-primary" />
                预览新增内容
              </Button>
              {!applied && !conflict && (
                <Button
                  size="sm"
                  disabled={busy || query.isError}
                  onClick={() => void action(() => acceptAiProposal(message.id))}
                >
                  {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
                  接受写入
                </Button>
              )}
            </div>
          </div>
        )}
        {result && result.citations.length > 0 && (
          <details className="group/sources rounded-xl border border-border/80 bg-card">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 rounded-xl px-3 py-2 text-xs transition-colors hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Link2 size={14} aria-hidden="true" />
              </span>
              <span className="font-semibold text-foreground">参考来源</span>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-muted-foreground tabular-nums">
                {result.citations.length} 条
              </span>
              <ChevronDown
                size={15}
                aria-hidden="true"
                className="ml-auto shrink-0 text-muted-foreground group-open/sources:rotate-180 motion-safe:transition-transform"
              />
            </summary>
            <ol className="space-y-2 border-t border-border/70 p-2.5">
              {result.citations.map((citation, index) => (
                <li key={citation.citationId}>
                  <Link
                    to="/documents/$documentId"
                    params={{ documentId: citation.source.sourceId }}
                    className="group/source flex items-start gap-2.5 rounded-lg border border-border/70 bg-secondary/35 p-2.5 transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-card text-[11px] font-medium text-muted-foreground tabular-nums">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2 text-xs leading-6 font-medium text-foreground group-hover/source:text-primary">
                        打开来源
                        <ArrowUpRight size={14} aria-hidden="true" className="shrink-0" />
                      </span>
                      <span className="mt-0.5 line-clamp-3 text-xs leading-5 wrap-anywhere whitespace-pre-line text-muted-foreground">
                        {citation.quote.trim()}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          </details>
        )}
        {!running && (
          <div className="flex flex-wrap gap-1">
            {text && !replacing && (
              <Button
                size="sm"
                variant="ghost"
                disabled={query.isError || !task}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => setFeedback('已复制。'))
                    .catch(() => setFeedback('复制失败，请重试。'));
                }}
              >
                <Copy size={13} />
                复制
              </Button>
            )}
            {(task?.status === 'failed' ||
              task?.status === 'cancelled' ||
              conflict ||
              reviewStale) && (
              <Button size="sm" variant="ghost" onClick={onRegenerate}>
                <RotateCcw size={13} />
                重新生成
              </Button>
            )}
          </div>
        )}
        {feedback && (
          <p role="status" className="text-xs text-muted-foreground">
            {feedback}
          </p>
        )}
      </div>
      <Dialog open={diff} onOpenChange={setDiff}>
        <DialogContent className="flex max-h-[85dvh] max-w-2xl flex-col gap-0 overflow-hidden p-0 [scrollbar-gutter:auto] sm:p-0">
          <DialogHeader className="shrink-0 border-b border-border/70 bg-secondary/30 px-4 py-4 pr-12 sm:px-6 sm:py-5 sm:pr-12">
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <FileDiff size={18} aria-hidden="true" />
              </span>
              <DialogTitle>新增内容预览</DialogTitle>
            </div>
            <DialogDescription>
              {applied || conflict ? '这里展示本轮生成的草稿。' : '草稿将追加到文档末尾。'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-6">
            <section className="min-w-0 rounded-xl border border-success/25 bg-card">
              <h3 className="flex items-center gap-2 rounded-t-xl border-b border-success/20 bg-success/8 px-4 py-2.5 text-xs font-semibold text-success">
                <Plus size={14} aria-hidden="true" />
                新增内容
              </h3>
              <div className="px-4 py-3 text-sm leading-7 wrap-anywhere whitespace-pre-wrap">
                {text || <span className="text-muted-foreground">暂无可预览的文本</span>}
              </div>
            </section>
          </div>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6">
            <Button size="sm" variant="outline" onClick={() => setDiff(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
