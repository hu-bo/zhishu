import { useEffect, useMemo, useRef, useState } from 'react';
import { createCollaborationSession } from '@/api/generated/collaboration';
import { getDocumentContent } from '@/api/generated/documents';
import { searchIdentityDirectory } from '@/api/generated/identity';
import type {
  CreateCollaborationSessionBody,
  GetDocument200,
  GetDocumentContent200,
} from '@/api/generated/app-api.schemas';
import { errorMessage } from '@/api/api-error';
import {
  createDocumentDraftExport,
  registerUnconfirmedChangeProbe,
  subscribeAccessToken,
  hasUnconfirmedChanges,
} from '@/api/transport';
import {
  EditorProvider,
  useEditorCollaborationStatus,
  useEditorInstance,
  type EditorCollaborationPresence,
} from '@zhishu/editor-react';
import { defaultEditorNodeViews, type EditorReplacementReviewProps } from '@zhishu/editor-ui';
import { HocuspocusCollaborationSession } from '@zhishu/editor-collaboration/hocuspocus';
import type { CollaborationSessionInfo } from '@zhishu/editor-collaboration';
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from '@zhishu/document-contracts';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { DocumentVersionsPanel } from './document-versions-panel';
import { DocumentEditorShell } from './document-editor-shell';
import { useDocumentFormulaDialog } from './document-formula-dialog';
import { PanelDialog } from '@/components/ui/panel-dialog';
import { createDocumentAssetServices } from './document-asset-services';
import { currentCacheIdentity, useOfflineState, writeScopedRecord } from '@/features/offline/cache';
import {
  currentTabId,
  deleteRecord,
  readCollaborationCheckpoint,
  type CollaborationCheckpoint,
} from '@/features/offline/storage';
import { downloadLocalDraft } from '@/features/offline/draft-download';

type ActiveSession = {
  key: string;
  info: CollaborationSessionInfo;
  session: HocuspocusCollaborationSession;
  checkpointKey: string;
};

type SessionFailure = { key: string; message: string };
export type DocumentCollaborationSnapshot = Pick<
  CollaborationSessionInfo,
  'generationId' | 'schemaVersion' | 'extensions' | 'durableSeq'
> & { documentId: string };

function UnconfirmedChangesProbe({
  sessionKey,
  document,
  session,
  checkpointKey,
  sessionInfo,
  recovery,
}: {
  sessionKey: string;
  document: GetDocument200;
  session: HocuspocusCollaborationSession;
  checkpointKey: string;
  sessionInfo: CollaborationSessionInfo;
  recovery: Awaited<ReturnType<typeof readCollaborationCheckpoint>>;
}) {
  const status = useEditorCollaborationStatus();
  const { controller } = useEditorInstance();
  const { identity } = useOfflineState();
  const discarded = useRef(false);
  const pendingRevision = useRef<number | null>(null);
  useEffect(() => {
    if (!controller || !identity) return;
    // Re-baseline the pending structure revision for this session instance.
    pendingRevision.current = null;
    let active = true;
    let content = controller.getSnapshot();
    const persist = () => {
      if (
        !active ||
        discarded.current ||
        controller.isDestroyed ||
        currentCacheIdentity() !== identity
      )
        return;
      const pendingUpdates = session.getPendingUpdateBytes();
      if (!document.offlineCacheAllowed) return;
      if (pendingUpdates.length && pendingRevision.current === null)
        pendingRevision.current = session.getStructureRevision();
      if (!pendingUpdates.length) pendingRevision.current = null;
      const checkpoint: CollaborationCheckpoint = {
        documentId: document.id,
        workspaceId: document.workspaceId,
        generationId: sessionInfo.generationId,
        schemaVersion: sessionInfo.schemaVersion,
        extensions: [...sessionInfo.extensions],
        structureRevision: pendingRevision.current ?? session.getStructureRevision(),
        title: document.title,
        content,
        pendingUpdates,
        updatedAt: Date.now(),
        tabId: currentTabId(),
      };
      void writeScopedRecord(identity, 'collaboration', checkpointKey, checkpoint).catch(
        () => undefined,
      );
    };
    const unlisten = controller.subscribe((event) => {
      if (event.docChanged) {
        content = controller.getSnapshot();
        persist();
      }
    });
    const unsubscribe = session.subscribe(persist);
    window.addEventListener('pagehide', persist);
    persist();
    return () => {
      persist();
      active = false;
      unlisten();
      unsubscribe();
      window.removeEventListener('pagehide', persist);
    };
  }, [controller, identity, document, session, checkpointKey, sessionInfo]);
  useEffect(() => {
    const unregister = registerUnconfirmedChangeProbe(
      () =>
        !!recovery ||
        status?.persistence === 'pending' ||
        status?.persistence === 'failed' ||
        (status?.pendingUpdateCount ?? 0) > 0,
      () => {
        if (recovery?.value.content)
          return createDocumentDraftExport({ ...recovery.value, content: recovery.value.content });
        if (!controller || controller.isDestroyed) return null;
        return createDocumentDraftExport({
          title: document.title,
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
          extensions: document.extensions,
          content: controller.getSnapshot(),
        });
      },
      async () => {
        discarded.current = true;
        try {
          if (identity) {
            await deleteRecord(identity, 'collaboration', checkpointKey);
            if (recovery) await deleteRecord(identity, 'collaboration', recovery.key);
          }
        } catch (cause) {
          discarded.current = false;
          throw cause;
        }
      },
    );
    return () => {
      unregister();
    };
  }, [controller, document, sessionKey, status, identity, checkpointKey, recovery]);
  return null;
}

function CachedDraftProbe({
  cached,
  identity,
}: {
  cached: NonNullable<Awaited<ReturnType<typeof readCollaborationCheckpoint>>>;
  identity: string | null;
}) {
  useEffect(
    () =>
      registerUnconfirmedChangeProbe(
        () => cached.value.pendingUpdates.length > 0,
        () =>
          cached.value.content
            ? createDocumentDraftExport({ ...cached.value, content: cached.value.content })
            : null,
        async () => {
          if (identity) await deleteRecord(identity, 'collaboration', cached.key);
        },
      ),
    [cached, identity],
  );
  return null;
}

export function DocumentCollaborationEditor({
  document,
  viewMode,
  onStatusChange,
  onReadOnlyReasonChange,
  onCollaborationPresenceChange,
  versionsOpen,
  onVersionsOpenChange,
  onDocumentInput,
  replacementReview,
}: {
  document: GetDocument200;
  viewMode: 'edit' | 'read';
  onStatusChange?: (snapshot: DocumentCollaborationSnapshot | null) => void;
  onReadOnlyReasonChange?: (reason: string | null) => void;
  onCollaborationPresenceChange?: (participants: readonly EditorCollaborationPresence[]) => void;
  versionsOpen: boolean;
  onVersionsOpenChange: (open: boolean) => void;
  onDocumentInput?: () => void;
  replacementReview?: EditorReplacementReviewProps;
}) {
  const offline = useOfflineState();
  const identity = offline.identity;
  const [cachedCheckpoint, setCachedCheckpoint] =
    useState<Awaited<ReturnType<typeof readCollaborationCheckpoint>>>(null);
  const [recoveryConflict, setRecoveryConflict] =
    useState<Awaited<ReturnType<typeof readCollaborationCheckpoint>>>(null);
  const assetServices = useMemo(() => createDocumentAssetServices(document.id), [document.id]);
  const [attempt, setAttempt] = useState(0);
  const [accessTokenRevision, setAccessTokenRevision] = useState(0);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [failure, setFailure] = useState<SessionFailure | null>(null);
  const [preview, setPreview] = useState<{
    key: string;
    content: NonNullable<GetDocumentContent200['content']>;
  } | null>(null);
  const extensionsKey = JSON.stringify(
    document.extensions.map(({ name, version, required }) => ({ name, version, required })),
  );
  const sessionKey = `${document.id}:${document.generationId}:${document.schemaVersion}:${accessTokenRevision}:${attempt}`;
  const { requestMathSource, formulaDialog } = useDocumentFormulaDialog(sessionKey);
  const [editorError, setEditorError] = useState<{ key: string; message: string }>();
  const currentSession = activeSession?.key === sessionKey ? activeSession : null;
  const currentFailure = failure?.key === sessionKey ? failure : null;
  const previewKey = JSON.stringify([identity, sessionKey]);
  const previewContent = preview?.key === previewKey ? preview.content : undefined;
  const shouldLoadPreview =
    offline.online && offline.verified && !currentSession && !currentFailure;
  const sessionEligible = offline.verified && (offline.online || currentSession !== null);
  const readOnlyReason =
    (!offline.online || !offline.verified) &&
    !currentSession &&
    Boolean(cachedCheckpoint?.value.content)
      ? '本机缓存只读，联网并登录后校验权限。'
      : currentSession?.info.readOnly
        ? '当前协同会话仅允许查看。'
        : viewMode === 'read'
          ? '当前为阅读模式。'
          : null;

  useEffect(() => {
    onReadOnlyReasonChange?.(readOnlyReason);
  }, [onReadOnlyReasonChange, readOnlyReason]);
  useEffect(() => () => onReadOnlyReasonChange?.(null), [onReadOnlyReasonChange]);
  useEffect(() => {
    let active = true;
    if (identity)
      void readCollaborationCheckpoint(identity, document.id)
        .then((value) => {
          if (active) setCachedCheckpoint(value);
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [identity, document.id]);

  useEffect(() => () => assetServices.dispose(), [assetServices]);

  useEffect(() => {
    if (!shouldLoadPreview) return;
    // The snapshot is for display only. The live editor starts from the synced Y.Doc.
    const request = new AbortController();
    void getDocumentContent(document.id, { signal: request.signal })
      .then((snapshot) => {
        if (
          !request.signal.aborted &&
          snapshot.documentId === document.id &&
          snapshot.generationId === document.generationId &&
          snapshot.schemaVersion === document.schemaVersion &&
          snapshot.content
        ) {
          setPreview({ key: previewKey, content: snapshot.content });
        }
      })
      .catch(() => undefined);
    return () => request.abort();
  }, [document.id, document.generationId, document.schemaVersion, previewKey, shouldLoadPreview]);

  useEffect(() => {
    const unsubscribe = subscribeAccessToken(() =>
      setAccessTokenRevision((revision) => revision + 1),
    );
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let yDocument: Y.Doc | undefined;
    let collaboration: HocuspocusCollaborationSession | undefined;
    let releaseStatus: (() => void) | undefined;
    const abortController = new AbortController();
    const sessionBody = {
      schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
      extensions: JSON.parse(extensionsKey) as CreateCollaborationSessionBody['extensions'],
    };
    const requestSession = (signal?: AbortSignal) =>
      createCollaborationSession(document.id, sessionBody, signal ? { signal } : undefined);

    const startTimer = setTimeout(() => {
      // Reset prior status inside the deferred start so the effect body stays
      // free of synchronous state updates.
      onStatusChange?.(null);
      setFailure(null);
      void (async () => {
        try {
          if (!offline.online || !offline.verified) return;
          const info = await requestSession(abortController.signal);
          if (!active) return;
          let latestDurableSeq = info.durableSeq;
          yDocument = new Y.Doc();
          collaboration = new HocuspocusCollaborationSession({
            document: yDocument,
            session: info,
            refreshSession: () => requestSession(),
          });
          // Server-owned changes also advance the durable version, without a local pending update.
          releaseStatus = collaboration.subscribe((status) => {
            if (!active || status.durableSeq <= latestDurableSeq) return;
            latestDurableSeq = status.durableSeq;
            setActiveSession((current) => {
              if (current?.key !== sessionKey) return current;
              return {
                ...current,
                info: { ...current.info, durableSeq: latestDurableSeq },
              };
            });
            onStatusChange?.({
              documentId: document.id,
              generationId: info.generationId,
              schemaVersion: info.schemaVersion,
              extensions: info.extensions,
              durableSeq: latestDurableSeq,
            });
          });
          await collaboration.waitUntilSynced();
          if (!active) return;
          const cached =
            identity && document.offlineCacheAllowed
              ? await readCollaborationCheckpoint(identity, document.id).catch(() => null)
              : null;
          if (!active) return;
          let checkpointKey = `${document.id}:${info.generationId}:${currentTabId()}`;
          if (cached?.value.pendingUpdates.length) {
            const value = cached.value;
            if (
              !info.readOnly &&
              value.generationId === info.generationId &&
              value.schemaVersion === info.schemaVersion &&
              value.workspaceId === document.workspaceId &&
              value.structureRevision === collaboration.getStructureRevision()
            ) {
              collaboration.restorePendingUpdates(value.pendingUpdates);
              const persisted = await collaboration.waitForPersisted(undefined, 15_000);
              if (!active) return;
              if (persisted.status !== 'persisted')
                throw new Error('本机协同草稿尚未获得保存确认，请稍后重试。');
              if (identity)
                await deleteRecord(identity, 'collaboration', cached.key).catch(() => undefined);
              setRecoveryConflict(null);
            } else {
              setRecoveryConflict(cached);
              checkpointKey = `${checkpointKey}:recovery-${crypto.randomUUID()}`;
            }
          }
          const nextSession = {
            key: sessionKey,
            info: { ...info, durableSeq: latestDurableSeq },
            session: collaboration,
            checkpointKey,
          };
          setActiveSession(nextSession);
          setPreview(null);
          onStatusChange?.({
            documentId: document.id,
            generationId: info.generationId,
            schemaVersion: info.schemaVersion,
            extensions: info.extensions,
            durableSeq: latestDurableSeq,
          });
        } catch (error) {
          collaboration?.destroy();
          yDocument?.destroy();
          if (active && !abortController.signal.aborted) {
            setFailure({ key: sessionKey, message: errorMessage(error) });
          }
        }
      })();
    }, 50);

    return () => {
      releaseStatus?.();
      active = false;
      clearTimeout(startTimer);
      abortController.abort();
      collaboration?.destroy();
      yDocument?.destroy();
    };
    // offline.online is intentionally excluded: connectivity flaps must not
    // tear down an established session (retries go through `attempt`);
    // document.workspaceId is stable for the lifetime of a mounted document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accessTokenRevision,
    attempt,
    document.generationId,
    document.id,
    document.schemaVersion,
    extensionsKey,
    onStatusChange,
    sessionKey,
    identity,
    offline.verified,
    sessionEligible,
  ]);

  const editorOptions = useMemo(() => {
    if (!currentSession) return null;
    return {
      documentId: document.id,
      generationId: currentSession.info.generationId,
      collaborative: true,
      requestMathSource,
      collaborationStructure: {
        mode: 'disabled' as const,
        isRemoteTransaction: (transaction: { getMeta(key: unknown): unknown }) =>
          Boolean(
            (transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
              ?.isChangeOrigin,
          ),
      },
    };
  }, [currentSession, document.id, requestMathSource]);

  const editorHostServices = useMemo(
    () => ({
      ...assetServices.hostServices,
      reportError: (error: Error) => setEditorError({ key: sessionKey, message: error.message }),
      searchMembers: (query: string, signal: AbortSignal) =>
        searchIdentityDirectory({ q: query, documentId: document.id }, { signal }),
    }),
    [assetServices.hostServices, document.id, sessionKey],
  );

  if (
    document.offlineCacheAllowed &&
    (!offline.online || !offline.verified) &&
    !currentSession &&
    cachedCheckpoint?.value.content
  ) {
    const value = cachedCheckpoint.value;
    return (
      <EditorProvider
        instanceKey={`${document.id}:offline`}
        options={{ documentId: document.id, content: value.content }}
        nodeViews={defaultEditorNodeViews}
        hostServices={editorHostServices}
        editable={false}
        readOnlyReason="本机缓存，联网并登录后校验权限。"
      >
        <div className="flex h-full min-h-0 flex-col">
          <CachedDraftProbe cached={cachedCheckpoint} identity={identity} />
          <DocumentEditorShell
            ariaLabel="离线文档缓存"
            editingControls={false}
            footerSlot={
              <p role="status">
                本机缓存只读。
                {value.pendingUpdates.length
                  ? '包含尚未确认的协同草稿，联网后会核对版本。'
                  : '联网后重新校验权限和内容。'}
                <button
                  type="button"
                  className="ml-3 underline"
                  onClick={() => downloadLocalDraft({ ...value, content: value.content! })}
                >
                  导出本机内容
                </button>
              </p>
            }
          />
        </div>
      </EditorProvider>
    );
  }

  if (currentFailure) {
    return (
      <section className="rounded-2xl border bg-card px-6 py-10 text-center">
        <h2 className="font-semibold">无法连接正文协同会话</h2>
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          {currentFailure.message}
        </p>
        <button
          type="button"
          className="mt-4 rounded-lg border px-4 py-2 text-sm font-medium outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试连接
        </button>
      </section>
    );
  }

  return (
    <EditorProvider
      instanceKey={sessionKey}
      options={
        editorOptions ?? {
          documentId: document.id,
          generationId: document.generationId,
          content: shouldLoadPreview ? previewContent : undefined,
        }
      }
      loading={!currentSession && !(shouldLoadPreview && previewContent)}
      nodeViews={defaultEditorNodeViews}
      collaboration={currentSession?.session}
      hostServices={currentSession ? editorHostServices : undefined}
      editable={!!currentSession && !currentSession.info.readOnly && viewMode === 'edit'}
      onUpdate={() => {
        if (currentSession && hasUnconfirmedChanges()) onDocumentInput?.();
      }}
      readOnlyReason={
        currentSession?.info.readOnly
          ? '你有权查看这篇文档，但没有编辑权限。'
          : viewMode === 'read'
            ? '当前为阅读模式。'
            : undefined
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {editorError?.key === sessionKey && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b px-4 py-2 text-sm"
          >
            <span>{editorError.message}</span>
            <button type="button" className="underline" onClick={() => setEditorError(undefined)}>
              关闭
            </button>
          </div>
        )}
        {currentSession && recoveryConflict?.value.content && (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border bg-secondary p-3 text-sm"
          >
            <span>本机协同草稿的权限或结构版本已变化，未自动合并。请导出草稿后核对内容。</span>
            <button
              type="button"
              className="underline"
              onClick={() =>
                downloadLocalDraft({
                  ...recoveryConflict.value,
                  content: recoveryConflict.value.content!,
                })
              }
            >
              导出本机草稿
            </button>
            <button
              type="button"
              className="underline"
              onClick={() => {
                if (identity)
                  void deleteRecord(identity, 'collaboration', recoveryConflict.key)
                    .then(() => setRecoveryConflict(null))
                    .catch(() => undefined);
              }}
            >
              放弃这份本机草稿
            </button>
          </div>
        )}
        {currentSession && (
          <UnconfirmedChangesProbe
            sessionKey={sessionKey}
            document={document}
            session={currentSession.session}
            sessionInfo={currentSession.info}
            checkpointKey={currentSession.checkpointKey}
            recovery={recoveryConflict}
          />
        )}
        <DocumentEditorShell
          ariaLabel="文档协同编辑器"
          editingControls={
            !(currentSession?.info.readOnly ?? !document.canWrite) && viewMode === 'edit'
          }
          loading={!currentSession}
          replacementReview={currentSession ? replacementReview : undefined}
          onCollaborationPresenceChange={onCollaborationPresenceChange}
        />
      </div>
      {formulaDialog}
      {currentSession && (
        <PanelDialog
          open={versionsOpen}
          onOpenChange={onVersionsOpenChange}
          title="版本历史"
          description="回顾每一次重要修改，比较差异，找回需要的内容。"
        >
          <DocumentVersionsPanel
            document={document}
            session={currentSession.info}
            sessionKey={sessionKey}
          />
        </PanelDialog>
      )}
    </EditorProvider>
  );
}
