import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Chat, ChatStatus, Composer, type MessageView } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import { cancelAiTask, getAiTask, resumeAiTask } from '@/api/generated/app-api';
import { consumeRagTask } from './transport';
import { useOfflineState } from '@/features/offline/cache';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';
import { errorMessage } from '@/api/api-error';
import type { StartAiChatBody } from '@/api/generated/models';
import { validateChatRequest } from '@zhishu/ai-contracts';

function answerText(result: unknown): string {
  return result && typeof result === 'object' && 'text' in result && typeof result.text === 'string'
    ? result.text
    : '';
}

interface Question {
  id: string;
  text: string;
  sourceIds: string[];
  registered?: boolean;
  body?: StartAiChatBody;
}
function readQuestion(value: unknown): Question | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    !('sourceIds' in value) ||
    !Array.isArray(value.sourceIds) ||
    !value.sourceIds.every((id: unknown) => typeof id === 'string')
  )
    return;
  let body: StartAiChatBody | undefined;
  if ('body' in value && value.body && typeof value.body === 'object' && 'request' in value.body) {
    const checked = validateChatRequest(value.body.request);
    if (checked.success)
      body = { protocolVersion: 2, request: checked.data, sourceDocumentIds: value.sourceIds };
  }
  return {
    id: value.id,
    text: value.text,
    sourceIds: value.sourceIds,
    registered: !('registered' in value && value.registered === false),
    body,
  };
}
export function RagChat({
  identityKey,
  scope,
  sourceDocumentIds,
  onUseForWriting,
}: {
  identityKey: string;
  scope: string;
  sourceDocumentIds: string[];
  onUseForWriting(text: string, sourceIds: string[]): void;
}) {
  const offline = useOfflineState(),
    cache = useQueryClient();
  const storageKey = JSON.stringify(['rag', identityKey, scope]);
  const [draft, setDraft] = useState(''),
    [questions, setQuestions] = useState<Question[]>([]),
    [hydrated, setHydrated] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const connection = useRef<AbortController | null>(null),
    inflight = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!offline.identity) return;
    void readRecord(offline.identity, 'chat-draft', storageKey)
      .then((value) => {
        if (!active) return;
        if (value && typeof value === 'object') {
          if ('draft' in value && typeof value.draft === 'string') setDraft(value.draft);
          if ('questions' in value && Array.isArray(value.questions))
            setQuestions(
              value.questions
                .map(readQuestion)
                .filter((q): q is Question => !!q)
                .slice(-16),
            );
        }
        setHydrated(true);
      })
      .catch(() => {
        if (active) {
          setHydrated(true);
          setError('问答草稿读取失败');
        }
      });
    return () => {
      active = false;
      connection.current?.abort();
    };
  }, [offline.identity, storageKey]);
  useEffect(() => {
    if (!hydrated || !offline.identity) return;
    const timer = setTimeout(() => {
      void writeRecord(offline.identity!, 'chat-draft', storageKey, { draft, questions }).catch(
        () => setError('问答草稿保存失败'),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [hydrated, offline.identity, storageKey, draft, questions]);
  const latest = useRef({ draft, questions, hydrated });
  useLayoutEffect(() => {
    latest.current = { draft, questions, hydrated };
  }, [draft, questions, hydrated]);
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
  const queries = useQueries({
    queries: questions.map((q) => ({
      queryKey: ['rag-chat', identityKey, scope, q.id],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const task = await getAiTask(q.id, { signal });
        if (task.kind !== 'chat') throw new Error('此记录不属于知识问答');
        return task;
      },
      enabled: offline.online && offline.verified && q.registered !== false,
      retry: false,
      refetchInterval: (query: { state: { data?: { status: string } } }) =>
        query.state.data?.status === 'running' ? 1000 : false,
    })),
  });
  const messages: MessageView[] = questions.flatMap((q, i) => {
    const task = queries[i]?.data;
    const text =
      task?.status === 'completed' && task.result
        ? answerText(task.result)
        : task?.status === 'interrupted'
          ? '回答已中断，可恢复原问答。'
          : task?.status === 'cancelled'
            ? '已停止本次问答。'
            : task?.status === 'failed'
              ? '本次问答未完成。'
              : '正在读取和生成回答…';
    return [
      {
        id: q.id,
        role: 'user' as const,
        parts: [{ id: `${q.id}:question`, kind: 'text' as const, text: q.text }],
      },
      {
        id: `answer:${q.id}`,
        role: 'assistant' as const,
        parts: [
          {
            id: `${q.id}:answer`,
            kind: 'text' as const,
            text: queries[i]?.isError ? '来源已不可访问或请求读取失败，请重新选择资料。' : text,
          },
        ],
      },
    ];
  });
  const active = questions.find((_, i) => queries[i]?.data?.status === 'running');
  const run = async (operation: () => Promise<unknown>) => {
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const send = async () => {
    if (busy || connection.current || !draft.trim() || !sourceDocumentIds.length) return;
    const text = draft;
    const pendingQuestion = questions.find(
      (q) =>
        q.registered === false &&
        q.text === text &&
        JSON.stringify(q.sourceIds) === JSON.stringify(sourceDocumentIds),
    );
    const id = pendingQuestion?.id ?? crypto.randomUUID();
    setBusy(true);
    const stop = new AbortController();
    connection.current = stop;
    inflight.current = id;
    const body: StartAiChatBody = pendingQuestion?.body ?? {
      protocolVersion: 2,
      sourceDocumentIds: [...sourceDocumentIds],
      request: {
        kind: 'chat',
        requestId: id,
        message: text,
        responseMode: 'grounded',
        contextRef: 'selected-documents',
        previousRequestIds: questions
          .filter((_, i) => queries[i]?.data?.status === 'completed')
          .map((q) => q.id),
      },
    };
    const q: Question = { id, text, sourceIds: [...sourceDocumentIds], registered: false, body };
    setQuestions((current) =>
      current.some((item) => item.id === id)
        ? current.map((item) => (item.id === id ? q : item))
        : [...current, q].slice(-16),
    );
    try {
      if (offline.identity)
        await writeRecord(offline.identity, 'chat-draft', storageKey, {
          draft,
          questions: questions.some((item) => item.id === id)
            ? questions
            : [...questions, q].slice(-16),
        });
      await consumeRagTask(body, stop.signal, (event) => {
        if (event.type === 'started') {
          setQuestions((current) =>
            current.map((item) => (item.id === id ? { ...item, registered: true } : item)),
          );
          void cache.invalidateQueries({ queryKey: ['rag-chat', identityKey, scope, id] });
        }
        setDraft((current) => (current === text ? '' : current));
      });
      setDraft((current) => (current === text ? '' : current));
      setQuestions((current) =>
        current.map((item) => (item.id === id ? { ...item, registered: true } : item)),
      );
    } catch (cause) {
      if (!stop.signal.aborted) setError(errorMessage(cause));
    } finally {
      connection.current = null;
      inflight.current = null;
      setBusy(false);
      void cache.invalidateQueries({ queryKey: ['rag-chat', identityKey, scope] });
    }
  };
  return (
    <Chat
      messages={messages}
      emptyState={<p>选择知识资料后提问，回答与来源保留在独立问答中。</p>}
      header={
        <div className="px-4 py-2 text-xs">
          知识问答{' '}
          <button disabled={busy || !!active} onClick={() => setQuestions([])}>
            新问答
          </button>
        </div>
      }
      status={
        <ChatStatus error={!!error}>
          {error ||
            (!sourceDocumentIds.length ? '请先添加知识资料' : '回答由所选资料生成，请核对来源。')}
        </ChatStatus>
      }
      messageActions={(message) => {
        if (!message.id.startsWith('answer:')) return null;
        const index = questions.findIndex((q) => `answer:${q.id}` === message.id),
          task = queries[index]?.data,
          q = questions[index];
        if (!q || queries[index]?.isError) return null;
        return (
          <>
            {task?.status === 'interrupted' && (
              <button
                onClick={() =>
                  void run(async () => {
                    await resumeAiTask(q.id);
                    await queries[index]?.refetch();
                  })
                }
              >
                恢复问答
              </button>
            )}
            {task?.status === 'completed' && task.result && (
              <>
                <button onClick={() => onUseForWriting(answerText(task.result), q.sourceIds)}>
                  用于写作
                </button>
                {'citations' in task.result &&
                  task.result.citations.map((c) => (
                    <blockquote key={c.citationId} className="my-2 border-l pl-3 text-xs">
                      {c.quote}
                      <span className="block text-muted-foreground">来源：{c.source.sourceId}</span>
                    </blockquote>
                  ))}
              </>
            )}
          </>
        );
      }}
      composer={
        <Composer
          value={draft}
          onValueChange={setDraft}
          onSubmit={send}
          submitting={busy}
          disabled={
            !hydrated ||
            !offline.online ||
            !offline.verified ||
            !sourceDocumentIds.length ||
            questions.length >= 16
          }
          busy={busy || !!active}
          onStop={
            active || busy
              ? () =>
                  run(async () => {
                    await cancelAiTask(active?.id ?? inflight.current!);
                    connection.current?.abort();
                    await cache.invalidateQueries({ queryKey: ['rag-chat', identityKey, scope] });
                  })
              : undefined
          }
        />
      }
    />
  );
}
