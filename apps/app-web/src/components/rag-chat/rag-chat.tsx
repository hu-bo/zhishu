import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Chat, ChatStatus, Composer, type MessageView } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import {
  cancelAiTask,
  getAiTask,
  resumeAiTask,
  getAiCapabilities,
  getKnowledgeIndexStatus,
} from '@/api/generated/ai';
import { consumeRagTask } from './transport';
import { useOfflineState } from '@/features/offline/cache';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';
import { errorMessage } from '@/api/api-error';
import type { StartAiChatBody } from '@/api/generated/app-api.schemas';
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
      body = {
        protocolVersion: 2,
        request: checked.data,
        sourceDocumentIds: value.sourceIds,
        ...('sourceWorkspaceId' in value.body && typeof value.body.sourceWorkspaceId === 'string'
          ? { sourceWorkspaceId: value.body.sourceWorkspaceId }
          : {}),
      };
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
  const [scopeMode, setScopeMode] = useState<'documents' | 'workspace' | 'all'>(
    sourceDocumentIds.length ? 'documents' : scope === 'all' ? 'all' : 'workspace',
  );
  const selectedIds = scopeMode === 'documents' ? sourceDocumentIds : [];
  const workspaceId = scopeMode === 'workspace' && scope !== 'all' ? scope : undefined;
  const storageKey = JSON.stringify(['rag-v2', identityKey, scope, scopeMode, selectedIds]);
  const capabilities = useQuery({
    queryKey: ['knowledge-capabilities', identityKey],
    queryFn: ({ signal }) => getAiCapabilities({ signal }),
    enabled: offline.online && offline.verified,
  });
  const indexStatus = useQuery({
    queryKey: ['knowledge-index', identityKey, workspaceId, selectedIds],
    queryFn: ({ signal }) =>
      getKnowledgeIndexStatus(
        { workspaceId, documentIds: selectedIds.length ? selectedIds.join(',') : undefined },
        { signal },
      ),
    enabled:
      offline.online &&
      offline.verified &&
      !!capabilities.data?.knowledge.enabled &&
      (scopeMode !== 'documents' || !!selectedIds.length),
    refetchInterval: 3000,
    retry: false,
  });
  const indexReady =
    !!indexStatus.data && indexStatus.data.pending === 0 && indexStatus.data.failed === 0;
  const [draft, setDraft] = useState(''),
    [questions, setQuestions] = useState<Question[]>([]),
    [hydratedKey, setHydratedKey] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const hydrated = hydratedKey === storageKey;
  const connection = useRef<AbortController | null>(null),
    inflight = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!offline.identity) return;
    void readRecord(offline.identity, 'chat-draft', storageKey)
      .then(async (value) => {
        if (value || scope !== 'all') return value;
        const legacy =
          (await readRecord(offline.identity!, 'ai-draft', 'writing-proposals')) ??
          (await readRecord(offline.identity!, 'ai-draft', 'current'));
        if (
          !legacy ||
          typeof legacy !== 'object' ||
          !('messages' in legacy) ||
          !Array.isArray(legacy.messages)
        )
          return value;
        return {
          draft: '',
          questions: legacy.messages
            .flatMap((message: unknown) => {
              if (
                !message ||
                typeof message !== 'object' ||
                !('body' in message) ||
                !('id' in message)
              )
                return [];
              const body = message.body;
              if (
                !body ||
                typeof body !== 'object' ||
                !('request' in body) ||
                !('sourceDocumentIds' in body)
              )
                return [];
              const checked = validateChatRequest(body.request);
              if (!checked.success || checked.data.requestId !== message.id) return [];
              return [
                {
                  id: message.id,
                  text: checked.data.message,
                  sourceIds: body.sourceDocumentIds,
                  body,
                },
              ];
            })
            .slice(-16),
        };
      })
      .then((value) => {
        if (!active) return;
        setDraft('');
        setQuestions([]);
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
        setHydratedKey(storageKey);
      })
      .catch(() => {
        if (active) {
          setHydratedKey(storageKey);
          setError('问答草稿读取失败');
        }
      });
    return () => {
      active = false;
      connection.current?.abort();
    };
  }, [offline.identity, storageKey, scope]);
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
    if (
      busy ||
      connection.current ||
      !draft.trim() ||
      !indexReady ||
      (scopeMode === 'documents' && !selectedIds.length)
    )
      return;
    const text = draft;
    const pendingQuestion = questions.find(
      (q) =>
        q.registered === false &&
        q.text === text &&
        JSON.stringify(q.sourceIds) === JSON.stringify(selectedIds),
    );
    const id = pendingQuestion?.id ?? crypto.randomUUID();
    setBusy(true);
    const stop = new AbortController();
    connection.current = stop;
    inflight.current = id;
    const body: StartAiChatBody = pendingQuestion?.body ?? {
      protocolVersion: 2,
      sourceDocumentIds: [...selectedIds],
      ...(workspaceId ? { sourceWorkspaceId: workspaceId } : {}),
      request: {
        kind: 'chat',
        requestId: id,
        message: text,
        responseMode: 'grounded',
        contextRef: selectedIds.length
          ? 'selected-documents'
          : workspaceId
            ? 'workspace'
            : 'accessible-knowledge',
        previousRequestIds: questions
          .filter((_, i) => queries[i]?.data?.status === 'completed')
          .map((q) => q.id),
      },
    };
    const q: Question = { id, text, sourceIds: [...selectedIds], registered: false, body };
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
      emptyState={<p>向空间或所选文档提问，回答将检索已保存的正文，并附上原文引用。</p>}
      header={
        <div className="zhishu-chat-header">
          <select
            aria-label="提问范围"
            className="min-w-0 rounded-lg border bg-background px-2 py-1.5"
            value={scopeMode}
            disabled={busy || !!active}
            onChange={(event) => setScopeMode(event.target.value as typeof scopeMode)}
          >
            <option value="documents" disabled={!sourceDocumentIds.length}>
              所选文档（{sourceDocumentIds.length}）
            </option>
            {scope !== 'all' && <option value="workspace">当前空间</option>}
            <option value="all">所有可访问资料</option>
          </select>
          <button type="button" disabled={busy || !!active} onClick={() => setQuestions([])}>
            新问答
          </button>
        </div>
      }
      status={
        <ChatStatus
          error={
            !!error || capabilities.isError || indexStatus.isError || !!indexStatus.data?.failed
          }
        >
          {error ||
            (capabilities.isError
              ? '暂时无法检查知识检索服务，请重试。'
              : capabilities.data && !capabilities.data.knowledge.enabled
                ? '知识问答尚未启用，请联系管理员配置知识检索服务。'
                : '') ||
            (indexStatus.isError
              ? errorMessage(indexStatus.error)
              : !indexStatus.data
                ? '正在检查知识索引…'
                : indexStatus.data.failed
                  ? `有 ${indexStatus.data.failed} 篇文档向量化失败，请联系管理员检查服务，恢复后会自动重试。`
                  : indexStatus.data.pending
                    ? `正在向量化：${indexStatus.data.ready}/${indexStatus.data.total} 篇就绪，请稍候。`
                    : `已索引 ${indexStatus.data.ready} 篇文档。回答附有原文引用，请核对来源。`)}
          {(capabilities.isError || indexStatus.isError) && (
            <button
              className="ml-2 underline"
              onClick={() => {
                void capabilities.refetch();
                void indexStatus.refetch();
              }}
            >
              重试
            </button>
          )}
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
                <button
                  onClick={() =>
                    onUseForWriting(
                      answerText(task.result),
                      q.sourceIds.length
                        ? q.sourceIds
                        : 'citations' in task.result!
                          ? [...new Set(task.result.citations.map((c) => c.source.sourceId))].slice(
                              0,
                              4,
                            )
                          : [],
                    )
                  }
                >
                  用于写作
                </button>
                {'citations' in task.result && task.result.citations.length > 0 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      查看 {task.result.citations.length} 条原文引用
                    </summary>
                    {task.result.citations.map((c) => (
                      <blockquote key={c.citationId} className="my-2 border-l pl-3 text-xs">
                        {c.quote}
                        <Link
                          to="/documents/$documentId"
                          params={{ documentId: c.source.sourceId }}
                          className="block text-muted-foreground underline"
                        >
                          打开来源文档
                        </Link>
                      </blockquote>
                    ))}
                  </details>
                )}
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
            !indexReady ||
            (scopeMode === 'documents' && !selectedIds.length) ||
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
