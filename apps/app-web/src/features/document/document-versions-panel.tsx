import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDocumentVersion,
  getDocumentVersionContent,
  listDocumentVersions,
  restoreDocumentVersion,
} from '@/api/generated/app-api';
import type {
  GetDocument200,
  GetDocumentContent200,
  ListDocumentVersions200Item,
} from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { useEditorCollaborationStatus, useEditorInstance } from '@zhishu/editor-react';
import { DocumentReadonlyView } from './document-readonly-view';
import {
  createEditorSchema,
  normalizeTiptapDocumentJSON,
  validateContentForEditor,
} from '@zhishu/editor-core/schema';
import type { CollaborationSessionInfo } from '@zhishu/editor-collaboration';

type PreviewBlock = { id: string; type: string; text: string; index: number };
type PreviewCapture = { versionId: string; content: unknown };

function versionLabel(version: ListDocumentVersions200Item): string {
  return version.kind === 'automatic' ? '自动保存' : version.name;
}

function HistoricalDocumentPreview({
  content,
  instanceKey,
}: {
  content: NonNullable<GetDocumentContent200['content']>;
  instanceKey: string;
}) {
  return (
    <DocumentReadonlyView
      instanceKey={instanceKey}
      content={content}
      readOnlyReason="历史版本只读"
      ariaLabel="历史版本正文预览"
      surfaceLabel="历史版本正文"
      className="zhishu-history-preview-shell"
      toolbar={<div className="zhishu-ui-history-label">历史版本 · 只读快照</div>}
    />
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textContent(value: unknown): string {
  const node = asRecord(value);
  if (!node) return '';
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  if (node.type === 'hardBreak') return '\n';
  return Array.isArray(node.content) ? node.content.map(textContent).join('') : '';
}

function blockTypeLabel(type: string): string {
  if (type === 'heading') return '标题';
  if (type === 'codeBlock') return '代码';
  if (type === 'listItem') return '列表项';
  if (type === 'blockquote') return '引用';
  return '段落';
}

function collectPreviewBlocks(value: unknown): PreviewBlock[] {
  const document = asRecord(value);
  if (!document || !Array.isArray(document.content)) return [];
  const blocks: PreviewBlock[] = [];
  const visit = (nodeValue: unknown) => {
    const node = asRecord(nodeValue);
    if (!node) return;
    const attrs = asRecord(node.attrs);
    if (typeof attrs?.blockId === 'string' && typeof node.type === 'string') {
      blocks.push({
        id: attrs.blockId,
        type: node.type,
        text: textContent(node),
        index: blocks.length,
      });
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  document.content.forEach(visit);
  return blocks;
}

function compareBlocks(before: PreviewBlock[], after: PreviewBlock[]) {
  const beforeById = new Map(before.map((block) => [block.id, block]));
  const afterById = new Map(after.map((block) => [block.id, block]));
  const commonBefore = before.filter((block) => afterById.has(block.id));
  const afterPosition = new Map(after.map((block, index) => [block.id, index]));
  const tailPositions: number[] = [];
  const tailIndexes: number[] = [];
  const previousIndexes = commonBefore.map(() => -1);

  commonBefore.forEach((block, index) => {
    const position = afterPosition.get(block.id)!;
    let low = 0;
    let high = tailPositions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tailPositions[middle]! < position) low = middle + 1;
      else high = middle;
    }
    tailPositions[low] = position;
    previousIndexes[index] = low > 0 ? tailIndexes[low - 1]! : -1;
    tailIndexes[low] = index;
  });

  const stableIds = new Set<string>();
  let stableIndex = tailIndexes[tailPositions.length - 1] ?? -1;
  while (stableIndex >= 0) {
    stableIds.add(commonBefore[stableIndex]!.id);
    stableIndex = previousIndexes[stableIndex]!;
  }
  const movedIds = new Set(
    commonBefore.map((block) => block.id).filter((id) => !stableIds.has(id)),
  );
  const ids = [...before.map((block) => block.id), ...after.map((block) => block.id)];
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    if (seen.has(id)) return [];
    seen.add(id);
    const previous = beforeById.get(id);
    const current = afterById.get(id);
    if (
      previous &&
      current &&
      previous.type === current.type &&
      previous.text === current.text &&
      !movedIds.has(id)
    ) {
      return [];
    }
    return [{ id, previous, current, moved: movedIds.has(id) }];
  });
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

export function DocumentVersionsPanel({
  document,
  session,
  sessionKey,
}: {
  document: GetDocument200;
  session?: CollaborationSessionInfo;
  sessionKey: string;
}) {
  const queryClient = useQueryClient();
  const { controller } = useEditorInstance();
  const status = useEditorCollaborationStatus();
  const [versionName, setVersionName] = useState('');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'document' | 'diff'>('document');
  const [capture, setCapture] = useState<PreviewCapture | null>(null);
  const [working, setWorking] = useState<'create' | string | null>(null);
  const [restoreCandidate, setRestoreCandidate] = useState<ListDocumentVersions200Item | null>(
    null,
  );
  const [feedback, setFeedback] = useState<{ kind: 'status' | 'error'; message: string } | null>(
    null,
  );
  const editorSchema = useMemo(() => createEditorSchema(), []);
  const versionQueryKey = ['document-versions', document.id, sessionKey];
  const versions = useQuery({
    queryKey: versionQueryKey,
    queryFn: ({ signal }) => listDocumentVersions(document.id, { signal }),
  });
  const preview = useQuery({
    queryKey: ['document-version-content', document.id, sessionKey, selectedVersionId],
    queryFn: ({ signal }) => getDocumentVersionContent(document.id, selectedVersionId!, { signal }),
    enabled: selectedVersionId !== null,
  });
  const hasUnconfirmedChanges =
    status?.persistence === 'pending' ||
    status?.persistence === 'failed' ||
    (status?.pendingUpdateCount ?? 0) > 0;
  const canWrite = Boolean(session && !session.readOnly);
  const canSnapshot =
    canWrite &&
    status?.connection === 'connected' &&
    status.sync === 'current' &&
    !hasUnconfirmedChanges;

  const previewValidation = useMemo(() => {
    if (!preview.data?.content) return null;
    try {
      return validateContentForEditor(
        normalizeTiptapDocumentJSON(preview.data.content),
        editorSchema,
      );
    } catch {
      return null;
    }
  }, [editorSchema, preview.data]);
  const currentValidation = useMemo(() => {
    if (!capture || capture.versionId !== selectedVersionId) return null;
    try {
      return validateContentForEditor(normalizeTiptapDocumentJSON(capture.content), editorSchema);
    } catch {
      return null;
    }
  }, [capture, editorSchema, selectedVersionId]);
  const differences = useMemo(() => {
    if (!previewValidation?.success || !currentValidation?.success) return [];
    return compareBlocks(
      collectPreviewBlocks(previewValidation.content),
      collectPreviewBlocks(currentValidation.content),
    );
  }, [currentValidation, previewValidation]);

  const createNamedVersion = async () => {
    const name = versionName.trim();
    if (!name || !canSnapshot || working) return;
    setWorking('create');
    setFeedback(null);
    try {
      const created = await createDocumentVersion(document.id, {
        name,
        expectedGenerationId: session!.generationId,
        expectedDurableSeq: session!.durableSeq,
      });
      await queryClient.invalidateQueries({ queryKey: versionQueryKey });
      setVersionName('');
      setFeedback({ kind: 'status', message: `已保存版本“${created.name}”。` });
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
    } finally {
      setWorking(null);
    }
  };

  const captureCurrentForComparison = (version: ListDocumentVersions200Item) => {
    setSelectedVersionId(version.id);
    setPreviewMode('document');
    setFeedback(null);
    setCapture({ versionId: version.id, content: controller?.editor.getJSON() });
  };

  const restore = async (version: ListDocumentVersions200Item) => {
    if (!canSnapshot || working) return false;
    setWorking(version.id);
    setFeedback(null);
    try {
      const restored = await restoreDocumentVersion(document.id, version.id, {
        expectedGenerationId: session!.generationId,
        expectedDurableSeq: session!.durableSeq,
      });
      queryClient.setQueryData(['document', document.id], restored);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: versionQueryKey }),
      ]);
      setSelectedVersionId(null);
      setCapture(null);
      setFeedback({
        kind: 'status',
        message: `已恢复“${versionLabel(version)}”。`,
      });
      setRestoreCandidate(null);
      return true;
    } catch (error) {
      setFeedback({ kind: 'error', message: errorMessage(error) });
      return false;
    } finally {
      setWorking(null);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-muted-foreground">自动保存与手动命名的历史记录</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={versions.isFetching}
          onClick={() => void versions.refetch()}
        >
          刷新版本
        </Button>
      </div>

      {canWrite && (
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void createNamedVersion();
          }}
        >
          <label className="sr-only" htmlFor={`version-name-${document.id}`}>
            新版本名称
          </label>
          <Input
            id={`version-name-${document.id}`}
            maxLength={200}
            placeholder="为当前已保存内容命名"
            value={versionName}
            onChange={(event) => setVersionName(event.target.value)}
          />
          <Button type="submit" disabled={!versionName.trim() || !canSnapshot || working !== null}>
            {working === 'create' ? '正在保存…' : '保存命名版本'}
          </Button>
        </form>
      )}

      {canWrite && !canSnapshot && (
        <p className="text-sm text-muted-foreground" role="status">
          {hasUnconfirmedChanges
            ? '正在保存最新修改，完成后即可保存或恢复版本。'
            : '等待协同连接与同步完成后，可保存或恢复版本。'}
        </p>
      )}

      {versions.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          正在读取版本…
        </p>
      ) : versions.isError ? (
        <div className="space-y-2" role="alert">
          <p className="text-sm text-destructive">{errorMessage(versions.error)}</p>
          <Button type="button" variant="outline" onClick={() => void versions.refetch()}>
            重试
          </Button>
        </div>
      ) : versions.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有保存的命名版本。</p>
      ) : (
        <ol className="divide-y rounded-xl border">
          {versions.data.map((version) => (
            <li key={version.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h3 className="flex min-w-0 items-center gap-2 font-medium">
                  <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                    {version.kind === 'automatic' ? '自动版本' : '命名版本'}
                  </span>
                  <span className="truncate">{versionLabel(version)}</span>
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDate(version.createdAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!controller}
                  aria-pressed={selectedVersionId === version.id}
                  onClick={() => captureCurrentForComparison(version)}
                >
                  预览正文
                </Button>
                {canWrite && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canSnapshot || working !== null}
                    onClick={() => {
                      setFeedback(null);
                      setRestoreCandidate(version);
                    }}
                  >
                    {working === version.id ? '正在恢复…' : '恢复此版本'}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {selectedVersionId && (
        <section
          className="space-y-3 rounded-xl border bg-secondary/30 p-4"
          aria-label="历史版本预览"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">
              {versions.data?.find((version) => version.id === selectedVersionId)?.name ?? '版本'}
            </h3>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                const selected = versions.data?.find((version) => version.id === selectedVersionId);
                if (selected) captureCurrentForComparison(selected);
              }}
            >
              刷新对比
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            当前正文按打开预览时的编辑器内容比较；差异按稳定 Block ID、类型和文本显示。
          </p>
          <div className="flex gap-2" aria-label="预览方式">
            <Button
              type="button"
              variant={previewMode === 'document' ? 'default' : 'outline'}
              aria-pressed={previewMode === 'document'}
              onClick={() => setPreviewMode('document')}
            >
              历史正文
            </Button>
            <Button
              type="button"
              variant={previewMode === 'diff' ? 'default' : 'outline'}
              aria-pressed={previewMode === 'diff'}
              onClick={() => setPreviewMode('diff')}
            >
              与当前正文比较
            </Button>
          </div>
          {preview.isPending ? (
            <p className="text-sm text-muted-foreground" role="status">
              正在重建历史正文…
            </p>
          ) : preview.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {errorMessage(preview.error)}
            </p>
          ) : !previewValidation?.success ? (
            <p className="text-sm text-destructive" role="alert">
              这个版本的内容格式暂不兼容，无法预览。
            </p>
          ) : !currentValidation?.success ? (
            <p className="text-sm text-destructive" role="alert">
              当前正文暂时不可比较，请关闭预览并重试。
            </p>
          ) : previewMode === 'document' ? (
            <div aria-label="历史正文">
              <HistoricalDocumentPreview
                instanceKey={`${document.id}:history:${selectedVersionId}`}
                content={previewValidation.content}
              />
            </div>
          ) : !currentValidation?.success ? (
            <p className="text-sm text-destructive" role="alert">
              当前正文暂时不可比较，请关闭预览并重试。
            </p>
          ) : differences.length === 0 ? (
            <p className="text-sm text-muted-foreground">这两个时点的 Block 内容相同。</p>
          ) : (
            <ul className="max-h-96 space-y-2 overflow-auto" aria-label="正文差异">
              {differences.slice(0, 100).map(({ id, previous, current, moved }) => (
                <li
                  key={id}
                  className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-2"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">
                      版本 · {previous ? blockTypeLabel(previous.type) : '已删除'}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {previous?.text || (previous ? '（空内容）' : '—')}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">
                      当前 · {current ? blockTypeLabel(current.type) : '已移除'}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {current?.text || (current ? '（空内容）' : '—')}
                    </p>
                    {current && moved && (
                      <p className="mt-1 text-xs text-muted-foreground">顺序已调整</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {differences.length > 100 && (
            <p className="text-xs text-muted-foreground">仅显示前 100 个差异 Block。</p>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSelectedVersionId(null);
              setCapture(null);
              setPreviewMode('document');
            }}
          >
            关闭预览
          </Button>
        </section>
      )}

      {feedback && (
        <p
          className={feedback.kind === 'error' ? 'text-sm text-destructive' : 'text-sm'}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      )}
      <ConfirmDialog
        open={restoreCandidate !== null}
        onOpenChange={(open) => {
          if (!open && working === null) setRestoreCandidate(null);
        }}
        title="恢复历史版本？"
        description={
          restoreCandidate
            ? `恢复到“${versionLabel(restoreCandidate)}”将替换当前正文，请先确认最新内容已保存。`
            : ''
        }
        confirmLabel="恢复此版本"
        destructive
        error={feedback?.kind === 'error' ? feedback.message : null}
        onConfirm={() => (restoreCandidate ? restore(restoreCandidate) : false)}
      />
    </section>
  );
}
