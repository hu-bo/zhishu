import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, FileText, ListTree, PenLine, Plus, Sparkles } from 'lucide-react';
import { Chat, Composer, ChatStatus, ApprovalCard, type MessageView } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import {
  applyChatEvent,
  applyChatSnapshot,
  isChatSnapshot,
  isSubmitChatMessage,
  type ChatSnapshot,
  type SubmitChatMessage,
} from '@zhishu/chat-contracts';
import {
  createWritingConversation,
  getWritingConversation,
  getWritingCapabilities,
  submitWritingMessage,
  cancelWritingRun,
  resumeWritingRun,
  decideWritingApproval,
} from '@/api/generated/writing-chat';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';
import { useOfflineState } from '@/features/offline/cache';
import { errorMessage } from '@/api/api-error';
import { observeWriting } from './transport';
import { ImageArtifacts } from './image-artifacts';
import { appendWritingPreview, type WritingPreview } from './preview';
import { WritingMarkdown } from './writing-markdown';
import './writing-markdown.css';

const starters = [
  { icon: PenLine, label: '从想法起草', prompt: '帮我把下面的想法写成一份可编辑的初稿：' },
  {
    icon: ListTree,
    label: '先列一份大纲',
    prompt: '请围绕这个主题列一份大纲，并注明每节要回答的问题：',
  },
  {
    icon: FileText,
    label: '根据资料整理',
    prompt: '请根据已选资料整理一份文档，概括要点并列出下一步行动。',
  },
];

export function WritingChat({
  identityKey,
  scope,
  legacyScope,
  sourceDocumentIds,
  sourceLabels,
  onPickSources,
  previewDisabled,
  onPreview,
}: {
  identityKey: string;
  scope: string;
  legacyScope: string;
  sourceDocumentIds: string[];
  sourceLabels: string[];
  onPickSources(): void;
  previewDisabled: boolean;
  onPreview(draft: { id: string; text: string }): void;
}) {
  const offline = useOfflineState(),
    cache = useQueryClient();
  const storageKey = JSON.stringify(['writing', identityKey, scope, [...sourceDocumentIds].sort()]);
  const legacyStorageKey = JSON.stringify([
    'writing',
    identityKey,
    legacyScope,
    [...sourceDocumentIds].sort(),
  ]);
  const [conversationId, setConversationId] = useState(''),
    [draft, setDraft] = useState(''),
    [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState(''),
    [submitting, setSubmitting] = useState(false),
    [stopping, setStopping] = useState(false),
    [connection, setConnection] = useState(0);
  const [previews, setPreviews] = useState<Record<string, WritingPreview>>({});
  const [deciding, setDeciding] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const decisions = useRef(
    new Map<
      string,
      { approvalId: string; decisionId: string; decision: 'allow-once' | 'reject' }
    >(),
  );
  const pending = useRef<{ text: string; input: SubmitChatMessage } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!offline.identity) return;
    const identity = offline.identity;
    void readRecord(identity, 'chat-draft', storageKey)
      .then(
        (value) =>
          value ??
          (storageKey !== legacyStorageKey
            ? readRecord(identity, 'chat-draft', legacyStorageKey)
            : undefined),
      )
      .then((value) => {
        if (!active) return;
        if (value && typeof value === 'object') {
          if ('conversationId' in value && typeof value.conversationId === 'string')
            setConversationId(value.conversationId);
          if ('draft' in value && typeof value.draft === 'string') setDraft(value.draft);
          if ('pending' in value && isSubmitChatMessage(value.pending))
            pending.current = { text: value.pending.text, input: value.pending };
        }
        setHydrated(true);
      })
      .catch(() => {
        if (active) {
          setHydrated(true);
          setError('本机草稿读取失败');
        }
      });
    return () => {
      active = false;
    };
  }, [offline.identity, storageKey, legacyStorageKey]);
  useEffect(() => {
    if (!hydrated || !offline.identity) return;
    const timer = setTimeout(() => {
      void writeRecord(offline.identity!, 'chat-draft', storageKey, {
        conversationId,
        draft,
        pending: pending.current?.input,
      }).catch(() => setError('本机草稿保存失败，请保留输入'));
    }, 200);
    return () => clearTimeout(timer);
  }, [offline.identity, storageKey, hydrated, conversationId, draft, submitting]);
  const key = useMemo(
    () => ['writing-chat', identityKey, scope, conversationId] as const,
    [identityKey, scope, conversationId],
  );
  const query = useQuery<ChatSnapshot>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const value = await getWritingConversation(conversationId, { signal });
      if (!isChatSnapshot(value)) throw new Error('对话格式不兼容');
      return value;
    },
    enabled: hydrated && !!conversationId && offline.verified && offline.online,
    retry: false,
    structuralSharing: (current, incoming) =>
      isChatSnapshot(current) && isChatSnapshot(incoming)
        ? applyChatSnapshot(current, incoming)
        : incoming,
  });
  const latest = useRef<{
    conversationId: string;
    draft: string;
    pending?: SubmitChatMessage;
    hydrated: boolean;
  }>({ conversationId: '', draft: '', hydrated: false });
  useLayoutEffect(() => {
    latest.current = { conversationId, draft, pending: pending.current?.input, hydrated };
  }, [conversationId, draft, hydrated, submitting]);
  useEffect(() => {
    const flush = () => {
      if (offline.identity && latest.current.hydrated)
        writeRecordOnPageExit(offline.identity, 'chat-draft', storageKey, latest.current);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [offline.identity, storageKey]);
  const capabilities = useQuery({
    queryKey: ['writing-chat-capabilities', identityKey],
    queryFn: ({ signal }) => getWritingCapabilities({ signal }),
    enabled: offline.verified && offline.online,
  });
  const snapshot = query.data;
  useEffect(() => {
    if (!conversationId || !snapshot || !offline.online || !offline.verified) return;
    const stop = new AbortController();
    void observeWriting(
      conversationId,
      snapshot.cursor,
      stop.signal,
      (frame) => {
        if (stop.signal.aborted) return;
        if (frame.type === 'snapshot') {
          const current = cache.getQueryData<ChatSnapshot>(key);
          if (current && BigInt(frame.sequence) < BigInt(current.cursor)) return;
          if (
            !frame.snapshot.runs.some((r) =>
              ['running', 'queued', 'waiting-approval'].includes(r.status),
            )
          )
            setStopping(false);
          cache.setQueryData<ChatSnapshot>(key, (current) =>
            current ? applyChatEvent(current, frame) : frame.snapshot,
          );
          setPreviews((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([runId]) =>
                frame.snapshot.runs.some(
                  (r) => r.id === runId && ['running', 'waiting-approval'].includes(r.status),
                ),
              ),
            ),
          );
        } else if (frame.type === 'assistant.delta') {
          const state = cache.getQueryData<ChatSnapshot>(key);
          if (
            !state?.runs.some(
              (r) =>
                r.id === frame.runId &&
                r.attempt === frame.attempt &&
                ['running', 'waiting-approval'].includes(r.status),
            )
          )
            return;
          setPreviews((current) => ({
            ...current,
            [frame.runId]: appendWritingPreview(current[frame.runId], frame),
          }));
        } else {
          stop.abort();
          void query.refetch();
          setError('已重新读取已保存消息，请重新连接以继续查看进度');
        }
      },
      () => setPreviews({}),
    ).catch((cause) => {
      if (!stop.signal.aborted) setError(errorMessage(cause));
    });
    return () => stop.abort();
    // The subscription cursor is fixed at connection start. Events update query data without reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, !!snapshot, connection, offline.online, offline.verified, key, cache]);
  const messages: MessageView[] = useMemo(
    () => [
      ...(!query.isError
        ? (snapshot?.messages
            .filter((m) => m.status === 'committed' || !previews[m.runId])
            .map((m) => ({
              id: m.id,
              role: m.role,
              status: m.status === 'committed' ? undefined : '未完成草稿',
              parts: [{ id: `${m.id}:text`, kind: 'text' as const, text: m.text }],
            })) ?? [])
        : []),
      ...Object.entries(query.isError ? {} : previews)
        .filter(
          ([runId]) =>
            !snapshot?.messages.some(
              (m) => m.runId === runId && m.role === 'assistant' && m.status === 'committed',
            ),
        )
        .map(([id, p]) => ({
          id: `preview:${id}`,
          role: 'assistant' as const,
          parts: [
            {
              id: `${id}:text`,
              kind: 'text' as const,
              text: p.incomplete ? '实时预览不完整，正在等待服务端保存完整回复…' : p.text,
            },
          ],
          status: '生成中，尚未保存',
        })),
    ],
    [snapshot, previews, query.isError],
  );
  const active = snapshot?.runs.find((r) =>
    ['running', 'waiting-approval', 'queued'].includes(r.status),
  );
  const lastRun = snapshot?.runs.at(-1);
  const command = async (operation: () => Promise<unknown>) => {
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const composerDisabled =
    query.isError ||
    !hydrated ||
    !offline.online ||
    !offline.verified ||
    !capabilities.data?.enabled;
  const preparePrompt = (prompt: string) => {
    setDraft((current) => (current.trim() ? current : prompt));
    inputRef.current?.focus();
  };
  const submit = async () => {
    if (composerDisabled || submitting || active || !draft.trim()) return;
    const text = draft;
    if (!pending.current || pending.current.text !== text)
      pending.current = {
        text,
        input: { clientMessageId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), text },
      };
    setSubmitting(true);
    try {
      let id = conversationId;
      if (offline.identity)
        await writeRecord(offline.identity, 'chat-draft', storageKey, {
          conversationId: id,
          draft,
          pending: pending.current.input,
        });
      if (!id) {
        const created = await createWritingConversation({ sourceDocumentIds });
        id = created.conversation.id;
        if (!mounted.current) return;
        setConversationId(id);
        cache.setQueryData(['writing-chat', identityKey, scope, id], created);
      }
      if (offline.identity)
        await writeRecord(offline.identity, 'chat-draft', storageKey, {
          conversationId: id,
          draft,
          pending: pending.current.input,
        });
      const accepted = await submitWritingMessage(id, pending.current.input);
      if (!mounted.current) return;
      cache.setQueryData(['writing-chat', identityKey, scope, id], accepted.snapshot);
      setConnection((current) => current + 1);
      setDraft((current) => (current === text ? '' : current));
      pending.current = null;
      setError('');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };
  const decide = async (approvalId: string, decision: 'allow-once' | 'reject') => {
    if (deciding) return;
    const previous = decisions.current.get(approvalId);
    const input =
      previous?.decision === decision
        ? previous
        : { approvalId, decisionId: crypto.randomUUID(), decision };
    decisions.current.set(approvalId, input);
    setDeciding(approvalId);
    try {
      await command(async () => {
        await decideWritingApproval(conversationId, input);
        await query.refetch();
      });
    } finally {
      if (mounted.current) setDeciding(null);
    }
  };
  return (
    <Chat
      messages={messages}
      emptyState={
        !hydrated || (conversationId && query.isFetching) ? (
          <p role="status" className="py-8 text-center text-xs text-muted-foreground">
            正在打开对话…
          </p>
        ) : (
          !query.isError && (
            <div className="mx-auto max-w-sm px-1 py-8">
              <div className="mb-5 grid size-11 place-items-center rounded-2xl bg-primary/8 text-primary">
                <Sparkles size={21} strokeWidth={1.6} aria-hidden="true" />
              </div>
              <h2 className="text-xl font-semibold tracking-tight">今天想写点什么？</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                描述你想写的内容，和知书一起打磨。满意的回复可以直接存成文档。
              </p>
              <div className="mt-5 grid gap-2">
                {starters.map(({ icon: Icon, label, prompt }) => (
                  <button
                    key={label}
                    type="button"
                    className="flex w-full items-center gap-2.5 text-left text-xs"
                    disabled={composerDisabled || !!draft.trim()}
                    onClick={() => {
                      if (label === '根据资料整理' && !sourceDocumentIds.length) onPickSources();
                      else preparePrompt(prompt);
                    }}
                  >
                    <Icon size={15} aria-hidden="true" className="text-primary" />
                    <span className="flex-1 py-1">{label}</span>
                    <ArrowUpRight size={13} aria-hidden="true" className="text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>
          )
        )
      }
      header={
        <div className="zhishu-chat-header">
          <span>{conversationId ? '当前对话' : '写作助手'}</span>
          <button
            type="button"
            disabled={!conversationId || submitting || !!active}
            onClick={() => {
              setConversationId('');
              setPreviews({});
              pending.current = null;
            }}
          >
            <Plus size={14} aria-hidden="true" /> 新对话
          </button>
        </div>
      }
      renderText={(text, message) =>
        message.role === 'assistant' ? (
          <WritingMarkdown text={text} />
        ) : (
          <p className="whitespace-pre-wrap">{text}</p>
        )
      }
      messageActions={(message) => {
        if (message.role !== 'assistant' || message.status) return null;
        const part = message.parts[0];
        if (part?.kind !== 'text' || !part.text.trim()) return null;
        return (
          <>
            <button
              type="button"
              disabled={previewDisabled}
              onClick={() => onPreview({ id: message.id, text: part.text })}
            >
              <FileText size={14} aria-hidden="true" /> 预览为文档
            </button>
            {message.id === messages.at(-1)?.id && !active && (
              <button
                type="button"
                disabled={composerDisabled || !!draft.trim()}
                onClick={() => preparePrompt('请把上一版写得更清楚、紧凑，保留关键事实。')}
              >
                继续打磨
              </button>
            )}
          </>
        );
      }}
      status={
        <>
          <ChatStatus error={!!error || query.isError || lastRun?.status === 'failed'}>
            {error ||
              (query.isError
                ? '读取失败，请重连或开启新对话'
                : active
                  ? active.status === 'waiting-approval'
                    ? '等待审批'
                    : '正在生成'
                  : lastRun?.status === 'failed'
                    ? '本次回复未完成，已保存的消息仍可读取。可以调整输入后重发。'
                    : lastRun?.status === 'cancelled'
                      ? '本次生成已停止，未完成草稿不会写入正文。'
                      : lastRun?.status === 'interrupted'
                        ? '本次回复已中断，可尝试恢复原请求。'
                        : capabilities.isError
                          ? '暂时无法检查写作服务'
                          : capabilities.data && !capabilities.data.enabled
                            ? '写作模型尚未配置'
                            : '')}
          </ChatStatus>
          {error && (
            <button
              onClick={() =>
                void command(async () => {
                  await query.refetch();
                  setConnection((c) => c + 1);
                })
              }
            >
              重新连接
            </button>
          )}
        </>
      }
      afterMessages={
        <>
          {' '}
          {!query.isError && (
            <>
              {snapshot?.runs
                .filter((r) => r.status === 'interrupted')
                .map((run) => (
                  <button
                    key={run.id}
                    onClick={() =>
                      void command(async () => {
                        await resumeWritingRun(conversationId, run.id);
                        await query.refetch();
                      })
                    }
                  >
                    恢复未完成的回复
                  </button>
                ))}
              {snapshot?.approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  title={approval.action === 'create_image' ? '创建文章配图' : approval.action}
                  description={approval.description}
                  status={approval.status}
                  busy={deciding !== null}
                  onAllow={() => void decide(approval.id, 'allow-once')}
                  onReject={() => void decide(approval.id, 'reject')}
                />
              ))}
              {conversationId && !query.isError && (
                <ImageArtifacts
                  identityKey={identityKey}
                  conversationId={conversationId}
                  generating={!!active}
                />
              )}
            </>
          )}{' '}
        </>
      }
      composer={
        <Composer
          inputRef={inputRef}
          value={draft}
          maxLength={32000}
          onValueChange={setDraft}
          onSubmit={submit}
          submitting={submitting}
          disabled={composerDisabled}
          placeholder="写下你的想法，或继续修改上一版…"
          busy={!!active}
          stopping={stopping || !!active?.cancelRequested}
          onStop={
            active
              ? async () => {
                  setStopping(true);
                  await command(async () => {
                    await cancelWritingRun(conversationId, active.id);
                    await query.refetch();
                  });
                  setStopping(false);
                }
              : undefined
          }
          attachments={sourceLabels.map((label, index) => ({
            id: sourceDocumentIds[index]!,
            label,
          }))}
          toolbarStart={
            <button type="button" onClick={onPickSources} disabled={submitting || !!active}>
              <span className="inline-flex items-center gap-1">
                <Plus size={13} aria-hidden="true" /> 资料
              </span>
            </button>
          }
          toolbarEnd={<span className="hidden sm:inline">Shift + Enter 换行</span>}
        />
      }
    />
  );
}
