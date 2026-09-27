import { useEffect, useMemo, useState } from 'react';
import { createCollaborationSession } from '@/api/generated/app-api';
import type { CreateCollaborationSessionBody, GetDocument200 } from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { apiFetch, registerUnconfirmedChangeProbe, subscribeAccessToken } from '@/api/transport';
import { EditorProvider, useEditorCollaborationStatus } from '@zhishu/editor-react';
import { EditorShell } from '@zhishu/editor-ui';
import { HocuspocusCollaborationSession } from '@zhishu/editor-collaboration/hocuspocus';
import type { CollaborationSessionInfo } from '@zhishu/editor-collaboration';
import { createTiptapCollaborationExtension } from '@zhishu/editor-collaboration/tiptap';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { DocumentVersionsPanel } from './-document-versions-panel';

type ActiveSession = {
  key: string;
  info: CollaborationSessionInfo;
  document: Y.Doc;
  session: HocuspocusCollaborationSession;
  extension: ReturnType<typeof createTiptapCollaborationExtension>;
};

type SessionFailure = { key: string; message: string };
export type DocumentCollaborationSnapshot = Pick<
  CollaborationSessionInfo,
  'generationId' | 'schemaVersion' | 'extensions' | 'durableSeq'
> & { documentId: string };

function UnconfirmedChangesProbe({ sessionKey }: { sessionKey: string }) {
  const status = useEditorCollaborationStatus();
  useEffect(() => {
    const unregister = registerUnconfirmedChangeProbe(
      () =>
        status?.persistence === 'pending' ||
        status?.persistence === 'failed' ||
        (status?.pendingUpdateCount ?? 0) > 0,
    );
    return () => {
      unregister();
    };
  }, [sessionKey, status]);
  return null;
}

export function DocumentCollaborationEditor({
  document,
  onStatusChange,
}: {
  document: GetDocument200;
  onStatusChange?: (snapshot: DocumentCollaborationSnapshot | null) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [accessTokenRevision, setAccessTokenRevision] = useState(0);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [failure, setFailure] = useState<SessionFailure | null>(null);
  const extensionsKey = JSON.stringify(
    document.extensions.map(({ name, version, required }) => ({ name, version, required })),
  );
  const sessionKey = `${document.id}:${document.generationId}:${document.schemaVersion}:${accessTokenRevision}:${attempt}`;
  const currentSession = activeSession?.key === sessionKey ? activeSession : null;
  const currentFailure = failure?.key === sessionKey ? failure : null;

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
    const abortController = new AbortController();
    const sessionBody = {
      schemaVersion: document.schemaVersion,
      extensions: JSON.parse(extensionsKey) as CreateCollaborationSessionBody['extensions'],
    };
    const requestSession = (signal?: AbortSignal) =>
      createCollaborationSession(document.id, sessionBody, signal ? { signal } : undefined);

    onStatusChange?.(null);
    setFailure(null);
    const startTimer = setTimeout(() => {
      void (async () => {
        try {
          const info = await requestSession(abortController.signal);
          if (!active) return;
          yDocument = new Y.Doc();
          collaboration = new HocuspocusCollaborationSession({
            document: yDocument,
            session: info,
            refreshSession: () => requestSession(),
            onPersisted: (receipt) => {
              const durableSeq = Math.max(info.durableSeq, receipt.durableSeq);
              setActiveSession((current) => {
                if (current?.key !== sessionKey) return current;
                return { ...current, info: { ...current.info, durableSeq } };
              });
              onStatusChange?.({
                documentId: document.id,
                generationId: info.generationId,
                schemaVersion: info.schemaVersion,
                extensions: info.extensions,
                durableSeq,
              });
            },
          });
          await collaboration.waitUntilSynced();
          if (!active) return;
          const nextSession = {
            key: sessionKey,
            info,
            document: yDocument,
            session: collaboration,
            extension: createTiptapCollaborationExtension(yDocument),
          };
          setActiveSession(nextSession);
          onStatusChange?.({
            documentId: document.id,
            generationId: info.generationId,
            schemaVersion: info.schemaVersion,
            extensions: info.extensions,
            durableSeq: info.durableSeq,
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
      active = false;
      clearTimeout(startTimer);
      abortController.abort();
      collaboration?.destroy();
      yDocument?.destroy();
    };
  }, [
    accessTokenRevision,
    attempt,
    document.generationId,
    document.id,
    document.schemaVersion,
    extensionsKey,
    onStatusChange,
    sessionKey,
  ]);

  const editorOptions = useMemo(() => {
    if (!currentSession) return null;
    return {
      documentId: document.id,
      generationId: currentSession.info.generationId,
      collaborative: true,
      extensions: [currentSession.extension],
      collaborationStructure: {
        mode: 'disabled' as const,
        isRemoteTransaction: (transaction: { getMeta(key: unknown): unknown }) =>
          Boolean(
            (transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
              ?.isChangeOrigin,
          ),
      },
    };
  }, [currentSession, document.id]);

  const editorHostServices = useMemo(
    () => ({
      requestUpload: async (file: File, signal: AbortSignal) => {
        let started:
          | {
              assetId: string;
              fileName: string;
              mediaType: string;
              uploadPath: string;
              completePath: string;
            }
          | undefined;
        try {
          started = await apiFetch<{
            assetId: string;
            fileName: string;
            mediaType: string;
            uploadPath: string;
            completePath: string;
          }>(`/api/documents/${document.id}/asset-uploads`, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: file.name,
              mediaType: file.type,
              size: file.size,
            }),
          });
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32_768) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
          }
          await apiFetch(started.uploadPath, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataBase64: btoa(binary) }),
          });
          return await apiFetch<{
            assetId: string;
            fileName: string;
            mediaType: string;
          }>(started.completePath, { method: 'POST', signal });
        } catch (error) {
          if (started) {
            await apiFetch(`/api/asset-uploads/${encodeURIComponent(started.assetId)}`, {
              method: 'DELETE',
            }).catch(() => undefined);
          }
          throw error;
        }
      },
      resolveAssetURL: async (assetId: string, signal: AbortSignal) => {
        const access = await apiFetch<{ url: string }>(
          `/api/assets/${encodeURIComponent(assetId)}/access`,
          { signal },
        );
        return access.url;
      },
    }),
    [document.id],
  );

  if (currentFailure) {
    return (
      <section className="rounded-2xl border bg-card px-6 py-10 text-center">
        <h2 className="font-semibold">无法连接正文协同会话</h2>
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          {currentFailure.message}
        </p>
        <button
          type="button"
          className="mt-4 rounded-lg border px-4 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试连接
        </button>
      </section>
    );
  }

  if (!currentSession || !editorOptions) {
    return (
      <section
        className="rounded-2xl border bg-card px-6 py-10 text-center text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        正在申请会话并同步正文…
      </section>
    );
  }

  return (
    <EditorProvider
      instanceKey={sessionKey}
      options={editorOptions}
      collaboration={currentSession.session}
      hostServices={editorHostServices}
      readOnlyReason={
        currentSession.info.readOnly ? '你有权查看这篇文档，但没有编辑权限。' : undefined
      }
    >
      <UnconfirmedChangesProbe sessionKey={sessionKey} />
      <EditorShell
        ariaLabel="文档协同编辑器"
        surfaceLabel="文档正文"
        className="rounded-2xl border bg-card p-4 shadow-sm shadow-foreground/[0.02] sm:p-6"
        outline
        outlineLabel="正文大纲"
        find
        blockMenu
        slashMenu
        selectionMenu
        linkEditor
      />
      <DocumentVersionsPanel
        document={document}
        session={currentSession.info}
        sessionKey={sessionKey}
      />
    </EditorProvider>
  );
}
