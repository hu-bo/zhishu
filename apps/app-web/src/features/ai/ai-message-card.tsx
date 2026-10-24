import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  FileDiff,
  LoaderCircle,
  RotateCcw,
  Sparkles,
  ArrowUpRight,
  AlertCircle,
} from 'lucide-react';
import { acceptAiProposal, getAiTask, resumeAiTask } from '@/api/generated/app-api';
import { ApiError, errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { proposalText, type AiLocalMessage } from './ai-client';
import { isReplacementIntent } from '@zhishu/ai-contracts';

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
export function AiMessageCard({
  message,
  identityKey,
  onRegenerate,
  onUseForWriting,
  onResend,
  onForgetPreview,
  onReview,
  onDismissReview,
  reviewStale,
}: {
  message: AiLocalMessage;
  identityKey: string;
  onRegenerate: () => void;
  onUseForWriting: () => void;
  onResend: () => void;
  onForgetPreview: (id: string) => void;
  onReview: (id: string) => void;
  onDismissReview: (id: string) => void;
  reviewStale?: boolean;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<string | null>(null),
    [diff, setDiff] = useState(false);
  const query = useQuery({
    queryKey: ['writing-task', identityKey, message.id],
    queryFn: ({ signal }) => getAiTask(message.id, { signal }),
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
  if (unauthorized)
    return (
      <article className="space-y-4">
        <p className="ml-auto max-w-[90%] rounded-2xl rounded-br-sm bg-secondary px-4 py-3 text-sm leading-6">
          {message.instruction}
        </p>
        <p role="alert" className="flex gap-2 text-sm text-muted-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          资料授权已变化，相关回复和草稿已隐藏。
        </p>
      </article>
    );
  const result = task?.status === 'completed' ? task.result : null;
  const text = result ? proposalText(result) : message.registered && task ? message.preview : '';
  const proposal = result && 'operationBatch' in result ? result : null;
  const running = task?.status === 'running' || (!task && !message.error && !query.isError);
  const applied = task?.application.state === 'applied';
  const rejected = task?.application.state === 'rejected';
  const partial = task?.application.state === 'partial';
  const acceptedCount =
    task?.review?.decisions.filter((decision) => decision.action === 'accept').length ?? 0;
  const rejectedCount =
    task?.review?.decisions.filter((decision) => decision.action === 'reject').length ?? 0;
  const conflict = task?.application.state === 'conflict';
  const replacing =
    message.body.request.kind === 'authoring' && isReplacementIntent(message.body.request.intent);
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
    <article className="space-y-5">
      <div className="flex justify-end">
        <p className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-secondary px-4 py-3 text-[13px] leading-6 break-words">
          {message.instruction}
        </p>
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span className="flex size-6 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles size={13} />
          </span>
          知书
          <span className="ml-auto text-[11px] font-normal text-muted-foreground">
            {message.body.request.kind === 'chat' ? '讨论' : '创作建议'}
          </span>
        </div>
        {running && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle size={13} className="animate-spin" />
            {message.stage || '正在准备生成…'}
          </p>
        )}
        {text && (
          <div className="whitespace-pre-wrap text-[13px] leading-7 break-words text-foreground/90">
            {text}
          </div>
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
        {proposal && (
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
                  ? replacing
                    ? rejectedCount
                      ? '本轮建议已处理，已确认的修改已保存，拒绝的内容保留原文。'
                      : '已替换原文，服务器已确认保存。'
                    : '已写入个人文档，服务器已确认保存。'
                  : rejected
                    ? '已拒绝本轮全部建议，原文保留。'
                    : conflict
                      ? '文档已更新，本次未写入。草稿已保留。'
                      : reviewStale
                        ? '原文已变化，替换建议已失效。草稿已保留。'
                        : task?.application.code === 'WRITE_UNCONFIRMED'
                          ? '写入结果待确认，请查询原任务；重试将核对同一提案，不会重复写入。'
                          : task?.application.state === 'blocked'
                            ? '本轮未写入，草稿已保留。'
                            : partial || rejectedCount
                              ? `已替换 ${acceptedCount} 处，拒绝 ${rejectedCount} 处，剩余建议等待确认。`
                              : replacing
                                ? message.dismissed
                                  ? '已取消替换，原文保留。生成稿仍可重新预览。'
                                  : '替换建议已就绪，原文尚未修改。'
                                : '完整草稿已就绪，等待接受。'}
              </p>
            </div>
            {message.body.request.kind === 'authoring' && (
              <Link
                to="/documents/$documentId"
                params={{ documentId: message.body.request.document.documentId }}
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <span className="shrink-0">写入位置：</span>
                <span className="truncate">{message.targetTitle ?? '本轮选定的个人文档'}</span>
                <ArrowUpRight size={12} className="shrink-0" />
              </Link>
            )}
            <p className="text-xs leading-6 text-muted-foreground">{proposal.summary}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDiff(true)}>
                查看差异
              </Button>
              {!applied && !rejected && !conflict && replacing && (
                <>
                  <Button
                    size="sm"
                    disabled={busy || reviewStale || query.isError}
                    onClick={() => onReview(message.id)}
                  >
                    预览替换
                  </Button>
                  {!message.dismissed && (
                    <Button size="sm" variant="ghost" onClick={() => onDismissReview(message.id)}>
                      全部拒绝
                    </Button>
                  )}
                </>
              )}
              {!applied && !conflict && !replacing && (
                <Button
                  size="sm"
                  disabled={busy || query.isError}
                  onClick={() => void action(() => acceptAiProposal(message.id))}
                >
                  {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
                  接受写入
                </Button>
              )}
              {(conflict || reviewStale) && (
                <Button size="sm" onClick={onRegenerate}>
                  基于最新内容重新生成
                </Button>
              )}
            </div>
          </div>
        )}
        {result && result.citations.length > 0 && (
          <details className="rounded-lg border border-border/70 px-3 py-2 text-xs">
            <summary className="cursor-pointer py-1 text-muted-foreground">
              参考来源 · {result.citations.length}
            </summary>
            <ul className="mt-2 space-y-3">
              {result.citations.map((citation) => (
                <li key={citation.citationId} className="space-y-1">
                  <p className="line-clamp-3 leading-6 text-muted-foreground">“{citation.quote}”</p>
                  <Link
                    to="/documents/$documentId"
                    params={{ documentId: citation.source.sourceId }}
                    className="inline-flex items-center gap-1 text-primary"
                  >
                    打开来源
                    <ArrowUpRight size={12} />
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )}
        {!running && (
          <div className="flex flex-wrap gap-1">
            {text && (
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
            {result && !proposal && (
              <Button size="sm" variant="ghost" onClick={onUseForWriting}>
                用于创作
                <ArrowUpRight size={13} />
              </Button>
            )}
            {(task?.status === 'failed' || task?.status === 'cancelled') && (
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
        <DialogContent showCloseButton={false} className="max-h-[85dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>检查本轮草稿</DialogTitle>
            <DialogDescription>
              {message.body.request.kind === 'authoring' &&
              isReplacementIntent(message.body.request.intent)
                ? message.body.request.intent === 'rewrite-document'
                  ? '整篇替换需在正文预览中点击替换；原文变化时不覆盖。'
                  : '将替换明确选择的完整段落；在正文预览中点击替换后才保存。'
                : '以下内容将新增到文档中，原文保留。'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">原文</h3>
              <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl bg-secondary p-4 text-sm leading-7 break-words">
                {message.beforeText || '在文档末尾新增内容'}
              </div>
            </section>
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-primary">生成草稿</h3>
              <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl bg-primary/5 p-4 text-sm leading-7 break-words">
                {text}
              </div>
            </section>
          </div>
          <Button variant="outline" onClick={() => setDiff(false)}>
            关闭对比
          </Button>
        </DialogContent>
      </Dialog>
    </article>
  );
}
