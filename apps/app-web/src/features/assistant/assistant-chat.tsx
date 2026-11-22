import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  applyAiEvent,
  type AiEvent,
  type ConversationSnapshot,
  type PreviewFrame,
  type PreviewState,
  type RunStatus,
} from '@zhishu/chat-contracts';
import type { Citation, ScopeSelection } from '@zhishu/ai-contracts';
import {
  Chat,
  ChatStatus,
  Composer,
  ApprovalCard,
  type MessagePart,
  type MessageView,
} from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import { ExternalLink, FileText, Sparkles } from 'lucide-react';
import { getDocument } from '../../api/generated/documents';
import { listKnowledgeWorkspaces } from '../../api/generated/knowledge';
import { getAccessToken } from '../../api/transport';
import { errorMessage } from '../../api/api-error';
import { readRecord, writeRecord, writeRecordOnPageExit } from '../offline/storage';
import type { ConversationTransport } from '../../components/chat/conversation-transport';
import {
  cancelRun,
  createConversation,
  createDraft,
  fetchSnapshot,
  mergePreview,
  observeConversation,
  retryRun,
  submitMessage,
  updateContext,
} from '../../components/chat/conversation-transport';
import { CitationMarkdown, CitationSources } from '../../components/chat/citations';
import { useCitationPresentations } from '../../components/chat/citation-model';
import { MarkdownBlock } from '../../components/chat/markdown-block';
import { ScopePicker } from './scope-picker';
import { SaveToPicker } from './save-to-picker';
import {
  AttachMenu,
  DraftCreateButton,
  IntentSegment,
  WebSearchToggle,
  type AssistantIntent,
} from './composer-toolbar';
import { DraftActionCard, type DraftCardState, type DraftPhase } from './draft-action-card';
import type { PendingProposal } from './editor-proposal-review';
import { ArtifactMessage, type ArtifactCardContext } from './artifact-message';
import { AssistantEmpty } from './assistant-empty';
import { ImageArtifacts } from './image-artifacts';
import { toolLabel } from './tool-labels';

export interface AssistantEditorContext {
  documentId: string;
  selectionBlockIds: string[];
  hasUnconfirmedChanges: () => boolean;
}

export interface AssistantChatProps {
  /** Durable conversation transport (internal /api/ai or the public visitor namespace). */
  transport: ConversationTransport;
  /** Identity-scoped draft storage key parts. */
  scopeKey: unknown[];
  /** Public visitors get a restricted scope/rag experience; internal users compose plugins. */
  mode: 'internal' | 'public';
  initialScope?: ScopeSelection;
  initialConversationId?: string | null;
  /** Deep-link target: bound server-side when a new conversation is created. */
  initialTargetDocumentId?: string | null;
  /** Live editor context provider used when a target document is bound. */
  getEditorContext?: () => AssistantEditorContext | null;
  welcome?: string;
  suggested?: string[];
  documentLabel?: { documentId: string; title: string };
  onConversationChange?: (conversationId: string | null) => void;
  /** The server-bound target document; the workbench derives its layout from this fact. */
  onTargetChange?: (documentId: string | null) => void;
  /** Focus/switch to the bound document view (created and proposal receipts use it). */
  onOpenTarget?: () => void;
  /** Open proposal fact for the workbench: the editor pane reviews changes in place. */
  onPendingProposalChange?: (proposal: PendingProposal | null) => void;
  className?: string;
}

interface PendingMessage {
  clientMessageId: string;
  idempotencyKey: string;
  text: string;
}

/** Persisted in-flight draft command so a refresh can resume the honest card state. */
interface StoredDraftCard {
  phase: DraftPhase;
  instruction: string;
  workspaceId: string | null;
  runId: string | null;
}

const RUN_STATUS_LABEL = {
  queued: '排队中…',
  running: '正在生成…',
  'waiting-approval': '等待你的工具审批',
  completed: '正在整理结果…',
  interrupted: '执行中断，结果可能需要核对。',
  failed: '生成失败。',
  cancelled: '已取消。',
} as const satisfies Record<RunStatus, string>;

const PLACEHOLDER = {
  qa: '提出一个问题，例如：这个流程的负责人是谁？',
  writing: '例如：把这段改写得更简洁，面向管理层',
} as const satisfies Record<AssistantIntent, string>;

const RESUMABLE_PHASES: readonly DraftPhase[] = ['submitting', 'creating', 'failed', 'unknown'];

/**
 * One assistant conversation combines question answering, research and writing. Intent is a
 * per-round hint that never switches the session or transport; the bound target document is
 * a server fact reported through the snapshot, not local draft state. The toolbar carries
 * every per-round input (scope, save target, web research, intent, draft command) and all
 * action results surface as cards inside the message stream.
 */
export function AssistantChat({
  transport,
  scopeKey,
  mode,
  initialScope,
  initialConversationId,
  initialTargetDocumentId,
  getEditorContext,
  welcome,
  suggested,
  documentLabel,
  onConversationChange,
  onTargetChange,
  onOpenTarget,
  onPendingProposalChange,
  className,
}: AssistantChatProps) {
  const identityKey = getAccessToken() ?? 'anonymous';
  const storageKey = JSON.stringify(['assistant-v1', identityKey, mode, ...scopeKey]);
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [draft, setDraft] = useState('');
  const [intent, setIntent] = useState<AssistantIntent>('qa');
  const [scope, setScope] = useState<ScopeSelection>(initialScope ?? { kind: 'all' });
  const [webSearch, setWebSearch] = useState(false);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [stages, setStages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveWorkspaceId, setSaveWorkspaceId] = useState<string | null>(null);
  const [saveToOpen, setSaveToOpen] = useState(false);
  const [draftCard, setDraftCard] = useState<DraftCardState | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const draftCardRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const capabilities = useQuery({
    queryKey: ['assistant-capabilities'],
    staleTime: 60_000,
    enabled: mode === 'internal',
    queryFn: async () => {
      const { getAiCapabilities } = await import('../../api/generated/ai');
      return getAiCapabilities();
    },
  });

  useEffect(() => {
    void readRecord(identityKey, 'chat-draft', storageKey)
      .then((value) => {
        const stored = value as {
          conversationId?: string;
          draft?: string;
          pendingCreate?: StoredDraftCard;
        } | null;
        if (!mounted.current) return;
        if (stored?.conversationId) setConversationId(stored.conversationId);
        if (stored?.draft) setDraft(stored.draft);
        const storedCard = stored?.pendingCreate;
        if (storedCard && RESUMABLE_PHASES.includes(storedCard.phase)) {
          setDraftCard({
            // A page reload can only resume observation, never re-submit the command.
            phase: storedCard.phase === 'submitting' ? 'creating' : storedCard.phase,
            instruction: storedCard.instruction,
            workspaceId: storedCard.workspaceId,
            runId: storedCard.runId,
          });
        }
      })
      // 存储不可用（私有模式、被其他标签页阻塞等）按“无记录”处理，
      // 否则 hydrated 永远为 false，快照查询被禁用，界面停在空态收不到任何回复。
      .catch(() => undefined)
      .finally(() => {
        if (mounted.current) setHydrated(true);
      });
  }, [identityKey, storageKey]);

  const snapshotQuery = useQuery({
    queryKey: ['assistant-chat', identityKey, conversationId ?? ''],
    queryFn: () => fetchSnapshot(transport, conversationId!),
    enabled: hydrated && !!conversationId,
    structuralSharing: (previous: unknown, next: unknown) => {
      if (!previous) return next;
      const current = previous as ConversationSnapshot;
      const incoming = next as ConversationSnapshot;
      return BigInt(incoming.cursor) >= BigInt(current.cursor) ? incoming : current;
    },
  });
  const snapshot: ConversationSnapshot | null = snapshotQuery.data ?? null;
  const targetDocumentId = snapshot?.conversation.targetDocumentId ?? null;

  // Derive the open proposal from snapshot facts only; the workbench hands it to the editor.
  const pendingProposal = useMemo<PendingProposal | null>(() => {
    if (mode !== 'internal' || !conversationId || !snapshot) return null;
    const open = [...snapshot.artifacts]
      .reverse()
      .find(
        (item) =>
          item.kind === 'proposal' &&
          ['pending', 'conflict', 'unknown'].includes(item.applicationState ?? 'pending'),
      );
    if (!open) return null;
    return {
      conversationId,
      artifactId: open.id,
      reviewRevision: open.reviewRevision ?? 0,
      applicationState: open.applicationState ?? 'pending',
      decidedBlockIds: (open.review?.decisions ?? []).map((decision) => decision.blockId),
    };
  }, [conversationId, mode, snapshot]);
  const proposalSignature = JSON.stringify(pendingProposal);
  useEffect(() => {
    onPendingProposalChange?.(pendingProposal);
    // Notify on semantic change only: the snapshot object refreshes on every stream frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposalSignature, onPendingProposalChange]);

  useEffect(() => {
    onConversationChange?.(conversationId);
  }, [conversationId, onConversationChange]);
  useEffect(() => {
    onTargetChange?.(targetDocumentId);
  }, [targetDocumentId, onTargetChange]);

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
          ['assistant-chat', identityKey, conversationId],
          (current) => (current ? (applyAiEvent(current, event) ?? current) : current),
        );
        if (
          event.type === 'artifact.application-updated' ||
          event.type === 'message.created' ||
          event.type === 'conversation.updated'
        )
          setError(null);
      },
      onPreview: (frame: PreviewFrame) => {
        setPreviews((current) => mergePreview(current, frame));
        // Stage frames are progress facts only; they never claim persistence.
        if (frame.channel === 'stage' && frame.stage) {
          const stage = frame.stage;
          setStages((current) => ({ ...current, [frame.runId]: stage }));
        }
      },
      onResync: () =>
        void queryClient.refetchQueries({
          queryKey: ['assistant-chat', identityKey, conversationId],
        }),
    });
    return () => stop.abort();
    // The cursor is intentionally captured once per connection generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, !!snapshot, identityKey]);

  const persist = useCallback(
    (sync: boolean) => {
      if (!hydrated) return;
      const pendingCreate: StoredDraftCard | null =
        draftCard && draftCard.phase !== 'local'
          ? {
              phase: draftCard.phase,
              instruction: draftCard.instruction,
              workspaceId: draftCard.workspaceId,
              runId: draftCard.runId,
            }
          : null;
      void (sync ? writeRecordOnPageExit : writeRecord)(identityKey, 'chat-draft', storageKey, {
        conversationId,
        draft,
        pendingCreate,
      });
    },
    [conversationId, draft, draftCard, hydrated, identityKey, storageKey],
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

  const runs = useMemo(() => snapshot?.runs ?? [], [snapshot]);
  const activeRun = runs.find((run) =>
    ['queued', 'running', 'waiting-approval'].includes(run.status),
  );
  const lastFailed = [...runs]
    .reverse()
    .find((run) => run.status === 'failed' || run.status === 'interrupted');
  const lastUserText = [...(snapshot?.messages ?? [])]
    .reverse()
    .find((m) => m.role === 'user')
    ?.parts.find((p) => p.kind === 'text');

  const workspaces = useQuery({
    queryKey: ['knowledge-workspaces'],
    queryFn: () => listKnowledgeWorkspaces(),
    enabled: mode === 'internal',
  });

  const boundDocument = useQuery({
    queryKey: ['document', targetDocumentId],
    queryFn: () => getDocument(targetDocumentId!),
    enabled: mode === 'internal' && !!targetDocumentId,
    staleTime: 30_000,
  });

  const refetch = useCallback(() => {
    if (!conversationId) return Promise.resolve();
    return queryClient.refetchQueries({
      queryKey: ['assistant-chat', identityKey, conversationId],
    });
  }, [conversationId, identityKey, queryClient]);

  const artifactContext = useMemo<ArtifactCardContext | null>(
    () =>
      conversationId
        ? {
            transport,
            conversationId,
            targetDocumentId,
            documentTitle: boundDocument.data?.title,
            onOpenTarget,
            onResolved: refetch,
          }
        : null,
    [transport, conversationId, targetDocumentId, boundDocument.data?.title, onOpenTarget, refetch],
  );

  const messages = useMemo(
    () => buildMessages(snapshot, previews, transport, artifactContext, stages),
    [snapshot, previews, transport, artifactContext, stages],
  );

  // The draft command card advances only on server facts: the created receipt is handed to
  // the snapshot-derived artifact card, failures and unknowns keep the resumable card.
  useEffect(() => {
    if (!draftCard || (draftCard.phase !== 'submitting' && draftCard.phase !== 'creating')) return;
    if (targetDocumentId) {
      setDraftCard(null);
      return;
    }
    const run = draftCard.runId ? runs.find((item) => item.id === draftCard.runId) : undefined;
    if (!run) return;
    if (run.status === 'failed')
      setDraftCard({
        ...draftCard,
        phase: 'failed',
        error: run.errorCode ? `生成失败（${run.errorCode}）` : '生成失败。',
      });
    else if (run.status === 'cancelled')
      setDraftCard({ ...draftCard, phase: 'local', runId: null });
    else if (run.status === 'interrupted' || run.status === 'completed')
      setDraftCard({ ...draftCard, phase: 'unknown' });
  }, [draftCard, targetDocumentId, runs]);

  async function ensureConversation(): Promise<string> {
    if (conversationId) return conversationId;
    const created = await createConversation<{ id: string }>(transport, {
      scope,
      ...(mode === 'internal' && initialTargetDocumentId
        ? { targetDocumentId: initialTargetDocumentId }
        : {}),
    });
    setConversationId(created.id);
    return created.id;
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || activeRun) return;
    if (mode === 'internal' && capabilities.data && !capabilities.data.enabled) {
      setError(capabilities.data.reason ?? '助手服务未启用');
      return;
    }
    if (mode === 'internal' && webSearch && !capabilities.data?.webSearchAvailable) {
      setError('联网调研尚未配置：请服务端完成联网配置后使用，或关闭联网后重试。');
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
        ...(mode === 'internal' ? { intentHint: intent } : {}),
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
        ...(mode === 'internal' && webSearch ? { webSearch: true } : {}),
      });
      await submitMessage(transport, id, await body(), new AbortController().signal).catch(
        async (first: unknown) => {
          if (isRevisionConflict(first)) {
            const fresh = await fetchSnapshot(transport, id);
            queryClient.setQueryData(['assistant-chat', identityKey, id], fresh);
            const retryBody = await body();
            return submitMessage(
              transport,
              id,
              { ...retryBody, expectedContextRevision: fresh.conversation.contextRevision },
              new AbortController().signal,
            );
          }
          throw first;
        },
      );
      setDraft('');
      setPending(null);
      await queryClient.refetchQueries({ queryKey: ['assistant-chat', identityKey, id] });
    } catch (cause) {
      setDraft(trimmed);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function changeScope(next: ScopeSelection) {
    if (!conversationId) {
      setScope(next);
      return;
    }
    await updateContext(transport, conversationId, {
      scope: next,
      expectedContextRevision: snapshot?.conversation.contextRevision ?? 1,
    }).catch((cause: unknown) => setError(errorMessage(cause)));
    setScope(next);
    await queryClient.refetchQueries({ queryKey: ['assistant-chat', identityKey, conversationId] });
  }

  async function decide(approvalId: string, decision: 'allow-once' | 'reject') {
    const { decideAiApproval } = await import('../../api/generated/ai');
    await decideAiApproval(conversationId!, approvalId, {
      decisionId: crypto.randomUUID(),
      decision,
    }).catch((cause: unknown) => setError(errorMessage(cause)));
    await queryClient.refetchQueries({ queryKey: ['assistant-chat', identityKey, conversationId] });
  }

  function openDraftCard() {
    const instruction = draft.trim() || (lastUserText?.kind === 'text' ? lastUserText.text : '');
    setDraftCard((current) => {
      if (current && current.phase !== 'local') return current;
      return { phase: 'local', instruction, workspaceId: saveTarget, runId: null };
    });
    requestAnimationFrame(() =>
      draftCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
  }

  async function confirmDraft(input: { instruction: string; workspaceId: string }) {
    setBusy(true);
    setError(null);
    setDraftCard((current) => ({
      phase: 'submitting',
      instruction: input.instruction,
      workspaceId: input.workspaceId,
      runId: current?.runId ?? null,
    }));
    try {
      const id = await ensureConversation();
      const result = await createDraft<{
        runId: string | null;
        documentId?: string;
        status: 'accepted' | 'in-progress' | 'already-bound';
      }>(transport, id, {
        idempotencyKey: crypto.randomUUID(),
        instruction: input.instruction,
        workspaceId: input.workspaceId,
        expectedContextRevision: snapshot?.conversation.contextRevision ?? 1,
      });
      if (result.status === 'already-bound') {
        // The server already has a bound target: the snapshot-derived receipt takes over.
        setDraftCard(null);
      } else {
        setDraftCard((current) => ({
          ...(current ?? {
            instruction: input.instruction,
            workspaceId: input.workspaceId,
          }),
          phase: 'creating',
          runId: result.runId,
        }));
      }
      await refetch();
    } catch (cause) {
      setDraftCard((current) => ({
        ...(current ?? {
          instruction: input.instruction,
          workspaceId: input.workspaceId,
          runId: null,
        }),
        phase: 'failed',
        error: errorMessage(cause),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function cancelDraftRun() {
    if (!conversationId || !draftCard?.runId) return;
    await cancelRun(transport, conversationId, draftCard.runId).catch((cause: unknown) =>
      setError(errorMessage(cause)),
    );
    setDraftCard({ ...draftCard, phase: 'local', runId: null });
    await refetch();
  }

  async function retryDraft() {
    if (!conversationId || !draftCard?.runId) return;
    setBusy(true);
    try {
      await retryRun(transport, conversationId, draftCard.runId);
      setDraftCard({ ...draftCard, phase: 'creating' });
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const personalWorkspace = useMemo(
    () => workspaces.data?.find((space) => space.kind === 'personal'),
    [workspaces.data],
  );
  // The save target is the user's explicit choice or the visible personal default —
  // never inferred from the retrieval scope or the first list entry.
  const saveTarget = saveWorkspaceId ?? personalWorkspace?.id ?? null;
  const saveWorkspaceName = workspaces.data?.find((space) => space.id === saveTarget)?.name ?? null;
  const showSaveTo =
    mode === 'internal' && !targetDocumentId && (intent === 'writing' || !!draftCard);
  const showDraftButton = mode === 'internal' && !targetDocumentId && intent === 'writing';

  // A local (unsubmitted) card follows the toolbar's effective save target.
  useEffect(() => {
    setDraftCard((current) =>
      current && current.phase === 'local' && current.workspaceId !== saveTarget
        ? { ...current, workspaceId: saveTarget }
        : current,
    );
  }, [saveTarget]);

  function statusLine(): string {
    if (error) return error;
    if (activeRun) return RUN_STATUS_LABEL[activeRun.status];
    if (mode === 'public') return '基于站点批准的资料回答';
    return '提案与草稿需经你确认后写入；「已创建 / 已应用」仅在服务端持久化确认后显示';
  }

  function draftButtonTitle(): string {
    if (!saveTarget) return '请先选择保存位置';
    if (activeRun) return '当前任务完成后可创建草稿';
    return '在消息流中生成待确认的草稿卡片';
  }

  return (
    <div className={className}>
      <Chat
        messages={messages}
        renderText={(text) => <MarkdownBlock text={text} />}
        emptyState={
          <AssistantEmpty
            mode={mode}
            welcome={welcome}
            suggested={suggested}
            onPick={(prompt) => {
              setDraft(prompt);
              composerInputRef.current?.focus();
            }}
          />
        }
        header={
          mode === 'internal' ? (
            <div className="assistant-header">
              <Sparkles className="size-4 shrink-0 text-accent" aria-hidden="true" />
              <span className="assistant-header__conv">
                {snapshot?.conversation.title || '新对话'}
              </span>
              <span className="min-w-0 flex-1" />
              {targetDocumentId ? (
                <button
                  type="button"
                  className="assistant-bound-chip"
                  onClick={onOpenTarget}
                  title="打开已绑定文档"
                >
                  <FileText className="size-3.5 shrink-0" />
                  <span className="max-w-36 truncate">
                    {snapshot?.conversation.status === 'target-unavailable'
                      ? '目标文档不可用'
                      : `已绑定：${boundDocument.data?.title ?? '文档'}`}
                  </span>
                  <ExternalLink className="size-3.5 shrink-0 opacity-70" />
                </button>
              ) : null}
            </div>
          ) : undefined
        }
        status={<ChatStatus error={!!error}>{statusLine()}</ChatStatus>}
        afterMessages={
          <>
            {snapshot && lastFailed && !activeRun && lastFailed.id !== draftCard?.runId ? (
              <div className="qa-failed">
                <span>
                  {lastFailed.status === 'interrupted'
                    ? '执行中断，结果可能需要核对。'
                    : '生成失败。'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void retryRun(transport, conversationId!, lastFailed.id).then(refetch)
                  }
                >
                  重试（先核对已有结果）
                </button>
              </div>
            ) : null}
            {mode === 'internal' && draftCard ? (
              <div ref={draftCardRef}>
                <DraftActionCard
                  state={draftCard}
                  workspaceLabel={saveWorkspaceName}
                  busy={busy || !!activeRun}
                  onInstructionChange={(value) =>
                    setDraftCard((current) =>
                      current ? { ...current, instruction: value } : current,
                    )
                  }
                  onEditWorkspace={() => {
                    setSaveToOpen(true);
                    composerInputRef.current?.focus();
                  }}
                  onConfirm={(input) => void confirmDraft(input)}
                  onDiscard={() => setDraftCard(null)}
                  onCancelRun={() => void cancelDraftRun()}
                  onRetry={() => void retryDraft()}
                  onRefresh={() => void refetch()}
                />
              </div>
            ) : null}
            <ImageArtifacts conversationId={conversationId} snapshot={snapshot} />
          </>
        }
        composer={
          <Composer
            value={draft}
            onValueChange={setDraft}
            onSubmit={() => void send(draft)}
            onStop={
              activeRun
                ? () => void cancelRun(transport, conversationId!, activeRun.id).then(refetch)
                : undefined
            }
            busy={busy}
            submitting={!!pending || !!activeRun}
            stopping={activeRun?.cancelRequested}
            readOnly={snapshot?.conversation.status === 'target-unavailable'}
            inputRef={composerInputRef}
            placeholder={mode === 'internal' ? PLACEHOLDER[intent] : PLACEHOLDER.qa}
            maxLength={mode === 'public' ? 8000 : 32000}
            toolbarStart={
              mode === 'internal' ? (
                <span className="assistant-toolbar-start">
                  <AttachMenu />
                  <ScopePicker
                    workspaces={workspaces.data ?? []}
                    value={snapshot?.conversation.scope ?? scope}
                    onChange={(next) => void changeScope(next)}
                    documentLabel={documentLabel}
                  />
                  {showSaveTo ? (
                    <SaveToPicker
                      workspaces={workspaces.data ?? []}
                      value={saveTarget}
                      onChange={setSaveWorkspaceId}
                      isOpen={saveToOpen}
                      onOpenChange={setSaveToOpen}
                    />
                  ) : null}
                </span>
              ) : undefined
            }
            toolbarEnd={
              mode === 'internal' ? (
                <span className="assistant-toolbar-end">
                  <IntentSegment intent={intent} onChange={setIntent} />
                  <WebSearchToggle
                    checked={webSearch}
                    onChange={setWebSearch}
                    disabled={!capabilities.data?.webSearchAvailable}
                  />
                  {showDraftButton ? (
                    <DraftCreateButton
                      disabled={!saveTarget || busy || !!activeRun}
                      title={draftButtonTitle()}
                      onClick={openDraftCard}
                    />
                  ) : null}
                </span>
              ) : undefined
            }
            messages={{ send: '发送', stop: '停止' }}
          />
        }
      />
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
  transport: ConversationTransport,
  artifactContext: ArtifactCardContext | null,
  stages: Record<string, string>,
): MessageView[] {
  if (!snapshot) return [];
  const artifactsById = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
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
          .map((p) => {
            const artifact = artifactsById.get(p.artifactId);
            const receipt =
              artifact &&
              artifactContext &&
              (artifact.kind === 'proposal' || artifact.kind === 'draft') ? (
                <ArtifactMessage artifact={artifact} context={artifactContext} />
              ) : undefined;
            return {
              id: message.id + ':' + p.artifactId,
              kind: 'plugin' as const,
              type: 'zhishu-' + p.artifactKind,
              schemaVersion: 1,
              fallbackText: p.summary ?? '产物已生成。',
              ...(receipt ? { content: receipt } : {}),
            };
          }),
      ],
      status:
        message.role === 'assistant' && citations.length
          ? `引用 ${citations.length} 条来源`
          : undefined,
    };
  });
  const running = snapshot.runs.find((run) => ['running', 'waiting-approval'].includes(run.status));
  const preview = running ? previews[running.id] : undefined;
  if (running && preview && !snapshot.messages.some((m) => m.runId === running.id)) {
    const stage = stages[running.id];
    // Live process first (thinking, then tool steps), the typing answer last.
    const parts: MessagePart[] = [];
    if (preview.thinking)
      parts.push({
        id: `preview-thinking:${running.id}`,
        kind: 'thinking',
        text: preview.thinking,
        streaming: preview.text.length === 0,
      });
    for (const tool of preview.tools)
      parts.push({
        id: `preview-tool:${running.id}:${tool.id}`,
        kind: 'tool',
        title: toolLabel(tool.name),
        status: tool.status,
      });
    if (preview.text)
      parts.push({
        id: `preview-text:${running.id}`,
        kind: 'text',
        text: preview.text + (preview.incomplete ? '（预览不完整，等待最终结果）' : ''),
      });
    views.push({
      id: `preview:${running.id}`,
      role: 'assistant',
      parts,
      ...(stage ? { stage } : { status: '生成中' }),
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
      <CitationMarkdown text={text.text} citations={presentations} className="qa-answer-text" />
      {presentations.length ? <CitationSources citations={presentations} /> : null}
      {error ? <p className="qa-answer-note">{error}</p> : null}
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
