import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  ChevronDown,
  FilePlus2,
  FileText,
  LoaderCircle,
  MessageSquare,
  PenLine,
  Compass,
  Eye,
} from 'lucide-react';
import {
  canonicalJson,
  isReplacementIntent,
  isReplacementProposal,
  replacementChanges,
  replacementBatch,
} from '@zhishu/ai-contracts';
import { applyOperationBatch } from '@zhishu/document-contracts';
import type { EditorReplacementPreviewData } from '@zhishu/editor-core';
import { getDocument, createDocument } from '@/api/generated/documents';
import {
  getAiCapabilities,
  getAiDocumentContext,
  cancelAiTask,
  getAiTask,
  reviewAiProposal,
} from '@/api/generated/ai';
import { createKnowledgeWorkspace } from '@/api/generated/knowledge';
import { errorMessage } from '@/api/api-error';
import { hasUnconfirmedChanges } from '@/api/transport';
import { Button } from '@/components/ui/button';
import { Chat, ChatStatus, Composer } from '@zhishu/chat-ui';
import '@zhishu/chat-ui/styles.css';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { useOfflineState } from '@/features/offline/cache';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';
import {
  DocumentCollaborationEditor,
  type DocumentCollaborationSnapshot,
} from '@/features/document/document-collaboration-editor';
import { AiDocumentPicker } from './ai-document-picker';
import { WritingChat } from '@/components/writing-chat/writing-chat';
import { WritingDraft } from './writing-draft';
import { RagChat } from '@/components/rag-chat/rag-chat';
import { ProposalResult } from './proposal-result';
import type { StartAiAuthoringBody } from '@/api/generated/app-api.schemas';
import { useChatContext } from './use-chat-context';
import { consumeAuthoringTask, readProposalDraft, type ProposalMessage } from './proposal-client';

export function AiCreationPage({
  initialTargetDocumentId,
  contextDocumentId,
  sourceWorkspaceId,
  onTargetChange,
}: {
  initialTargetDocumentId?: string;
  contextDocumentId?: string;
  sourceWorkspaceId?: string;
  onTargetChange: (id: string) => void;
}) {
  const { identityKey, enabled, workspaces } = useKnowledgeWorkspace();
  const offline = useOfflineState(),
    queryClient = useQueryClient();
  const [initialWritingTarget] = useState(initialTargetDocumentId ?? '');
  const fromTargetDocument = !!contextDocumentId && contextDocumentId === initialWritingTarget;
  const [targetId, setTargetId] = useState(initialTargetDocumentId ?? '');
  const { sourceIds, setSourceIds, chatKind, setChatKind, contextHydrated } = useChatContext(
    offline.identity,
    JSON.stringify([identityKey, sourceWorkspaceId, contextDocumentId]),
    contextDocumentId,
    fromTargetDocument ? 'proposal' : undefined,
  );
  const [instruction, setInstruction] = useState(''),
    [messages, setMessages] = useState<ProposalMessage[]>([]),
    [hydrated, setHydrated] = useState(false);
  const [picker, setPicker] = useState<'target' | 'sources' | null>(null),
    [mobileTab, setMobileTab] = useState<'document' | 'chat'>('chat');
  const [writingDraft, setWritingDraft] = useState<{ id: string; text: string } | null>(null);
  const [creatingFromChat, setCreatingFromChat] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit'),
    [panelWidth, setPanelWidth] = useState(380);
  const [staleReviewId, setStaleReviewId] = useState<string | null>(null),
    [reviewBusy, setReviewBusy] = useState(false),
    [reviewError, setReviewError] = useState<string | null>(null);
  const runRef = useRef<{
    id: string;
    controller: AbortController;
  } | null>(null);
  const composing = useRef(false),
    preparing = useRef(false),
    preparation = useRef<AbortController | null>(null);
  const reviewingRef = useRef(false);
  const [editorVersion, setEditorVersion] = useState<DocumentCollaborationSnapshot | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const draftKey = useRef<{
    workspaceKey: string;
    documentKey: string;
    workspaceId?: string;
  } | null>(null);
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraft = useRef<{ messages: ProposalMessage[]; instruction: string } | null>(null);
  const flushDraft = useCallback(
    (exiting = false) => {
      if (cacheTimer.current) clearTimeout(cacheTimer.current);
      cacheTimer.current = null;
      if (!offline.identity || !latestDraft.current) return;
      if (exiting) {
        writeRecordOnPageExit(
          offline.identity,
          'ai-draft',
          'writing-proposals-v2',
          latestDraft.current,
        );
        return;
      }
      void writeRecord(
        offline.identity,
        'ai-draft',
        'writing-proposals-v2',
        latestDraft.current,
      ).catch(() => setError('本机草稿缓存不可用，请及时复制仍有权限的内容。'));
    },
    [offline.identity],
  );
  const capabilities = useQuery({
    queryKey: ['writing-capabilities-legacy', identityKey],
    queryFn: ({ signal }) => getAiCapabilities({ signal }),
    enabled,
  });
  const document = useQuery({
    queryKey: ['document', identityKey, targetId],
    queryFn: ({ signal }) => getDocument(targetId, { signal }),
    enabled: enabled && !!targetId,
    retry: false,
  });
  const context = useQuery({
    queryKey: ['writing-context', identityKey, targetId],
    queryFn: ({ signal }) => getAiDocumentContext(targetId, { signal }),
    enabled: enabled && !!targetId,
    retry: false,
  });
  const sourceQueries = useQueries({
    queries: sourceIds.map((id) => ({
      queryKey: ['ai-source', identityKey, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => getDocument(id, { signal }),
      enabled,
      retry: false,
    })),
  });
  const ownSpaces = workspaces.filter((w) => w.kind === 'personal' && w.role === 'owner');
  const ready = offline.online && offline.verified && capabilities.data?.enabled;
  const reviewMessage = messages.findLast(
    (message) =>
      message.registered &&
      !message.dismissed &&
      message.reviewPending !== false &&
      message.body.request.document.documentId === targetId &&
      (message.body.request.intent === 'auto' || isReplacementIntent(message.body.request.intent)),
  );
  const reviewId = reviewMessage?.id;
  const reviewQuery = useQuery({
    queryKey: ['writing-task', identityKey, reviewId ?? ''],
    queryFn: ({ signal }) => getAiTask(reviewId!, { signal }),
    enabled: enabled && !!reviewId,
    retry: false,
  });
  const reviewRequest = reviewMessage?.body.request ?? null;
  const reviewVersion = reviewQuery.data?.review?.version ?? reviewRequest?.document;
  const reviewStructureRevision =
    reviewQuery.data?.review?.structureRevision ?? reviewRequest?.baseStructureRevision;
  const reviewStale =
    (!!reviewId && staleReviewId === reviewId) ||
    reviewQuery.data?.application.state === 'conflict' ||
    (!!reviewVersion &&
      !!editorVersion &&
      editorVersion.documentId === targetId &&
      (editorVersion.generationId !== reviewVersion.generationId ||
        editorVersion.durableSeq > reviewVersion.durableSeq)) ||
    (!!reviewVersion &&
      !!context.data &&
      (canonicalJson(context.data.version) !== canonicalJson(reviewVersion) ||
        context.data.structureRevision !== reviewStructureRevision));
  const reviewing =
    reviewQuery.data?.status === 'completed' &&
    reviewQuery.data.application.state !== 'applied' &&
    reviewQuery.data.application.state !== 'rejected' &&
    !reviewQuery.isError &&
    !!reviewMessage &&
    reviewQuery.data.result &&
    'operationBatch' in reviewQuery.data.result &&
    isReplacementProposal(reviewMessage.body.request, reviewQuery.data.result);
  const reviewPreview = useMemo<EditorReplacementPreviewData | null>(() => {
    const task = reviewQuery.data,
      message = reviewMessage;
    if (
      !reviewing ||
      reviewBusy ||
      reviewStale ||
      !context.data ||
      editorVersion?.documentId !== targetId ||
      editorVersion?.generationId !== reviewVersion?.generationId ||
      !message ||
      !task?.result ||
      !('operationBatch' in task.result)
    )
      return null;
    // The review and context establish the saved version. The editor checks the
    // actual body before showing suggestions, even if the socket receipt was missed.
    const settled = new Set(task.review?.decisions.map((decision) => decision.blockId));
    const original = context.data.snapshot.content;
    const pending = replacementChanges(task.result, original)
      .filter((change) => !settled.has(change.blockId))
      .map((change) => change.blockId);
    if (!pending.length) return { id: message.id, original, proposed: original };
    const batch = replacementBatch(
      task.result,
      original,
      original,
      pending,
      task.result.operationBatch.operationId,
    );
    if (!batch) return null;
    const applied = applyOperationBatch(original, batch, {
      documentId: targetId,
      generationId: message.body.request.document.generationId,
    });
    return applied.success ? { id: message.id, original, proposed: applied.content } : null;
  }, [
    reviewQuery.data,
    reviewMessage,
    reviewing,
    reviewBusy,
    reviewStale,
    context.data,
    targetId,
    editorVersion,
    reviewVersion,
  ]);
  useEffect(() => {
    let active = true;
    if (!offline.identity) return;
    void readRecord(offline.identity, 'ai-draft', 'writing-proposals-v2')
      .then((value) => value ?? readRecord(offline.identity!, 'ai-draft', 'writing-proposals'))
      .then((value) => value ?? readRecord(offline.identity!, 'ai-draft', 'current'))
      .then((value) => {
        if (!active) return;
        const draft = readProposalDraft(value);
        if (draft) {
          setMessages(draft.messages);
          setInstruction(draft.instruction);
        }
        setHydrated(true);
      })
      .catch(() => {
        if (active) {
          setError('无法读取本机创作草稿，请保持页面打开。');
          setHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, [offline.identity]);
  useEffect(() => {
    if (!hydrated || !offline.identity) return;
    latestDraft.current = { messages: messages.slice(-16), instruction };
    cacheTimer.current ??= setTimeout(() => flushDraft(), 200);
  }, [messages, instruction, hydrated, offline.identity, flushDraft]);
  useEffect(() => {
    const leave = () => {
      flushDraft(true);
      preparation.current?.abort();
      runRef.current?.controller.abort();
    };
    const visibility = () => {
      if (window.document.visibilityState === 'hidden') flushDraft();
    };
    window.addEventListener('pagehide', leave);
    window.document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', leave);
      window.document.removeEventListener('visibilitychange', visibility);
      leave();
    };
  }, [flushDraft]);
  const forgetPreview = useCallback((id: string) => {
    setMessages((current) =>
      current.map((m) => (m.id === id && m.preview ? { ...m, preview: '' } : m)),
    );
  }, []);
  const finishReview = useCallback((id: string) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, reviewPending: false } : message,
      ),
    );
  }, []);
  const patch = (id: string, update: Partial<ProposalMessage>) =>
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  const consume = async (message: ProposalMessage) => {
    if (runRef.current) return;
    const controller = new AbortController();
    runRef.current = { id: message.id, controller };
    setBusyId(message.id);
    setError(null);
    let replacement: boolean | undefined;
    try {
      await consumeAuthoringTask(message.body, controller.signal, (event) => {
        if (event.type === 'started')
          patch(message.id, {
            registered: true,
            error: undefined,
          });
        else if (event.type === 'proposal')
          replacement = isReplacementProposal(message.body.request, event.payload);
        else if (event.type === 'completed' && replacement !== undefined) {
          patch(message.id, { reviewPending: replacement });
          if (replacement && message.body.request.document.documentId === targetId) {
            setWritingDraft(null);
            setMobileTab('document');
          }
        } else if (event.type === 'failed')
          patch(message.id, { reviewPending: false, error: '本次生成未完成，草稿已保留。' });
      });
    } catch (cause) {
      if (!controller.signal.aborted)
        patch(message.id, { registered: true, error: errorMessage(cause) });
    } finally {
      runRef.current = null;
      setBusyId(null);
      void queryClient.invalidateQueries({ queryKey: ['writing-task', identityKey, message.id] });
      void queryClient.invalidateQueries({ queryKey: ['writing-context', identityKey, targetId] });
    }
  };
  const submit = async () => {
    const text = instruction.trim();
    if (!text || busyId || runRef.current || preparing.current || !ready || !hydrated) return;
    if (messages.length >= 16) {
      setError('本次对话已达到 16 轮，请开启新对话。');
      return;
    }
    setError(null);
    const id = crypto.randomUUID();
    const preflight = new AbortController();
    preparation.current = preflight;
    preparing.current = true;
    setBusyId(id);
    try {
      const previousRequestIds: string[] = [];
      for (const message of messages) {
        const task = await getAiTask(message.id, { signal: preflight.signal });
        if (task.status === 'completed') previousRequestIds.push(message.id);
      }
      if (!targetId) {
        setPicker('target');
        throw new Error('请先选择个人文档，或新建个人草稿。');
      }
      if (hasUnconfirmedChanges())
        throw new Error('正文尚有未确认修改，请等待服务器保存确认后再生成。');
      const captured = await getAiDocumentContext(targetId, { signal: preflight.signal });
      if (!captured.aiWritable) throw new Error(captured.reason ?? '请选择本人的个人文档。');
      queryClient.setQueryData(['writing-context', identityKey, targetId], captured);
      const body: StartAiAuthoringBody = {
        protocolVersion: 1,
        sourceDocumentIds: sourceIds,
        previousRequestIds,
        request: {
          kind: 'authoring',
          requestId: id,
          intent: 'auto',
          instruction: text,
          document: captured.version,
          baseStructureRevision: captured.structureRevision,
          target: {
            kind: 'document-end',
            afterBlockId: captured.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
          },
          ...(sourceIds.length ? { contextRef: 'selected-documents' } : {}),
        },
      };
      preflight.signal.throwIfAborted();
      const message: ProposalMessage = {
        id,
        instruction: text,
        body,
        registered: false,
        targetTitle: document.data?.title,
      };
      setMessages((current) => [...current, message]);
      setReviewError(null);
      setInstruction('');
      setMobileTab('chat');
      preparation.current = null;
      preparing.current = false;
      await consume(message);
    } catch (cause) {
      setError(
        preflight.signal.aborted ? '已取消尚未开始的任务，指令已保留。' : errorMessage(cause),
      );
    } finally {
      if (preparation.current === preflight) preparation.current = null;
      preparing.current = false;
      if (!runRef.current) setBusyId(null);
    }
  };
  const selectTarget = (id: string) => {
    preparation.current?.abort();
    setWritingDraft(null);
    setTargetId(id);
    onTargetChange(id);
  };
  const personalDraftLocation = async () => {
    const storageKey = `zhishu.ai.creation:${identityKey}`;
    if (!draftKey.current) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as {
          workspaceKey?: unknown;
          documentKey?: unknown;
          workspaceId?: unknown;
        } | null;
        if (
          cached &&
          typeof cached.workspaceKey === 'string' &&
          typeof cached.documentKey === 'string'
        )
          draftKey.current = {
            workspaceKey: cached.workspaceKey,
            documentKey: cached.documentKey,
            workspaceId: typeof cached.workspaceId === 'string' ? cached.workspaceId : undefined,
          };
      } catch {
        /* Continue with an in-memory idempotency key. */
      }
      draftKey.current ??= {
        workspaceKey: crypto.randomUUID(),
        documentKey: crypto.randomUUID(),
      };
    }
    const keys = draftKey.current;
    sessionStorage.setItem(storageKey, JSON.stringify(keys));
    let workspaceId = keys.workspaceId ?? ownSpaces[0]?.id;
    if (!workspaceId) {
      const workspace = await createKnowledgeWorkspace(
        { name: '我的个人空间', kind: 'personal', icon: '📝' },
        { headers: { 'Idempotency-Key': keys.workspaceKey } },
      );
      workspaceId = workspace.id;
      void queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces', identityKey] });
    }
    keys.workspaceId = workspaceId;
    sessionStorage.setItem(storageKey, JSON.stringify(keys));
    return { workspaceId, documentKey: keys.documentKey, storageKey };
  };
  const createDraft = async () => {
    if (creating || !enabled || !offline.online) return;
    setCreating(true);
    setError(null);
    try {
      const { workspaceId, documentKey, storageKey } = await personalDraftLocation();
      const created = await createDocument(
        { title: '创作草稿', workspaceId },
        { headers: { 'Idempotency-Key': documentKey } },
      );
      selectTarget(created.id);
      setMobileTab('document');
      await queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces', identityKey] });
      sessionStorage.removeItem(storageKey);
      draftKey.current = null;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  };
  const decideReview = async (action: 'accept' | 'reject', blockId?: string) => {
    if (reviewingRef.current || !ready || !reviewId || !reviewQuery.data) return;
    const id = reviewId;
    if (action === 'accept' && (!reviewPreview || reviewStale || viewMode !== 'edit')) return;
    if (action === 'accept' && (hasUnconfirmedChanges() || composing.current)) {
      setReviewError('正文仍有输入或未确认修改，请等待同步后重新核对。');
      return;
    }
    reviewingRef.current = true;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const task = await reviewAiProposal(id, {
        decisionId: crypto.randomUUID(),
        revision: reviewQuery.data.review?.revision ?? 0,
        action,
        ...(blockId ? { blockIds: [blockId] } : {}),
      });
      queryClient.setQueryData(['writing-task', identityKey, id], task);
      if (task.application.state === 'applied' || task.application.state === 'rejected')
        finishReview(id);
      const captured = await getAiDocumentContext(targetId);
      queryClient.setQueryData(['writing-context', identityKey, targetId], captured);
      if (task.application.state === 'conflict') setStaleReviewId(id);
      else if (task.application.code) setReviewError('本次决定结果待确认，请先查询原任务。');
    } catch (cause) {
      setReviewError(errorMessage(cause));
      void queryClient.invalidateQueries({ queryKey: ['writing-task', identityKey, id] });
    } finally {
      reviewingRef.current = false;
      setReviewBusy(false);
      void queryClient.invalidateQueries({ queryKey: ['writing-context', identityKey, targetId] });
    }
  };
  if (!enabled)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        登录后开始 AI 创作。
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {!offline.online && (
        <p role="status" className="shrink-0 border-b bg-secondary px-4 py-2 text-xs">
          当前离线，已保留本机草稿。联网并校验权限后可继续。
        </p>
      )}
      {capabilities.data && !capabilities.data.enabled && (
        <p role="status" className="shrink-0 border-b bg-secondary px-4 py-2 text-xs leading-6">
          AI 创作尚未启用，请联系管理员配置模型。你仍可创建和编辑个人草稿。
        </p>
      )}
      <div className="flex shrink-0 border-b bg-card p-1 lg:hidden" aria-label="创作视图">
        {(['document', 'chat'] as const).map((tab) => (
          <Button
            key={tab}
            variant="ghost"
            size="sm"
            className={`flex-1 ${mobileTab === tab ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}
            aria-pressed={mobileTab === tab}
            onClick={() => setMobileTab(tab)}
          >
            {tab === 'document' ? <FileText size={14} /> : <MessageSquare size={14} />}{' '}
            {tab === 'document' ? '文档' : '对话'}
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section
          aria-label="创作文档画布"
          className={`min-h-0 min-w-0 flex-1 flex-col ${mobileTab === 'document' ? 'flex' : 'hidden lg:flex'}`}
        >
          {writingDraft && (
            <WritingDraft
              key={writingDraft.id}
              draft={writingDraft}
              canCreate={offline.online && offline.verified && !creating}
              resolveWorkspace={async () => (await personalDraftLocation()).workspaceId}
              onBusyChange={setCreatingFromChat}
              onClose={() => {
                setWritingDraft(null);
                if (!targetId) setMobileTab('chat');
              }}
              onCreated={(id) => {
                selectTarget(id);
                setViewMode('edit');
                setMobileTab('document');
                void queryClient.invalidateQueries({ queryKey: ['documents'] });
                void queryClient.invalidateQueries({
                  queryKey: ['knowledge-workspaces', identityKey],
                });
              }}
            />
          )}
          <div className={writingDraft ? 'hidden' : 'contents'}>
            {targetId && document.data ? (
              <>
                <div className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card px-4 py-3 sm:px-7">
                  <span className="text-xl" aria-hidden="true">
                    {document.data.icon ?? '📄'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPicker('target')}
                    disabled={!!busyId || reviewBusy}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="切换创作文档"
                  >
                    <span className="truncate">{document.data.title}</span>
                    <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                  </button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={viewMode === 'read' ? '切换编辑模式' : '切换阅读模式'}
                    onClick={() => {
                      setViewMode((value) => (value === 'edit' ? 'read' : 'edit'));
                    }}
                  >
                    <Eye size={15} />
                  </Button>
                  <Link
                    to="/documents/$documentId"
                    params={{ documentId: targetId }}
                    className="rounded-md p-2 text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="打开完整文档"
                  >
                    <ArrowUpRight size={16} />
                  </Link>
                </div>
                {context.data && !context.data.aiWritable && (
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-secondary px-4 py-2 text-xs">
                    <span>{context.data.reason}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void createDraft()}
                      disabled={creating}
                    >
                      新建个人草稿
                    </Button>
                  </div>
                )}
                <div
                  className="flex min-h-0 flex-1 flex-col"
                  onCompositionStartCapture={() => {
                    composing.current = true;
                  }}
                  onCompositionEndCapture={() => {
                    composing.current = false;
                  }}
                >
                  <DocumentCollaborationEditor
                    key={targetId}
                    document={document.data}
                    onStatusChange={setEditorVersion}
                    viewMode={viewMode}
                    replacementReview={
                      reviewing
                        ? {
                            preview: reviewPreview,
                            waitForOriginal:
                              !!editorVersion &&
                              !!reviewVersion &&
                              editorVersion.durableSeq < reviewVersion.durableSeq,
                            stale: reviewStale,
                            busy: reviewBusy,
                            disabled:
                              !ready ||
                              !!busyId ||
                              viewMode !== 'edit' ||
                              !context.data?.aiWritable,
                            error: reviewError,
                            onReplace: () => {
                              void decideReview('accept');
                            },
                            onAcceptBlock: (blockId) => {
                              void decideReview('accept', blockId);
                            },
                            onRejectBlock: (blockId) => {
                              void decideReview('reject', blockId);
                            },
                            onDismiss: () => {
                              void decideReview('reject');
                            },
                            onInvalidated: () => {
                              if (reviewId && !reviewingRef.current) setStaleReviewId(reviewId);
                            },
                          }
                        : undefined
                    }
                    versionsOpen={false}
                    onVersionsOpenChange={() => undefined}
                  />
                </div>
              </>
            ) : targetId && document.isPending ? (
              <div
                role="status"
                className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
              >
                <LoaderCircle size={16} className="animate-spin" />
                正在打开文档…
              </div>
            ) : targetId && document.isError ? (
              <div role="alert" className="m-auto space-y-4 p-8 text-center">
                <p className="text-sm">文档不存在或当前无权访问。</p>
                <Button variant="outline" onClick={() => setPicker('target')}>
                  重新选择文档
                </Button>
              </div>
            ) : (
              <div className="m-auto w-full max-w-2xl px-6 py-12 text-center sm:px-12">
                <span className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/5 text-primary">
                  <PenLine size={25} strokeWidth={1.5} />
                </span>
                <p className="mb-3 text-[11px] font-medium tracking-[0.2em] text-muted-foreground">
                  给想法一张白纸
                </p>
                <h2 className="text-2xl leading-relaxed font-semibold tracking-tight sm:text-3xl">
                  把想法，写成一篇文档
                </h2>
                <p className="mx-auto mt-4 max-w-sm text-sm leading-7 text-muted-foreground">
                  先聊聊你的灵感，或打开一篇个人文档。
                  <br className="hidden sm:block" />
                  每一份草稿，都由你决定如何落笔。
                </p>
                <div className="mt-7 flex flex-wrap justify-center gap-3">
                  <Button disabled={creating} onClick={() => void createDraft()}>
                    {creating ? (
                      <LoaderCircle size={15} className="animate-spin" />
                    ) : (
                      <FilePlus2 size={15} />
                    )}
                    新建个人草稿
                  </Button>
                  <Button variant="outline" onClick={() => setPicker('target')}>
                    选择已有文档
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>
        <aside
          aria-label="创作对话"
          style={{ '--ai-panel-width': `${panelWidth}px` } as CSSProperties}
          className={`relative min-h-0 min-w-0 flex-col border-border/70 bg-card lg:w-[var(--ai-panel-width)] lg:shrink-0 lg:border-l ${mobileTab === 'chat' ? 'flex w-full' : 'hidden lg:flex'}`}
        >
          <div
            role="separator"
            aria-label="调整对话面板宽度"
            aria-orientation="vertical"
            aria-valuenow={panelWidth}
            aria-valuemin={320}
            aria-valuemax={600}
            tabIndex={0}
            className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize outline-none hover:bg-primary/10 focus-visible:bg-primary/15 lg:block"
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                setPanelWidth((width) =>
                  Math.max(
                    320,
                    Math.min(
                      600,
                      window.innerWidth - 560,
                      width + (event.key === 'ArrowLeft' ? 20 : -20),
                    ),
                  ),
                );
              }
            }}
            onPointerDown={(event) => {
              drag.current = { x: event.clientX, width: panelWidth };
              event.currentTarget.setPointerCapture(event.pointerId);
              event.preventDefault();
            }}
            onPointerMove={(event) => {
              if (drag.current)
                setPanelWidth(
                  Math.max(
                    320,
                    Math.min(
                      600,
                      window.innerWidth - 560,
                      drag.current.width + drag.current.x - event.clientX,
                    ),
                  ),
                );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
          />
          <div
            className="flex shrink-0 items-center gap-1 border-b px-3 py-2"
            aria-label="对话模式"
          >
            {(
              [
                ['writing', '写作', PenLine],
                ['rag', '问答', Compass],
                ['proposal', '改文档', FileText],
              ] as const
            ).map(([kind, label, Icon]) => (
              <Button
                key={kind}
                size="sm"
                variant="ghost"
                disabled={creatingFromChat}
                className={
                  chatKind === kind ? 'bg-secondary text-foreground' : 'text-muted-foreground'
                }
                aria-pressed={chatKind === kind}
                onClick={() => setChatKind(kind)}
              >
                <Icon size={14} aria-hidden="true" />
                {label}
              </Button>
            ))}
            {chatKind !== 'writing' && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setPicker('sources')}
              >
                添加资料
              </Button>
            )}
          </div>
          {!contextHydrated ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              正在恢复对话上下文…
            </p>
          ) : chatKind === 'writing' ? (
            <WritingChat
              key={JSON.stringify([
                'writing',
                identityKey,
                sourceWorkspaceId,
                contextDocumentId,
                [...sourceIds].sort(),
              ])}
              identityKey={identityKey}
              scope={JSON.stringify([sourceWorkspaceId, contextDocumentId])}
              legacyScope={JSON.stringify([sourceWorkspaceId, initialWritingTarget])}
              sourceDocumentIds={sourceIds}
              sourceLabels={sourceQueries.map((query) => query.data?.title ?? '所选资料')}
              onPickSources={() => setPicker('sources')}
              previewDisabled={creatingFromChat}
              onPreview={(draft) => {
                setWritingDraft(draft);
                setMobileTab('document');
              }}
            />
          ) : chatKind === 'rag' ? (
            <RagChat
              key={JSON.stringify(['rag', identityKey, sourceWorkspaceId])}
              identityKey={identityKey}
              scope={sourceWorkspaceId ?? 'all'}
              sourceDocumentIds={sourceIds}
              onUseForWriting={(text, sources) => {
                setInstruction(text);
                setSourceIds(sources);
                setChatKind('proposal');
              }}
            />
          ) : (
            <Chat
              header={
                <div className="zhishu-chat-header">
                  <span>正文修改建议</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busyId}
                    onClick={() => {
                      setMessages([]);
                      setInstruction('');
                      setError(null);
                    }}
                  >
                    新提案
                  </Button>
                </div>
              }
              messages={messages.flatMap((message) => [
                {
                  id: message.id,
                  role: 'user' as const,
                  parts: [
                    { id: `${message.id}:input`, kind: 'text' as const, text: message.instruction },
                  ],
                },
                {
                  id: `proposal:${message.id}`,
                  role: 'assistant' as const,
                  parts: [
                    {
                      id: `${message.id}:proposal`,
                      kind: 'plugin' as const,
                      type: 'authoring-proposal',
                      schemaVersion: 1,
                      fallbackText: '正在读取提案…',
                      content: (
                        <ProposalResult
                          message={message}
                          identityKey={identityKey}
                          onRegenerate={() => {
                            setInstruction(message.instruction);
                          }}
                          onForgetPreview={forgetPreview}
                          onReviewFinished={finishReview}
                          reviewStale={
                            message.id === reviewId ? reviewStale : message.id === staleReviewId
                          }
                          onResend={() => {
                            if (!preparing.current && !busyId) void consume(message);
                          }}
                        />
                      ),
                    },
                  ],
                },
              ])}
              emptyState={<p>生成完整草稿后，检查并接受写入个人文档。</p>}
              status={
                <ChatStatus error={!!error}>
                  {error || '直接描述要修改的内容，替换建议在文档中审阅。'}
                </ChatStatus>
              }
              composer={
                <Composer
                  value={instruction}
                  onValueChange={(value) => {
                    setInstruction(value);
                    if (latestDraft.current)
                      latestDraft.current = { ...latestDraft.current, instruction: value };
                  }}
                  onSubmit={submit}
                  submitting={!!busyId}
                  disabled={!hydrated || !ready}
                  busy={!!busyId}
                  maxLength={8000}
                  attachments={sourceIds.map((id, index) => ({
                    id,
                    label: sourceQueries[index]?.data?.title ?? '所选资料',
                  }))}
                  onRemoveAttachment={
                    busyId
                      ? undefined
                      : (id) => setSourceIds((ids) => ids.filter((sourceId) => sourceId !== id))
                  }
                  messages={{ input: '创作指令', send: '发送创作指令', stop: '停止生成' }}
                  placeholder="描述要起草、改写或翻译的内容…"
                  onStop={async () => {
                    if (preparing.current) {
                      preparation.current?.abort();
                      return;
                    }
                    if (!busyId) return;
                    try {
                      await cancelAiTask(busyId);
                      await queryClient.invalidateQueries({
                        queryKey: ['writing-task', identityKey, busyId],
                      });
                    } catch (cause) {
                      setError(errorMessage(cause));
                    }
                  }}
                />
              }
            />
          )}
        </aside>
      </div>
      {picker && (
        <AiDocumentPicker
          kind={picker}
          selected={picker === 'target' ? [targetId] : sourceIds}
          initialWorkspaceId={picker === 'target' ? document.data?.workspaceId : sourceWorkspaceId}
          onClose={() => setPicker(null)}
          onSelect={(selected) => {
            if (picker === 'target' && selected[0]) {
              selectTarget(selected[0]);
              setMobileTab('document');
            } else setSourceIds(selected);
          }}
        />
      )}
    </div>
  );
}
