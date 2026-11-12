import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyAiEvent,
  type AiEvent,
  type ConversationSnapshot,
  type PreviewFrame,
  type PreviewState,
} from '@zhishu/chat-contracts';
import type { Citation, ScopeSelection } from '@zhishu/ai-contracts';
import { Chat, ChatStatus, Composer, type MessageView } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import { listKnowledgeWorkspaces } from '../../api/generated/knowledge';
import { getAccessToken } from '../../api/transport';
import { readRecord, writeRecord, writeRecordOnPageExit } from '../../features/offline/storage';
import type { ConversationTransport } from '../../components/chat/conversation-transport';
import {
  cancelRun,
  createConversation,
  fetchSnapshot,
  mergePreview,
  observeConversation,
  retryRun,
  submitMessage,
  updateScope,
} from '../../components/chat/conversation-transport';
import { CitationList, CitationText } from '../../components/chat/citations';
import { useCitationPresentations } from '../../components/chat/citation-model';
import { ScopePicker } from './scope-picker';
import { errorMessage } from '../../api/api-error';

interface PendingMessage {
  clientMessageId: string;
  idempotencyKey: string;
  text: string;
}

export interface QaChatProps {
  /** Durable conversation transport (internal /api/ai/qa or the public visitor namespace). */
  transport: ConversationTransport;
  /** identity-scoped draft storage key parts (workspace/document where the panel is open). */
  scopeKey: unknown[];
  /** Preset selection for document-scoped panels. */
  initialScope?: ScopeSelection;
  /** Internal identities only: enables “write from these sources”. */
  canHandoff?: boolean;
  onHandoff?: (input: { conversationId: string; messageId: string; documentIds: string[] }) => void;
  /** Title of the document scope shown in the compact scope control. */
  documentLabel?: { documentId: string; title: string };
  /** Public entry presentation. */
  welcome?: string;
  suggested?: string[];
  /** Attach an existing conversation (public list or handoff navigation). */
  initialConversationId?: string | null;
  onNewConversation?: () => void;
  className?: string;
}

export function QaChat({
  transport,
  scopeKey,
  initialScope,
  canHandoff,
  onHandoff,
  documentLabel,
  welcome,
  suggested,
  initialConversationId,
  onNewConversation,
  className,
}: QaChatProps) {
  void onNewConversation;
  const identityKey = getAccessToken() ?? 'anonymous';
  const storageKey = JSON.stringify(['qa-v2', identityKey, ...scopeKey]);
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<ScopeSelection>(initialScope ?? { kind: 'all' });
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void readRecord(identityKey, 'chat-draft', storageKey).then((value) => {
      const stored = value as { conversationId?: string; draft?: string } | null;
      if (!mounted.current) return;
      if (stored?.conversationId) setConversationId(stored.conversationId);
      if (stored?.draft) setDraft(stored.draft);
      setHydrated(true);
    });
  }, [identityKey, storageKey]);

  const snapshotQuery = useQuery({
    queryKey: ['qa-chat', identityKey, conversationId ?? ''],
    queryFn: () => fetchSnapshot(transport, conversationId!),
    enabled: hydrated && !!conversationId,
    structuralSharing: (previous: unknown, next: unknown) => {
      const current = previous as ConversationSnapshot;
      const incoming = next as ConversationSnapshot;
      // Server snapshots never rewind the local cursor.
      return BigInt(incoming.cursor) >= BigInt(current.cursor) ? incoming : current;
    },
  });
  const snapshot: ConversationSnapshot | null = snapshotQuery.data ?? null;

  // Live durable events merge into the cached snapshot; a gap resyncs from the server.
  useEffect(() => {
    if (!conversationId || !snapshot) return;
    const stop = new AbortController();
    observeConversation({
      transport,
      conversationId,
      cursor: snapshot.cursor,
      signal: stop.signal,
      onEvent: (event: AiEvent) => {
        queryClient.setQueryData<ConversationSnapshot>(
          ['qa-chat', identityKey, conversationId],
          (current) => (current ? (applyAiEvent(current, event) ?? current) : current),
        );
      },
      onPreview: (frame: PreviewFrame) => setPreviews((current) => mergePreview(current, frame)),
      onResync: () =>
        void queryClient.refetchQueries({ queryKey: ['qa-chat', identityKey, conversationId] }),
    });
    return () => stop.abort();
    // The cursor is intentionally captured once per connection generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, !!snapshot, identityKey]);

  const persist = useCallback(
    (sync: boolean) => {
      if (!hydrated) return;
      const record = { conversationId, draft };
      void (sync ? writeRecordOnPageExit : writeRecord)(
        identityKey,
        'chat-draft',
        storageKey,
        record,
      );
    },
    [conversationId, draft, hydrated, identityKey, storageKey],
  );
  useEffect(() => {
    const timer = setTimeout(() => persist(false), 200);
    return () => clearTimeout(timer);
  }, [draft, conversationId, persist]);
  useEffect(() => {
    const flush = () => persist(true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [persist]);

  const runs = snapshot?.runs ?? [];
  const activeRun = runs.find((run) =>
    ['queued', 'running', 'waiting-approval'].includes(run.status),
  );
  const messages = useMemo(
    () => buildMessages(snapshot, previews, transport),
    [snapshot, previews, transport],
  );
  const lastUser = [...(snapshot?.messages ?? [])].reverse().find((m) => m.role === 'user');

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const created = await createConversation<{ id: string }>(transport, { scope });
    setConversationId(created.id);
    return created.id;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || activeRun) return;
    setBusy(true);
    try {
      const id = await ensureConversation();
      const message: PendingMessage = {
        clientMessageId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        text: trimmed,
      };
      setPending(message);
      await submitMessage(
        transport,
        id,
        {
          clientMessageId: message.clientMessageId,
          idempotencyKey: message.idempotencyKey,
          text: trimmed,
          expectedContextRevision: (await fetchSnapshot(transport, id)).conversation
            .contextRevision,
        },
        new AbortController().signal,
      ).catch(async (error: unknown) => {
        if (isRevisionConflict(error)) {
          const fresh = await fetchSnapshot(transport, id);
          queryClient.setQueryData(['qa-chat', identityKey, id], fresh);
          return submitMessage(
            transport,
            id,
            {
              clientMessageId: message.clientMessageId,
              idempotencyKey: message.idempotencyKey,
              text: trimmed,
              expectedContextRevision: fresh.conversation.contextRevision,
            },
            new AbortController().signal,
          );
        }
        throw error;
      });
      setDraft('');
      setPending(null);
      await queryClient.refetchQueries({ queryKey: ['qa-chat', identityKey, id] });
    } catch (error) {
      setDraft(trimmed);
      queryClient.setQueryData(['qa-chat-error', identityKey], errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeScope(next: ScopeSelection) {
    if (!conversationId) {
      setScope(next);
      return;
    }
    await updateScope(transport, conversationId, {
      scope: next,
      expectedContextRevision: snapshot?.conversation.contextRevision ?? 1,
    }).catch((error: unknown) =>
      queryClient.setQueryData(['qa-chat-error', identityKey], errorMessage(error)),
    );
    setScope(next);
    await queryClient.refetchQueries({ queryKey: ['qa-chat', identityKey, conversationId] });
  }

  const workspaces = useQuery({
    queryKey: ['knowledge-workspaces'],
    queryFn: () => listKnowledgeWorkspaces(),
  });

  return (
    <div className={className}>
      <Chat
        messages={messages}
        emptyState={
          <div className="qa-empty">
            <p>{welcome ?? '向知识库提问。回答只基于你有权限访问的资料，并标注引用来源。'}</p>
            {suggested?.length ? (
              <ul className="qa-suggested">
                {suggested.map((question) => (
                  <li key={question}>
                    <button type="button" onClick={() => void send(question)}>
                      {question}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {workspaces.data?.length ? (
              <ScopePicker workspaces={workspaces.data} value={scope} onChange={changeScope} />
            ) : null}
          </div>
        }
        header={
          conversationId ? (
            <ScopePicker
              compact
              workspaces={workspaces.data ?? []}
              value={snapshot?.conversation.scope ?? scope}
              onChange={changeScope}
              documentLabel={documentLabel}
            />
          ) : undefined
        }
        status={
          <ChatStatus error={!!queryClient.getQueryData(['qa-chat-error', identityKey])}>
            {(queryClient.getQueryData(['qa-chat-error', identityKey]) as string | undefined) ??
              (activeRun
                ? activeRun.status === 'queued'
                  ? '排队中…'
                  : '正在检索并生成回答…'
                : snapshot
                  ? '基于当前授权范围的资料回答'
                  : '')}
          </ChatStatus>
        }
        composer={
          <Composer
            value={draft}
            onValueChange={setDraft}
            onSubmit={() => void send(draft)}
            onStop={
              activeRun
                ? () =>
                    void cancelRun(transport, conversationId!, activeRun.id).then(() =>
                      queryClient.refetchQueries({
                        queryKey: ['qa-chat', identityKey, conversationId],
                      }),
                    )
                : undefined
            }
            busy={busy}
            submitting={!!pending || activeRun?.status === 'running'}
            readOnly={snapshot?.conversation.status === 'target-unavailable'}
            placeholder="提出一个问题，例如：这个流程的负责人是谁？"
            maxLength={8000}
            messages={{ send: '提问', stop: '停止' }}
          />
        }
        afterMessages={
          lastUser && snapshot && activeRun?.status === 'failed' ? (
            <div className="qa-failed">
              <span>回答生成失败。</span>
              <button
                type="button"
                onClick={() =>
                  void retryRun<{ kind: string }>(transport, conversationId!, activeRun.id).then(
                    () =>
                      queryClient.refetchQueries({
                        queryKey: ['qa-chat', identityKey, conversationId],
                      }),
                  )
                }
              >
                重试
              </button>
              <button
                type="button"
                onClick={() => send(lastUser.parts.find((p) => p.kind === 'text')?.text ?? '')}
              >
                重新提问
              </button>
            </div>
          ) : undefined
        }
      />
      {canHandoff && onHandoff && lastAssistantWithCitations(snapshot) && conversationId ? (
        <HandoffBar
          conversationId={conversationId}
          messageId={lastAssistantWithCitations(snapshot)!.id}
          snapshot={snapshot!}
          onHandoff={onHandoff}
        />
      ) : null}
    </div>
  );
}

function buildMessages(
  snapshot: ConversationSnapshot | null,
  previews: Record<string, PreviewState>,
  transport: ConversationTransport,
): MessageView[] {
  if (!snapshot) return [];
  const views: MessageView[] = snapshot.messages.map((message) => {
    const citations: Citation[] = message.parts
      .map((p) => (p.kind === 'citation' ? p.citation : undefined))
      .filter((c): c is Citation => !!c);
    return {
      id: message.id,
      role: message.role,
      parts: [
        {
          id: message.id,
          kind: 'plugin' as const,
          type: 'zhishu-answer',
          schemaVersion: 1,
          fallbackText:
            message.parts.find((p) => p.kind === 'text')?.kind === 'text'
              ? message.parts.find((p) => p.kind === 'text')!.text
              : '',
          content: <AnswerBody message={message} transport={transport} />,
        },
        ...message.parts
          .filter(
            (p): p is Extract<(typeof message.parts)[number], { kind: 'artifact' }> =>
              p.kind === 'artifact',
          )
          .map((p) => ({
            id: message.id + ':' + p.artifactId,
            kind: 'plugin' as const,
            type: 'zhishu-' + p.artifactKind,
            schemaVersion: 1,
            fallbackText: p.summary ?? '产物已生成。',
          })),
      ],
      status:
        message.role === 'assistant' && citations.length
          ? `引用 ${citations.length} 条来源`
          : undefined,
    };
  });
  // The active run shows its live preview as a provisional assistant view.
  const running = snapshot.runs.find((run) => ['running', 'waiting-approval'].includes(run.status));
  const preview = running ? previews[running.id] : undefined;
  if (running && preview && !snapshot.messages.some((m) => m.runId === running.id)) {
    views.push({
      id: `preview:${running.id}`,
      role: 'assistant',
      parts: [
        {
          id: `preview-text:${running.id}`,
          kind: 'text',
          text: preview.text + (preview.incomplete ? '（预览不完整，等待最终回答）' : ''),
        },
      ],
      status: '生成中',
    });
  }
  return views;
}

function AnswerBody({
  message,
  transport,
}: {
  message: ConversationSnapshot['messages'][number];
  transport: ConversationTransport;
}) {
  const text = message.parts.find((part) => part.kind === 'text');
  const citations = message.parts
    .filter((part) => part.kind === 'citation')
    .map((part) => (part.kind === 'citation' ? part.citation : undefined))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const { presentations, error } = useCitationPresentations(
    transport,
    message.conversationId,
    citations,
  );
  if (!text || text.kind !== 'text') return null;
  return (
    <div className="qa-answer">
      <p className="qa-answer-text">
        <CitationText text={text.text} citations={presentations} />
      </p>
      {citations.length ? <CitationList citations={presentations} /> : null}
      {error ? <p className="qa-answer-note">{error}</p> : null}
    </div>
  );
}

function lastAssistantWithCitations(snapshot: ConversationSnapshot | null) {
  if (!snapshot) return null;
  return [...snapshot.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.parts.some((p) => p.kind === 'citation'));
}

function HandoffBar({
  conversationId,
  messageId,
  onHandoff,
}: {
  conversationId: string;
  messageId: string;
  snapshot: ConversationSnapshot;
  onHandoff: (input: { conversationId: string; messageId: string; documentIds: string[] }) => void;
}) {
  return (
    <div className="qa-handoff">
      <button
        type="button"
        onClick={() => onHandoff({ conversationId, messageId, documentIds: [] })}
      >
        基于这些资料写作
      </button>
      <span className="qa-handoff-note">将重新校验来源权限与版本，并创建独立写作会话。</span>
    </div>
  );
}

function isRevisionConflict(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: number }).status === 409 &&
    (error as { message?: string }).message?.includes('上下文'),
  );
}
