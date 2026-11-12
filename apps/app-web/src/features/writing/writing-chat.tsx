import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyAiEvent,
  type AiEvent,
  type ConversationSnapshot,
  type PreviewFrame,
  type PreviewState,
} from '@zhishu/chat-contracts';
import type { WritingProposalPayload, ScopeSelection } from '@zhishu/ai-contracts';
import { Chat, ChatStatus, Composer, ApprovalCard, type MessageView } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import { getAccessToken } from '../../api/transport';
import { errorMessage } from '../../api/api-error';
import { readRecord, writeRecord, writeRecordOnPageExit } from '../offline/storage';
import {
  cancelRun,
  fetchSnapshot,
  internalTransport,
  mergePreview,
  observeConversation,
  retryRun,
  submitMessage,
} from '../../components/chat/conversation-transport';
import { ProposalReview } from './proposal-review';
import { ImageArtifacts } from './image-artifacts';

const transport = internalTransport('writing');

export interface WritingEditorContext {
  documentId: string;
  /** Selected block ids from the live editor; empty selects document-level targets. */
  selectionBlockIds: string[];
  /** Ask the user to sync local unsaved edits before generating. */
  hasUnconfirmedChanges: () => boolean;
}

export interface WritingChatProps {
  scopeKey: unknown[];
  targetDocumentId: string | null;
  /** Live editor context provider used when submitting a writing request. */
  getEditorContext?: () => WritingEditorContext | null;
  initialInstruction?: string;
  /** Source ids carried from a QA handoff; verified again server-side. */
  referenceArtifactIds?: string[];
  onTargetChange?: (documentId: string | null) => void;
  /** Handoff/creation routing: attach an existing conversation instead of a stored draft. */
  initialConversationId?: string | null;
  /** Free drafts bubble up so the page can offer “保存为文档”. */
  onDraft?: (text: string) => void;
  className?: string;
}

interface PendingMessage {
  clientMessageId: string;
  idempotencyKey: string;
  text: string;
}

export function WritingChat({
  scopeKey,
  targetDocumentId,
  getEditorContext,
  initialInstruction,
  referenceArtifactIds,
  onTargetChange,
  initialConversationId,
  onDraft,
  className,
}: WritingChatProps) {
  const identityKey = getAccessToken() ?? 'anonymous';
  const storageKey = JSON.stringify([
    'writing-v2',
    identityKey,
    targetDocumentId ?? 'free',
    ...scopeKey,
  ]);
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [draft, setDraft] = useState(initialInstruction ?? '');
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [webSearch, setWebSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const capabilities = useQuery({
    queryKey: ['writing-capabilities'],
    staleTime: 60_000,
    queryFn: async () => {
      const { getWritingCapabilities } = await import('../../api/generated/writing');
      return getWritingCapabilities();
    },
  });

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
    queryKey: ['writing-chat', identityKey, conversationId ?? ''],
    queryFn: () => fetchSnapshot(transport, conversationId!),
    enabled: hydrated && !!conversationId,
    structuralSharing: (previous: unknown, next: unknown) => {
      const current = previous as ConversationSnapshot;
      const incoming = next as ConversationSnapshot;
      return BigInt(incoming.cursor) >= BigInt(current.cursor) ? incoming : current;
    },
  });
  const snapshot: ConversationSnapshot | null = snapshotQuery.data ?? null;

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
          ['writing-chat', identityKey, conversationId],
          (current) => (current ? (applyAiEvent(current, event) ?? current) : current),
        );
        if (event.type === 'artifact.application-updated' || event.type === 'message.created')
          setError(null);
      },
      onPreview: (frame: PreviewFrame) => setPreviews((current) => mergePreview(current, frame)),
      onResync: () =>
        void queryClient.refetchQueries({
          queryKey: ['writing-chat', identityKey, conversationId],
        }),
    });
    return () => stop.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, !!snapshot, identityKey]);

  const persist = useCallback(
    (sync: boolean) => {
      if (!hydrated) return;
      void (sync ? writeRecordOnPageExit : writeRecord)(identityKey, 'chat-draft', storageKey, {
        conversationId,
        draft,
      });
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
    return () => window.removeEventListener('pagehide', flush);
  }, [persist]);

  const runs = snapshot?.runs ?? [];
  const activeRun = runs.find((run) =>
    ['queued', 'running', 'waiting-approval'].includes(run.status),
  );
  const proposals = (snapshot?.artifacts ?? []).filter((artifact) => artifact.kind === 'proposal');
  const openProposal = proposals.find((proposal) =>
    ['pending', 'partial', 'conflict', 'unknown'].includes(proposal.applicationState ?? 'pending'),
  );

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const { createWritingConversation } = await import('../../api/generated/writing');
    const created = await createWritingConversation({ targetDocumentId });
    setConversationId(created.id);
    return created.id;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || activeRun) return;
    if (!capabilities.data?.enabled) {
      setError(capabilities.data?.reason ?? '写作服务未启用');
      return;
    }
    if (webSearch && !capabilities.data.webSearchAvailable) {
      setError('联网调研尚未配置：请服务端配置 TAVILY_API_KEY 后使用，或关闭联网后重试。');
      return;
    }
    const editor = targetDocumentId ? (getEditorContext?.() ?? null) : null;
    if (editor?.hasUnconfirmedChanges()) {
      setError('正文还有未同步的修改，请先等待同步完成再生成。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await ensureConversation();
      const message: PendingMessage = {
        clientMessageId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        text: trimmed,
      };
      setPending(message);
      const body = async () => ({
        clientMessageId: message.clientMessageId,
        idempotencyKey: message.idempotencyKey,
        text: trimmed,
        expectedContextRevision: (await fetchSnapshot(transport, id)).conversation.contextRevision,
        ...(editor
          ? {
              editorContext: {
                documentId: editor.documentId,
                target:
                  editor.selectionBlockIds.length > 0
                    ? { kind: 'selection' as const, blockIds: editor.selectionBlockIds }
                    : { kind: 'document-end' as const, afterBlockId: null },
              },
            }
          : {}),
        ...(webSearch ? { webSearch: true } : {}),
        ...(referenceArtifactIds?.length ? { referenceArtifactIds } : {}),
      });
      await submitMessage(transport, id, await body(), new AbortController().signal).catch(
        async (first: unknown) => {
          if (isRevisionConflict(first)) {
            const fresh = await fetchSnapshot(transport, id);
            queryClient.setQueryData(['writing-chat', identityKey, id], fresh);
            const retryBody = await body();
            return submitMessage(
              transport,
              id,
              {
                ...retryBody,
                expectedContextRevision: fresh.conversation.contextRevision,
              },
              new AbortController().signal,
            );
          }
          throw first;
        },
      );
      setDraft('');
      setPending(null);
      await queryClient.refetchQueries({ queryKey: ['writing-chat', identityKey, id] });
    } catch (cause) {
      setDraft(trimmed);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function decide(approvalId: string, decision: 'allow-once' | 'reject') {
    const { decideWritingApproval } = await import('../../api/generated/writing');
    await decideWritingApproval(conversationId!, approvalId, {
      decisionId: crypto.randomUUID(),
      decision,
    }).catch((error: unknown) => setError(errorMessage(error)));
    await queryClient.refetchQueries({ queryKey: ['writing-chat', identityKey, conversationId] });
  }

  const messages = buildMessages(snapshot, previews);
  const lastFailed = [...runs]
    .reverse()
    .find((run) => run.status === 'failed' || run.status === 'interrupted');
  const latestDraftText = targetDocumentId
    ? null
    : [...(snapshot?.messages ?? [])]
        .reverse()
        .find((m) => m.role === 'assistant')
        ?.parts.find((p) => p.kind === 'text')?.text;

  return (
    <div className={className}>
      <Chat
        messages={messages}
        emptyState={
          <div className="writing-empty">
            <p>
              {targetDocumentId
                ? '描述你的写作要求。草稿与提案需经你确认后才会写入正文。'
                : '自由创作模式：先出草稿，满意后可保存为文档或指定目标文档。'}
            </p>
            <div className="writing-actions">
              <button type="button" onClick={() => send('继续写下去')}>
                继续写作
              </button>
              <button type="button" onClick={() => send('帮我润色改写选中的段落')}>
                润色选段
              </button>
              <button type="button" onClick={() => send('根据参考资料写一篇结构化草稿')}>
                资料成文
              </button>
            </div>
          </div>
        }
        header={
          <div className="writing-header">
            {targetDocumentId ? (
              <span className="writing-target">目标文档已绑定</span>
            ) : (
              <span>未绑定目标文档</span>
            )}
            {onTargetChange && (
              <button
                type="button"
                onClick={() => onTargetChange(targetDocumentId ? null : targetDocumentId)}
              >
                切换目标
              </button>
            )}
          </div>
        }
        status={
          <ChatStatus error={!!error}>
            {error ??
              (activeRun
                ? activeRun.status === 'waiting-approval'
                  ? '等待你的工具审批'
                  : '正在生成…'
                : capabilities.data && !capabilities.data.webSearchAvailable
                  ? '联网调研未开放；平台内写作可用'
                  : '提案需经确认后写入')}
          </ChatStatus>
        }
        afterMessages={
          <>
            {latestDraftText ? (
              <div className="writing-draft-save">
                <button type="button" onClick={() => onDraft?.(latestDraftText)}>
                  保存为文档…
                </button>
              </div>
            ) : null}
            {snapshot && lastFailed && !activeRun ? (
              <div className="writing-failed">
                <span>
                  {lastFailed.status === 'interrupted'
                    ? '执行中断，结果可能需要核对。'
                    : '生成失败。'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void retryRun(transport, conversationId!, lastFailed.id).then(() =>
                      queryClient.refetchQueries({
                        queryKey: ['writing-chat', identityKey, conversationId],
                      }),
                    )
                  }
                >
                  重试（先核对已有结果）
                </button>
              </div>
            ) : null}
            <ImageArtifacts
              transport={transport}
              conversationId={conversationId}
              snapshot={snapshot}
            />
          </>
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
                        queryKey: ['writing-chat', identityKey, conversationId],
                      }),
                    )
                : undefined
            }
            busy={busy}
            submitting={!!pending || !!activeRun}
            stopping={activeRun?.cancelRequested}
            placeholder="例如：把这段改写得更简洁，面向管理层"
            maxLength={32000}
            toolbarStart={
              capabilities.data?.webSearchAvailable ? (
                <label className="writing-web">
                  <input
                    type="checkbox"
                    checked={webSearch}
                    onChange={(e) => setWebSearch(e.target.checked)}
                  />
                  联网调研
                </label>
              ) : (
                <span className="writing-web" title="服务端未配置 TAVILY_API_KEY">
                  联网不可用
                </span>
              )
            }
            messages={{ send: '发送', stop: '停止' }}
          />
        }
      />
      {snapshot && openProposal ? (
        <ProposalReview
          transport={transport}
          conversationId={conversationId!}
          artifactId={openProposal.id}
          reviewRevision={openProposal.reviewRevision ?? 0}
          onResolved={() =>
            void queryClient.refetchQueries({
              queryKey: ['writing-chat', identityKey, conversationId],
            })
          }
        />
      ) : null}
      {snapshot && activeRun?.status === 'waiting-approval' && activeRun.approval ? (
        <ApprovalCard
          title={`工具审批：${activeRun.approval.action === 'create_image' ? '生成图片' : '执行 ' + activeRun.approval.action}`}
          description={
            activeRun.approval.description ?? '该操作会产生外部副作用，确认后本轮继续执行。'
          }
          status="pending"
          onAllow={() => void decide(activeRun.approval!.id, 'allow-once')}
          onReject={() => void decide(activeRun.approval!.id, 'reject')}
        />
      ) : null}
    </div>
  );
}

function buildMessages(
  snapshot: ConversationSnapshot | null,
  previews: Record<string, PreviewState>,
): MessageView[] {
  if (!snapshot) return [];
  const views: MessageView[] = snapshot.messages.map((message) => {
    const text = message.parts.find((part) => part.kind === 'text');
    const artifactRefs = message.parts.filter((part) => part.kind === 'artifact');
    return {
      id: message.id,
      role: message.role,
      parts: [
        ...(text && text.kind === 'text'
          ? [{ id: message.id + ':text', kind: 'text' as const, text: text.text }]
          : []),
        ...artifactRefs.map((part) =>
          part.kind === 'artifact'
            ? {
                id: message.id + ':' + part.artifactId,
                kind: 'plugin' as const,
                type: 'zhishu-proposal',
                schemaVersion: 1,
                fallbackText: part.summary ?? '提案已生成，请在下方审阅。',
              }
            : {
                id: message.id + ':' + part.kind,
                kind: 'text' as const,
                text: '',
              },
        ),
      ],
      status: message.role === 'assistant' ? undefined : undefined,
    };
  });
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
          text: preview.text + (preview.incomplete ? '（预览中断，等待最终结果）' : ''),
        },
      ],
      status: '生成中',
    });
  }
  return views;
}

function isRevisionConflict(error: unknown): boolean {
  return Boolean(
    typeof error === 'object' &&
    error !== null &&
    (error as { status?: number }).status === 409 &&
    (error as { message?: string }).message?.includes('上下文'),
  );
}

export type { WritingProposalPayload, ScopeSelection };
