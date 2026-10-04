import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { getDocumentContent, putDocumentContent } from '@/api/generated/app-api';
import type {
  DocumentContent,
  GetDocument200,
  GetDocumentContent200,
} from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { createDocumentDraftExport, registerUnconfirmedChangeProbe } from '@/api/transport';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EditorProvider } from '@zhishu/editor-react';
import { defaultEditorNodeViews } from '@zhishu/editor-ui';
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from '@zhishu/document-contracts';
import { DocumentVersionsPanel } from './document-versions-panel';
import { DocumentEditorShell } from './document-editor-shell';
import { PanelDialog } from '@/components/ui/panel-dialog';
import { createDocumentAssetServices } from './document-asset-services';
import { currentCacheIdentity, useOfflineState, writeScopedRecord } from '@/features/offline/cache';
import {
  currentTabId,
  deleteRecord,
  deleteRecordIf,
  readStandardDraft,
  type StandardDraft,
} from '@/features/offline/storage';
import { downloadLocalDraft } from '@/features/offline/draft-download';

function isDocumentContent(value: unknown): value is DocumentContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === 'doc' &&
    Array.isArray((value as Record<string, unknown>).content)
  );
}

async function loadStandardContent(documentId: string): Promise<GetDocumentContent200> {
  const snapshot = await getDocumentContent(documentId);
  if (snapshot.mode !== 'standard' || !isDocumentContent(snapshot.content)) {
    throw new Error('文档模式已变化或普通正文快照无效，请刷新后重试。');
  }
  return snapshot;
}

export function DocumentStandardEditor({
  document,
  viewMode,
  versionsOpen,
  onVersionsOpenChange,
}: {
  document: GetDocument200;
  viewMode: 'edit' | 'read';
  versionsOpen: boolean;
  onVersionsOpenChange: (open: boolean) => void;
}) {
  const documentId = document.id;
  const offline = useOfflineState();
  const identity = offline.identity;
  const assetServices = useMemo(() => createDocumentAssetServices(documentId), [documentId]);
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<GetDocumentContent200 | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [versionRestoring, setVersionRestoring] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [recoveredDraft, setRecoveredDraft] = useState<StandardDraft | null>(null);
  const [localSaved, setLocalSaved] = useState(false);
  const contentRef = useRef<DocumentContent | null>(null);
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);
  const draftVersionRef = useRef<string | null>(null);
  const discardedRef = useRef(false);
  const localSavedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(localSavedTimer.current);
    },
    [],
  );

  useEffect(() => () => assetServices.dispose(), [assetServices]);

  const installSnapshot = useCallback((next: GetDocumentContent200, remount: boolean) => {
    const content = next.content;
    if (!isDocumentContent(content)) throw new Error('普通正文快照无效。');
    contentRef.current = content;
    dirtyRef.current = false;
    editRevisionRef.current = 0;
    setSnapshot(next);
    setDirty(false);
    setError(null);
    if (remount) setEditorRevision((revision) => revision + 1);
  }, []);

  // Reset to the loading state during render when the load inputs change
  // ("adjusting state when props change" pattern); the effect below then only
  // performs the async load.
  const loadKey = `${documentId}:${identity ?? ''}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (loadedKey !== loadKey) {
    setLoadedKey(loadKey);
    setLoading(true);
    setSnapshot(null);
    setError(null);
  }

  useEffect(() => {
    let active = true;
    void loadStandardContent(documentId)
      .then(async (next) => {
        const draft = identity
          ? await readStandardDraft(identity, documentId).catch(() => null)
          : null;
        if (active) {
          installSnapshot(next, false);
          setRecoveredDraft(draft);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
          void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [documentId, identity, installSnapshot, queryClient]);

  useEffect(() => {
    const unregister = registerUnconfirmedChangeProbe(
      () => dirtyRef.current || !!recoveredDraft,
      () => {
        const content = contentRef.current;
        if (recoveredDraft) return createDocumentDraftExport(recoveredDraft);
        if (!dirtyRef.current || !snapshot || !content) return null;
        return createDocumentDraftExport({
          title: document.title,
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
          extensions: snapshot.extensions,
          content,
        });
      },
      async () => {
        discardedRef.current = true;
        try {
          if (identity) {
            await deleteRecord(identity, 'draft', `${documentId}:${currentTabId()}`);
            if (recoveredDraft && recoveredDraft.tabId !== currentTabId())
              await deleteRecord(identity, 'draft', `${documentId}:${recoveredDraft.tabId}`);
          }
        } catch (cause) {
          discardedRef.current = false;
          throw cause;
        }
      },
    );
    return () => {
      unregister();
    };
  }, [document.title, snapshot, recoveredDraft, documentId, identity]);

  const persistDraft = useCallback(
    async (content: DocumentContent, base: GetDocumentContent200, revision: number) => {
      if (!identity || currentCacheIdentity() !== identity || discardedRef.current) return;
      const draftVersion = crypto.randomUUID();
      draftVersionRef.current = draftVersion;
      await writeScopedRecord(identity, 'draft', `${documentId}:${currentTabId()}`, {
        documentId,
        workspaceId: document.workspaceId,
        generationId: base.generationId,
        schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
        extensions: base.extensions,
        baseRevision: base.snapshotRevision,
        title: document.title,
        content,
        tabId: currentTabId(),
        updatedAt: Date.now(),
        draftVersion,
      } satisfies StandardDraft);
      if (editRevisionRef.current === revision) {
        clearTimeout(localSavedTimer.current);
        localSavedTimer.current = setTimeout(() => {
          if (editRevisionRef.current === revision) setLocalSaved(true);
        }, 160);
      }
    },
    [identity, documentId, document.title, document.workspaceId],
  );

  const handleUpdate = useCallback(
    (content: DocumentContent) => {
      contentRef.current = content;
      editRevisionRef.current += 1;
      dirtyRef.current = true;
      setDirty(true);
      setError(null);
      setLocalSaved(false);
      if (snapshot)
        void persistDraft(content, snapshot, editRevisionRef.current).catch(() =>
          setError('本机草稿保存失败，请及时导出草稿。'),
        );
    },
    [persistDraft, snapshot],
  );

  const performReload = async () => {
    setLoading(true);
    try {
      const next = await loadStandardContent(documentId);
      if (identity)
        await deleteRecord(identity, 'draft', `${documentId}:${currentTabId()}`).catch(
          () => undefined,
        );
      setRecoveredDraft(null);
      installSnapshot(next, true);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      return false;
    } finally {
      setLoading(false);
    }
  };

  const reload = async () => {
    if (dirtyRef.current) {
      setReloadConfirmOpen(true);
      return;
    }
    await performReload();
  };

  const save = async () => {
    if (!snapshot || !dirty || saving) return;
    const content = contentRef.current;
    if (!content) {
      setError('当前编辑器正文不可用，请重新加载。');
      return;
    }
    const editRevision = editRevisionRef.current;
    const savedDraftVersion = draftVersionRef.current;
    setSaving(true);
    setError(null);
    try {
      if (!offline.online || !offline.verified) {
        await persistDraft(content, snapshot, editRevision);
        setError('草稿已保存在本机；联网并登录后，请再次保存正文。');
        return;
      }
      const current = await loadStandardContent(documentId);
      if (
        current.readOnly ||
        current.generationId !== snapshot.generationId ||
        current.snapshotRevision !== snapshot.snapshotRevision
      ) {
        setError(
          current.readOnly
            ? '编辑权限已变化，本机草稿已保留，请导出后核对。'
            : '服务端版本已变化，本机草稿已保留，请导出后核对，或重新加载服务端正文。',
        );
        if (current.readOnly) setSnapshot({ ...snapshot, readOnly: true });
        return;
      }
      const saved = await putDocumentContent(documentId, {
        expectedSnapshotRevision: snapshot.snapshotRevision,
        content,
      });
      setSnapshot(saved);
      void queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      if (editRevisionRef.current === editRevision) {
        dirtyRef.current = false;
        setDirty(false);
        if (identity)
          await deleteRecordIf(
            identity,
            'draft',
            `${documentId}:${currentTabId()}`,
            (value) =>
              typeof value === 'object' &&
              value !== null &&
              (value as StandardDraft).draftVersion === savedDraftVersion,
          ).catch(() => undefined);
      } else if (contentRef.current) {
        await persistDraft(contentRef.current, saved, editRevisionRef.current);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const editingBusy = saving || loading || versionRestoring;

  if (loading && !snapshot) {
    return (
      <section role="status" className="rounded-2xl border bg-card px-6 py-10 text-center">
        正在读取普通模式正文…
      </section>
    );
  }

  if (error && !snapshot) {
    return (
      <section className="rounded-2xl border bg-card px-6 py-10 text-center">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
        <Button className="mt-4" variant="outline" onClick={() => void reload()}>
          重新加载
        </Button>
      </section>
    );
  }

  if (!snapshot || !isDocumentContent(snapshot.content)) return null;

  return (
    <EditorProvider
      key={`${documentId}:${editorRevision}`}
      instanceKey={`${documentId}:standard:${editorRevision}`}
      options={{
        documentId,
        content: snapshot.content,
        editable: !snapshot.readOnly && viewMode === 'edit',
        readOnlyReason: snapshot.readOnly ? '你有权查看这篇文档，但没有编辑权限。' : undefined,
      }}
      nodeViews={defaultEditorNodeViews}
      hostServices={assetServices.hostServices}
      editable={
        !snapshot.readOnly &&
        viewMode === 'edit' &&
        !loading &&
        !versionRestoring &&
        !recoveredDraft
      }
      readOnlyReason={
        snapshot.readOnly
          ? '你有权查看这篇文档，但没有编辑权限。'
          : viewMode === 'read'
            ? '当前为阅读模式。'
            : loading || versionRestoring
              ? '正文重新加载中'
              : undefined
      }
      onUpdate={handleUpdate}
    >
      {recoveredDraft && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted p-3 text-sm"
        >
          <span>
            发现本机未提交草稿。
            {recoveredDraft.generationId !== snapshot.generationId ||
            recoveredDraft.baseRevision !== snapshot.snapshotRevision
              ? '服务端版本已变化，请导出草稿后核对内容。'
              : '恢复后仍需显式保存正文。'}
          </span>
          <Button
            size="sm"
            disabled={
              snapshot.readOnly ||
              recoveredDraft.generationId !== snapshot.generationId ||
              recoveredDraft.baseRevision !== snapshot.snapshotRevision ||
              recoveredDraft.workspaceId !== document.workspaceId
            }
            onClick={() => {
              contentRef.current = recoveredDraft.content;
              dirtyRef.current = true;
              setDirty(true);
              setSnapshot({ ...snapshot, content: recoveredDraft.content });
              setEditorRevision((value) => value + 1);
              const original = recoveredDraft;
              setRecoveredDraft(null);
              void persistDraft(original.content, snapshot, editRevisionRef.current)
                .then(() => {
                  if (identity && original.tabId !== currentTabId())
                    return deleteRecord(identity, 'draft', `${documentId}:${original.tabId}`);
                })
                .catch(() => setError('本机草稿保存失败，请及时导出。'));
            }}
          >
            恢复本机草稿
          </Button>
          <Button size="sm" variant="outline" onClick={() => downloadLocalDraft(recoveredDraft)}>
            导出本机草稿
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!identity) return;
              void deleteRecord(identity, 'draft', `${documentId}:${recoveredDraft.tabId}`)
                .then(() => setRecoveredDraft(null))
                .catch(() => setError('未能清理草稿，请重试。'));
            }}
          >
            放弃本机草稿
          </Button>
        </div>
      )}
      <DocumentEditorShell
        ariaLabel="文档编辑器"
        editingControls={viewMode === 'edit' && !snapshot.readOnly}
        footerSlot={
          <div className="zhishu-ui-savebar">
            <p
              className="zhishu-ui-save-state"
              data-state={
                snapshot.readOnly ? 'readonly' : editingBusy ? 'saving' : dirty ? 'dirty' : 'saved'
              }
              role="status"
              aria-live="polite"
            >
              {editingBusy ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : snapshot.readOnly ? (
                <AlertCircle aria-hidden="true" />
              ) : dirty ? (
                <AlertCircle aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {loading || versionRestoring
                ? '正在重新加载正文…'
                : saving
                  ? '正在保存正文…'
                  : snapshot.readOnly || viewMode === 'read'
                    ? `只读快照 · 修订 ${snapshot.snapshotRevision}`
                    : dirty
                      ? localSaved
                        ? '草稿已保存在本机，尚未提交'
                        : '有未保存的修改'
                      : `全部更改已保存 · 修订 ${snapshot.snapshotRevision}`}
            </p>
            <div className="zhishu-ui-save-actions">
              {error && (
                <Button
                  variant="outline"
                  disabled={loading || saving}
                  onClick={() => void reload()}
                >
                  <RefreshCw aria-hidden="true" />
                  重新加载
                </Button>
              )}
              {!snapshot.readOnly && (viewMode === 'edit' || dirty) && (
                <Button disabled={!dirty || saving || loading} onClick={() => void save()}>
                  {saving ? (
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Save aria-hidden="true" />
                  )}
                  {saving ? '保存中…' : '保存正文'}
                </Button>
              )}
            </div>
            {error && (
              <p className="zhishu-ui-save-error" role="alert">
                {error}
              </p>
            )}
          </div>
        }
      />
      <PanelDialog
        open={versionsOpen}
        onOpenChange={onVersionsOpenChange}
        title="版本历史"
        description="查看已保存的版本、比较差异，或创建一次新的修订恢复。"
      >
        <DocumentVersionsPanel
          document={document}
          sessionKey={`${documentId}:standard`}
          standardSnapshot={snapshot}
          standardBusy={loading || saving || versionRestoring}
          standardDirty={dirty}
          onRestoreBusyChange={setVersionRestoring}
          onVersionRestored={reload}
        />
      </PanelDialog>
      <ConfirmDialog
        open={reloadConfirmOpen}
        onOpenChange={(open) => {
          if (!loading) setReloadConfirmOpen(open);
        }}
        title="放弃正文修改并重新加载？"
        description="当前正文有尚未保存的修改。重新加载会用服务端快照替换这些修改，无法从本地恢复。"
        confirmLabel="放弃修改并重新加载"
        destructive
        error={error}
        onConfirm={performReload}
      />
    </EditorProvider>
  );
}
