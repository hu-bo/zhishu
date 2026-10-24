import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  ArrowUpRight,
  ChevronDown,
  FilePlus2,
  FileText,
  LoaderCircle,
  MessageSquare,
  Plus,
  Sparkles,
  Square,
  X,
  PenLine,
  Compass,
  Eye,
} from 'lucide-react';
import {
  canonicalJson,
  isReplacementIntent,
  replacementChanges,
  replacementBatch,
  type AuthoringRequest,
} from '@zhishu/ai-contracts';
import { applyOperationBatch, type DocumentContent } from '@zhishu/document-contracts';
import type { EditorReplacementPreviewData } from '@zhishu/editor-core';
import {
  getDocument,
  getAiCapabilities,
  getAiDocumentContext,
  cancelAiTask,
  createKnowledgeWorkspace,
  createDocument,
  getAiTask,
  reviewAiProposal,
} from '@/api/generated/app-api';
import { errorMessage } from '@/api/api-error';
import { hasUnconfirmedChanges } from '@/api/transport';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { useOfflineState } from '@/features/offline/cache';
import { readRecord, writeRecord, writeRecordOnPageExit } from '@/features/offline/storage';
import {
  DocumentCollaborationEditor,
  type DocumentCollaborationSnapshot,
} from '@/features/document/document-collaboration-editor';
import { AiDocumentPicker } from './ai-document-picker';
import { WritingChat } from '@/components/writing-chat/writing-chat';
import { RagChat } from '@/components/rag-chat/rag-chat';
import { AiMessageCard } from './ai-message-card';
import { useChatContext } from './use-chat-context';
import {
  consumeAiTask,
  nodeText,
  proposalText,
  readAiDraft,
  type AiLocalMessage,
  type AiStartBody,
} from './ai-client';

const intents = [
  ['create', '从想法起草'],
  ['continue', '续写'],
  ['rewrite', '改写完整段落'],
  ['rewrite-document', '整篇改写 · 确认后替换'],
  ['summarize', '生成摘要'],
  ['translate', '翻译完整段落'],
] as const;
const stages: Record<string, string> = {
  planning: '正在梳理研究问题…',
  searching: '正在检索所选资料…',
  reading: '正在阅读来源…',
  generating: '正在生成草稿…',
};
async function hash(value: unknown) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

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
  const [targetId, setTargetId] = useState(initialTargetDocumentId ?? '');
  const { sourceIds, setSourceIds, chatKind, setChatKind, contextHydrated } = useChatContext(
    offline.identity,
    JSON.stringify([identityKey, sourceWorkspaceId, contextDocumentId]),
    contextDocumentId,
  );
  const [mode, setMode] = useState<'chat' | 'writing' | 'research'>('writing');
  const [intent, setIntent] = useState<AuthoringRequest['intent']>('create'),
    [blockId, setBlockId] = useState('');
  const [instruction, setInstruction] = useState(''),
    [messages, setMessages] = useState<AiLocalMessage[]>([]),
    [hydrated, setHydrated] = useState(false);
  const [picker, setPicker] = useState<'target' | 'sources' | null>(null),
    [mobileTab, setMobileTab] = useState<'document' | 'chat'>('chat');
  const [busyId, setBusyId] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit'),
    [panelWidth, setPanelWidth] = useState(380);
  const [reviewId, setReviewId] = useState<string | null>(null),
    [staleReviewId, setStaleReviewId] = useState<string | null>(null),
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
  const listRef = useRef<HTMLDivElement | null>(null),
    stick = useRef(true),
    drag = useRef<{ x: number; width: number } | null>(null);
  const draftKey = useRef<{
    workspaceKey: string;
    documentKey: string;
    workspaceId?: string;
  } | null>(null);
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraft = useRef<{ messages: AiLocalMessage[]; instruction: string } | null>(null);
  const flushDraft = useCallback(
    (exiting = false) => {
      if (cacheTimer.current) clearTimeout(cacheTimer.current);
      cacheTimer.current = null;
      if (!offline.identity || !latestDraft.current) return;
      if (exiting) {
        writeRecordOnPageExit(
          offline.identity,
          'ai-draft',
          'writing-proposals',
          latestDraft.current,
        );
        return;
      }
      void writeRecord(
        offline.identity,
        'ai-draft',
        'writing-proposals',
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
  const replacementMode = mode === 'writing' && isReplacementIntent(intent);
  const reviewMessage = messages.find((m) => m.id === reviewId);
  const reviewQuery = useQuery({
    queryKey: ['writing-task', identityKey, reviewId ?? ''],
    queryFn: ({ signal }) => getAiTask(reviewId!, { signal }),
    enabled: enabled && !!reviewId && !!reviewMessage?.registered,
    retry: false,
  });
  const reviewRequest =
    reviewMessage?.body.request.kind === 'authoring' ? reviewMessage.body.request : null;
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
    reviewMessage?.body.request.kind === 'authoring' &&
    reviewMessage.body.request.document.documentId === targetId &&
    isReplacementIntent(reviewMessage.body.request.intent) &&
    !reviewMessage.dismissed &&
    reviewQuery.data.result &&
    'operationBatch' in reviewQuery.data.result;
  const reviewPreview = useMemo<EditorReplacementPreviewData | null>(() => {
    const task = reviewQuery.data,
      message = reviewMessage;
    if (
      !reviewing ||
      reviewBusy ||
      reviewStale ||
      !context.data ||
      editorVersion?.generationId !== reviewVersion?.generationId ||
      editorVersion?.durableSeq !== reviewVersion?.durableSeq ||
      !message?.beforeContent ||
      message.body.request.kind !== 'authoring' ||
      !task?.result ||
      !('operationBatch' in task.result)
    )
      return null;
    const settled = new Set(task.review?.decisions.map((decision) => decision.blockId));
    const pending = replacementChanges(task.result, message.beforeContent)
      .filter((change) => !settled.has(change.blockId))
      .map((change) => change.blockId);
    if (!pending.length) return null;
    const batch = replacementBatch(
      task.result,
      message.beforeContent,
      context.data.snapshot.content,
      pending,
      task.result.operationBatch.operationId,
    );
    if (!batch) return null;
    const applied = applyOperationBatch(context.data.snapshot.content, batch, {
      documentId: targetId,
      generationId: message.body.request.document.generationId,
    });
    return applied.success
      ? { id: message.id, original: context.data.snapshot.content, proposed: applied.content }
      : null;
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
  const selectableBlocks =
    context.data?.snapshot.content.content.filter((block) =>
      ['paragraph', 'heading'].includes(block.type),
    ) ?? [];
  useEffect(() => {
    let active = true;
    if (!offline.identity) return;
    void readRecord(offline.identity, 'ai-draft', 'writing-proposals')
      .then((value) => value ?? readRecord(offline.identity!, 'ai-draft', 'current'))
      .then((value) => {
        if (!active) return;
        const draft = readAiDraft(value);
        if (draft) {
          setMessages(draft.messages);
          setInstruction(draft.instruction);
          setReviewId(
            draft.messages.findLast(
              (m) =>
                m.body.request.kind === 'authoring' &&
                isReplacementIntent(m.body.request.intent) &&
                !m.dismissed,
            )?.id ?? null,
          );
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
    if (stick.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);
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
      current.map((m) =>
        m.id === id && (m.preview || m.beforeText || m.beforeContent)
          ? { ...m, preview: '', beforeText: '', beforeContent: undefined }
          : m,
      ),
    );
  }, []);
  const patch = (id: string, update: Partial<AiLocalMessage>) =>
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, ...update } : message)),
    );
  const consume = async (message: AiLocalMessage) => {
    if (runRef.current) return;
    const controller = new AbortController();
    runRef.current = { id: message.id, controller };
    setBusyId(message.id);
    setError(null);
    try {
      await consumeAiTask(message.body, controller.signal, (event) => {
        if (event.type === 'started')
          patch(message.id, {
            registered: true,
            stage: mode === 'chat' ? '正在生成完整回复…' : '正在准备草稿…',
            error: undefined,
          });
        else if (event.type === 'progress')
          patch(message.id, { stage: stages[event.payload.stage] ?? '正在生成…' });
        else if (event.type === 'text-delta')
          setMessages((current) =>
            current.map((m) =>
              m.id === message.id
                ? { ...m, preview: (m.preview + event.payload.text).slice(0, 64000) }
                : m,
            ),
          );
        else if (event.type === 'proposal' || event.type === 'chat')
          patch(message.id, { preview: proposalText(event.payload) });
        else if (event.type === 'completed') patch(message.id, { stage: '已完成' });
        else if (event.type === 'failed')
          patch(message.id, { error: '本次生成未完成，草稿已保留。', stage: '已停止' });
      });
    } catch (cause) {
      if (!controller.signal.aborted)
        patch(message.id, { registered: true, error: errorMessage(cause), stage: '结果待确认' });
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
      let body: AiStartBody,
        beforeText = '';
      let beforeContent: DocumentContent | undefined;
      if (mode === 'chat')
        body = {
          protocolVersion: 2,
          request: {
            kind: 'chat',
            requestId: id,
            message: text,
            responseMode: sourceIds.length ? 'grounded' : 'discussion',
            ...(sourceIds.length ? { contextRef: 'selected-documents' } : {}),
            previousRequestIds,
          },
          sourceDocumentIds: sourceIds,
        };
      else {
        if (!targetId) {
          setPicker('target');
          throw new Error('请先选择个人文档，或新建个人草稿。');
        }
        if (hasUnconfirmedChanges())
          throw new Error('正文尚有未确认修改，请等待服务器保存确认后再生成。');
        const captured = await getAiDocumentContext(targetId, { signal: preflight.signal });
        if (!captured.aiWritable) throw new Error(captured.reason ?? '请选择本人的个人文档。');
        queryClient.setQueryData(['writing-context', identityKey, targetId], captured);
        const currentIntent = mode === 'research' ? 'research' : intent;
        let target: AuthoringRequest['target'] = {
          kind: 'document-end',
          afterBlockId: captured.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
        };
        if (['rewrite', 'translate'].includes(currentIntent)) {
          const block = captured.snapshot.content.content.find(
            (b) => b.attrs.blockId === blockId && ['paragraph', 'heading'].includes(b.type),
          );
          if (!block) throw new Error('请明确选择要替换的完整段落。');
          target = {
            kind: 'blocks',
            blocks: [{ blockId: block.attrs.blockId, contentHash: await hash(block) }],
          };
          beforeText = nodeText(block);
        }
        if (currentIntent === 'rewrite-document') {
          if (captured.snapshot.content.content.length > 256)
            throw new Error('文章较长，请分段改写。');
          target = { kind: 'document' };
          beforeText = captured.snapshot.content.content.map(nodeText).join('\n\n');
        }
        if (isReplacementIntent(currentIntent)) {
          beforeContent = captured.snapshot.content;
          if (JSON.stringify(beforeContent).length > 256000)
            throw new Error('文章较长，请分段改写。');
        }
        body = {
          protocolVersion: 1,
          sourceDocumentIds: sourceIds,
          previousRequestIds,
          request: {
            kind: 'authoring',
            requestId: id,
            intent: currentIntent,
            instruction: text,
            document: captured.version,
            baseStructureRevision: captured.structureRevision,
            target,
            ...(sourceIds.length ? { contextRef: 'selected-documents' } : {}),
          },
        };
      }
      preflight.signal.throwIfAborted();
      const message: AiLocalMessage = {
        id,
        instruction: text,
        body,
        preview: '',
        stage: '正在开始…',
        registered: false,
        beforeText,
        beforeContent,
        targetTitle: body.request.kind === 'authoring' ? document.data?.title : undefined,
      };
      stick.current = true;
      setMessages((current) => [...current, message]);
      if (beforeContent) {
        setReviewId(id);
        setStaleReviewId(null);
        setReviewError(null);
      }
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
    setTargetId(id);
    setBlockId('');
    setReviewId(null);
    onTargetChange(id);
  };
  const createDraft = async () => {
    if (creating || !enabled || !offline.online) return;
    setCreating(true);
    setError(null);
    try {
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
        keys.workspaceId = workspaceId;
        sessionStorage.setItem(storageKey, JSON.stringify(keys));
        await queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces', identityKey] });
      }
      const created = await createDocument(
        { title: '创作草稿', workspaceId },
        { headers: { 'Idempotency-Key': keys.documentKey } },
      );
      selectTarget(created.id);
      setMode('writing');
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
  const prepareWriting = (message: AiLocalMessage) => {
    setMode('writing');
    setInstruction(`基于前面的讨论，${message.instruction}`.slice(0, 8000));
    if (!targetId) setPicker('target');
  };
  const openReview = async (id: string) => {
    const message = messages.find((m) => m.id === id);
    if (!message || message.body.request.kind !== 'authoring') return;
    if (message.body.request.document.documentId !== targetId) {
      setError('请先打开这轮建议对应的个人文档，再预览替换。');
      return;
    }
    try {
      const [captured, task] = await Promise.all([getAiDocumentContext(targetId), getAiTask(id)]);
      queryClient.setQueryData(['writing-context', identityKey, targetId], captured);
      queryClient.setQueryData(['writing-task', identityKey, id], task);
      if (
        canonicalJson(captured.version) !==
          canonicalJson(task.review?.version ?? message.body.request.document) ||
        captured.structureRevision !==
          (task.review?.structureRevision ?? message.body.request.baseStructureRevision)
      ) {
        setStaleReviewId(id);
        setError('原文版本已变化，请重新生成替换建议。');
        return;
      }
      if (!message.beforeContent) patch(id, { beforeContent: captured.snapshot.content });
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    patch(id, { dismissed: false });
    setReviewId(id);
    setStaleReviewId(null);
    setReviewError(null);
    setMobileTab('document');
  };
  const decideReview = async (id: string, action: 'accept' | 'reject', blockId?: string) => {
    if (reviewingRef.current || !ready) return;
    if (action === 'accept' && (!reviewPreview || reviewStale || viewMode !== 'edit')) return;
    if (action === 'accept' && (hasUnconfirmedChanges() || composing.current)) {
      setReviewError('正文仍有输入或未确认修改，请等待同步后重新核对。');
      return;
    }
    reviewingRef.current = true;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const previous = id === reviewId ? reviewQuery.data : await getAiTask(id);
      if (!previous) return;
      const task = await reviewAiProposal(id, {
        decisionId: crypto.randomUUID(),
        revision: previous.review?.revision ?? 0,
        action,
        ...(blockId ? { blockIds: [blockId] } : {}),
      });
      if (id === reviewId) {
        const captured = await getAiDocumentContext(targetId);
        queryClient.setQueryData(['writing-context', identityKey, targetId], captured);
      }
      queryClient.setQueryData(['writing-task', identityKey, id], task);
      if (task.application.state === 'applied' || task.application.state === 'rejected') {
        patch(id, { dismissed: true });
        setReviewId((current) => (current === id ? null : current));
      } else if (task.application.state === 'conflict') setStaleReviewId(id);
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
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-card px-4 sm:px-6">
        <Sparkles size={17} className="text-primary" />
        <h1 className="text-sm font-medium">AI 创作</h1>
        <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">
          让想法，慢慢成形
        </span>
      </header>
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
                          stale: reviewStale,
                          busy: reviewBusy,
                          disabled:
                            !ready || !!busyId || viewMode !== 'edit' || !context.data?.aiWritable,
                          error: reviewError,
                          onReplace: () => {
                            if (reviewId) void decideReview(reviewId, 'accept');
                          },
                          onAcceptBlock: (blockId) => {
                            if (reviewId) void decideReview(reviewId, 'accept', blockId);
                          },
                          onRejectBlock: (blockId) => {
                            if (reviewId) void decideReview(reviewId, 'reject', blockId);
                          },
                          onDismiss: () => {
                            if (reviewId) void decideReview(reviewId, 'reject');
                          },
                          onInvalidated: () => {
                            if (reviewId && !reviewBusy) setStaleReviewId(reviewId);
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
              <div className="mt-12 grid gap-3 text-left sm:grid-cols-3">
                {[
                  {
                    icon: PenLine,
                    title: '从想法起草',
                    description: '给零散的想法一个清楚的开头',
                    text: '我有一个想法，想和你一起梳理成文档。',
                    mode: 'chat' as const,
                  },
                  {
                    icon: FileText,
                    title: '整理内容大纲',
                    description: '先搭好结构，再慢慢填入细节',
                    text: '帮我整理一份清晰的内容大纲。',
                    mode: 'writing' as const,
                  },
                  {
                    icon: Compass,
                    title: '基于资料撰写',
                    description: '让已有知识成为可靠的依据',
                    text: '请基于所选资料，梳理重点并撰写一份报告。',
                    mode: 'research' as const,
                  },
                ].map((item) => (
                  <button
                    type="button"
                    key={item.title}
                    onClick={() => {
                      setInstruction(item.text);
                      setMode(item.mode);
                      setChatKind(item.mode === 'chat' ? 'writing' : 'proposal');
                      setMobileTab('chat');
                    }}
                    className="rounded-xl border border-border/70 bg-card p-4 outline-none transition-colors hover:border-primary/30 hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <item.icon size={17} className="mb-3 text-muted-foreground" />
                    <span className="block text-xs font-medium">{item.title}</span>
                    <span className="mt-2 block text-[11px] leading-5 text-muted-foreground">
                      {item.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
          <div className="flex shrink-0 flex-wrap gap-1 border-b px-3 py-2" aria-label="对话业务">
            {(
              [
                ['writing', '写作对话'],
                ['rag', '知识问答'],
                ['proposal', '文章提案'],
              ] as const
            ).map(([kind, label]) => (
              <Button
                key={kind}
                size="sm"
                variant="ghost"
                aria-pressed={chatKind === kind}
                onClick={() => setChatKind(kind)}
              >
                {label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setPicker('sources')}>
              添加资料
            </Button>
          </div>
          {!contextHydrated ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              正在恢复对话上下文…
            </p>
          ) : chatKind === 'writing' ? (
            <WritingChat
              key={JSON.stringify(['writing', identityKey, sourceWorkspaceId, targetId, sourceIds])}
              identityKey={identityKey}
              scope={JSON.stringify([sourceWorkspaceId, targetId])}
              sourceDocumentIds={sourceIds}
              onUseForWriting={(text) => {
                setInstruction(text);
                setMode('writing');
                setChatKind('proposal');
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
                setMode('writing');
                setChatKind('proposal');
              }}
            />
          ) : (
            <>
              <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 px-5">
                <h2 className="text-xs font-medium">本次对话</h2>
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
                  <Plus size={14} />
                  新对话
                </Button>
              </div>
              <div
                ref={listRef}
                onScroll={(event) => {
                  const el = event.currentTarget;
                  stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                }}
                className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-5 py-6"
              >
                {messages.length ? (
                  <div className="space-y-8">
                    {messages.map((message) => (
                      <AiMessageCard
                        key={message.id}
                        message={message}
                        identityKey={identityKey}
                        onRegenerate={() => {
                          setInstruction(message.instruction);
                          setMode(
                            message.body.request.kind === 'chat'
                              ? 'chat'
                              : message.body.request.intent === 'research'
                                ? 'research'
                                : 'writing',
                          );
                          if (message.body.request.kind === 'authoring') {
                            setIntent(message.body.request.intent);
                            setBlockId(
                              message.body.request.target.kind === 'blocks'
                                ? (message.body.request.target.blocks[0]?.blockId ?? '')
                                : '',
                            );
                          }
                        }}
                        onUseForWriting={() => prepareWriting(message)}
                        onForgetPreview={forgetPreview}
                        onReview={(id) => void openReview(id)}
                        onDismissReview={(id) => void decideReview(id, 'reject')}
                        reviewStale={
                          message.id === reviewId ? reviewStale : message.id === staleReviewId
                        }
                        onResend={() => {
                          if (!preparing.current && !busyId) void consume(message);
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex min-h-full flex-col justify-center py-8">
                    <Sparkles size={25} strokeWidth={1.4} className="mb-5 text-primary" />
                    <h3 className="text-lg font-medium tracking-tight">今天，想写些什么？</h3>
                    <p className="mt-3 text-[13px] leading-7 text-muted-foreground">
                      从一个问题、一段灵感开始。
                      <br />
                      我们一起把它想清楚，再写下来。
                    </p>
                    <div className="mt-7 space-y-2">
                      {['一起梳理我的想法', '为一篇文章构思大纲', '从所选资料中寻找灵感'].map(
                        (text) => (
                          <button
                            type="button"
                            key={text}
                            onClick={() => setInstruction(text)}
                            className="flex w-full items-center justify-between rounded-lg border border-border/60 px-3 py-2.5 text-left text-xs text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {text}
                            <ArrowUpRight size={13} />
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="shrink-0 border-t border-border/60 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <div className="mb-2 flex items-center gap-1 sm:mb-3" aria-label="本轮任务类型">
                  {(
                    [
                      { value: 'writing', label: '写作', icon: PenLine },
                      { value: 'research', label: '研究', icon: Compass },
                    ] as const
                  ).map((item) => (
                    <Button
                      key={item.value}
                      size="sm"
                      variant="ghost"
                      aria-pressed={mode === item.value}
                      disabled={!!busyId}
                      className={
                        mode === item.value
                          ? 'bg-secondary text-foreground'
                          : 'text-muted-foreground'
                      }
                      onClick={() => setMode(item.value)}
                    >
                      <item.icon size={13} />
                      {item.label}
                    </Button>
                  ))}
                </div>
                {mode === 'writing' && (
                  <select
                    aria-label="写作动作"
                    className="mb-2 h-9 w-full rounded-lg border bg-card px-2 text-xs sm:mb-3"
                    value={intent}
                    disabled={!!busyId}
                    onChange={(event) =>
                      setIntent(event.target.value as AuthoringRequest['intent'])
                    }
                  >
                    {intents.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {mode === 'writing' && ['rewrite', 'translate'].includes(intent) && (
                  <select
                    aria-label="选择完整段落"
                    className="mb-3 h-9 w-full rounded-lg border bg-card px-2 text-xs"
                    value={blockId}
                    onChange={(event) => setBlockId(event.target.value)}
                  >
                    <option value="">选择要替换的完整段落</option>
                    {selectableBlocks.map((block, index) => (
                      <option key={block.attrs.blockId} value={block.attrs.blockId}>
                        {index + 1}. {nodeText(block).slice(0, 40) || '空段落'}
                      </option>
                    ))}
                  </select>
                )}
                {sourceIds.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {sourceIds.map((id, index) => (
                      <span
                        key={id}
                        className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary px-2 py-1 text-[11px] text-muted-foreground"
                      >
                        <FileText size={11} className="shrink-0" />
                        <span className="max-w-40 truncate">
                          {sourceQueries[index]?.data?.title ?? '所选资料'}
                        </span>
                        <button
                          type="button"
                          aria-label={`移除资料 ${sourceQueries[index]?.data?.title ?? index + 1}`}
                          disabled={!!busyId}
                          onClick={() =>
                            setSourceIds((ids) => ids.filter((sourceId) => sourceId !== id))
                          }
                          className="rounded p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="rounded-xl border border-border bg-background/60 p-2 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/5">
                  <Textarea
                    aria-label="创作指令"
                    placeholder={
                      mode === 'chat'
                        ? '聊聊你的想法…'
                        : mode === 'research'
                          ? '想从资料中研究什么问题？'
                          : '描述你想写的内容…'
                    }
                    rows={2}
                    maxLength={8000}
                    disabled={!hydrated}
                    className="max-h-40 min-h-14 resize-none border-0 bg-transparent px-1 py-1 text-[13px] shadow-none focus-visible:ring-0 sm:min-h-20"
                    value={instruction}
                    onChange={(event) => {
                      setInstruction(event.target.value);
                      if (latestDraft.current)
                        latestDraft.current = {
                          ...latestDraft.current,
                          instruction: event.target.value,
                        };
                    }}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={() => {
                      composing.current = false;
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || composing.current) return;
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="mt-1 flex items-center justify-between">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!!busyId}
                      onClick={() => setPicker('sources')}
                    >
                      <Plus size={13} />
                      添加资料
                    </Button>
                    {busyId ? (
                      <Button
                        size="icon-sm"
                        variant="secondary"
                        aria-label="停止生成"
                        onClick={() => {
                          if (preparing.current) {
                            preparation.current?.abort();
                            return;
                          }
                          void cancelAiTask(busyId)
                            .then(() =>
                              queryClient.invalidateQueries({
                                queryKey: ['writing-task', identityKey, busyId],
                              }),
                            )
                            .catch((cause) => setError(errorMessage(cause)));
                        }}
                      >
                        <Square size={13} />
                      </Button>
                    ) : (
                      <Button
                        size="icon-sm"
                        aria-label="发送创作指令"
                        disabled={!instruction.trim() || !ready || !hydrated}
                        onClick={() => void submit()}
                      >
                        <ArrowUp size={16} />
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-center text-[10px] leading-5 text-muted-foreground">
                  {mode === 'chat'
                    ? '讨论不会直接修改文档'
                    : replacementMode
                      ? '生成稿只预览，点击“替换”后才更改原文'
                      : '完整生成后，由你检查并接受'}
                </p>
                {error && (
                  <p role="alert" className="mt-2 text-xs leading-6 text-destructive">
                    {error}
                  </p>
                )}
              </div>
            </>
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
