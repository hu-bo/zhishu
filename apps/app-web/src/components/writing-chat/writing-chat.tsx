import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Chat, Composer, ChatStatus, ApprovalCard, type MessageView } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import {
  applyChatEvent,
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
} from '@/api/generated/app-api';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';
import { useOfflineState } from '@/features/offline/cache';
import { errorMessage } from '@/api/api-error';
import { observeWriting } from './transport';
import { ImageArtifacts } from './image-artifacts';

export function WritingChat({
  identityKey,
  scope,
  sourceDocumentIds,
  onUseForWriting,
}: {
  identityKey: string;
  scope: string;
  sourceDocumentIds: string[];
  onUseForWriting(text: string): void;
}) {
  const offline = useOfflineState(),
    cache = useQueryClient();
  const storageKey = JSON.stringify(['writing', identityKey, scope, [...sourceDocumentIds].sort()]);
  const [conversationId, setConversationId] = useState(''),
    [draft, setDraft] = useState(''),
    [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState(''),
    [submitting, setSubmitting] = useState(false),
    [stopping, setStopping] = useState(false),
    [connection, setConnection] = useState(0);
  const [previews, setPreviews] = useState<
    Record<
      string,
      { text: string; epoch: string; attempt: number; revision: number; index: number }
    >
  >({});
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
    void readRecord(offline.identity, 'chat-draft', storageKey)
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
  }, [offline.identity, storageKey]);
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
          setPreviews((current) => {
            const previous = current[frame.runId];
            const same =
              previous?.epoch === frame.streamEpoch &&
              previous.attempt === frame.attempt &&
              previous.revision === frame.revision;
            if (same && previous.index >= frame.index) return current;
            return {
              ...current,
              [frame.runId]: {
                text: ((same ? previous.text : '') + frame.text).slice(0, 128000),
                epoch: frame.streamEpoch,
                attempt: frame.attempt,
                revision: frame.revision,
                index: frame.index,
              },
            };
          });
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
          parts: [{ id: `${id}:text`, kind: 'text' as const, text: p.text }],
          status: '生成中，尚未保存',
        })),
    ],
    [snapshot, previews, query.isError],
  );
  const active = snapshot?.runs.find((r) =>
    ['running', 'waiting-approval', 'queued'].includes(r.status),
  );
  const command = async (operation: () => Promise<unknown>) => {
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const submit = async () => {
    if (submitting || !draft.trim()) return;
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
      setDraft((current) => (current === text ? '' : current));
      pending.current = null;
      setError('');
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };
  return (
    <Chat
      messages={messages}
      emptyState={<p>从想法开始，一起打磨文章。生成的内容由你检查后再写入文档。</p>}
      header={
        <div className="flex items-center justify-between px-4 py-2 text-xs">
          <span>写作对话</span>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setConversationId('');
              setPreviews({});
              pending.current = null;
            }}
          >
            新对话
          </button>
        </div>
      }
      messageActions={(message) =>
        message.role === 'assistant' && !message.id.startsWith('preview:') ? (
          <button
            onClick={() =>
              onUseForWriting(
                message.parts
                  .filter((p) => p.kind === 'text')
                  .map((p) => p.text)
                  .join('\n'),
              )
            }
          >
            用于写作
          </button>
        ) : null
      }
      status={
        <>
          <ChatStatus error={!!error || query.isError}>
            {error ||
              (query.isError
                ? '读取失败，请重连或开启新对话'
                : active
                  ? active.status === 'waiting-approval'
                    ? '等待审批'
                    : '正在生成'
                  : snapshot
                    ? '对话已保存；正文由你确认后写入'
                    : capabilities.data?.enabled
                      ? ''
                      : '写作模型尚未配置')}
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
                  onAllow={() =>
                    void command(async () => {
                      await decideWritingApproval(conversationId, {
                        approvalId: approval.id,
                        decisionId: crypto.randomUUID(),
                        decision: 'allow-once',
                      });
                      await query.refetch();
                    })
                  }
                  onReject={() =>
                    void command(async () => {
                      await decideWritingApproval(conversationId, {
                        approvalId: approval.id,
                        decisionId: crypto.randomUUID(),
                        decision: 'reject',
                      });
                      await query.refetch();
                    })
                  }
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
          value={draft}
          onValueChange={setDraft}
          onSubmit={submit}
          submitting={submitting}
          disabled={
            query.isError ||
            !hydrated ||
            !offline.online ||
            !offline.verified ||
            !capabilities.data?.enabled
          }
          busy={!!active}
          stopping={stopping}
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
          toolbarEnd={<small>{capabilities.data?.image.reason ?? '正在读取图片能力'}</small>}
        />
      }
    />
  );
}
