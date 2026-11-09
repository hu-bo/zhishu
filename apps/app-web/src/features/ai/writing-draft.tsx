import { useRef, useState } from 'react';
import { FilePlus2, FileText, X } from 'lucide-react';
import {
  cloneContentWithFreshBlockIds,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
} from '@zhishu/document-contracts';
import { createEditorSchema, importDocumentHtml } from '@zhishu/editor-core';
import { importDocumentJson } from '@/api/generated/documents';
import { errorMessage } from '@/api/api-error';
import { hasUnconfirmedChanges } from '@/api/transport';
import { Button } from '@/components/ui/button';
import { renderWritingMarkdown } from '@/components/writing-chat/markdown';
import { WritingMarkdown } from '@/components/writing-chat/writing-markdown';

export function WritingDraft({
  draft,
  canCreate,
  resolveWorkspace,
  onBusyChange,
  onClose,
  onCreated,
}: {
  draft: { id: string; text: string };
  canCreate: boolean;
  resolveWorkspace(): Promise<string>;
  onBusyChange(busy: boolean): void;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const title = Array.from(/^#{1,6}\s+(.+)$/m.exec(draft.text)?.[1]?.trim() || 'AI 写作草稿')
    .slice(0, 200)
    .join('');

  async function create() {
    if (!canCreate || pending.current) return;
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    try {
      if (hasUnconfirmedChanges()) {
        setError('正在保存原文，请等待同步后再创建文档。');
        return;
      }
      const converted = importDocumentHtml(renderWritingMarkdown(draft.text), createEditorSchema());
      if (!converted.success) {
        setError('这份草稿无法转换成文档，可以返回对话继续修改。');
        return;
      }
      // Stable block IDs keep the import request identical when a response is lost.
      let block = 0;
      const content = cloneContentWithFreshBlockIds(
        converted.value,
        () => `block_writing_${++block}`,
      );
      const key = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(draft.id));
      const idempotencyKey = Array.from(new Uint8Array(key), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const result = await importDocumentJson(
        {
          format: 'zhishu.document',
          formatVersion: 1,
          title,
          workspaceId: await resolveWorkspace(),
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
          extensions: [],
          content,
        },
        { headers: { 'Idempotency-Key': `writing-draft-v1.${idempotencyKey}` } },
      );
      if (result.status === 'rejected') {
        setError('服务器无法创建这份草稿，可以返回对话继续修改。');
        return;
      }
      onCreated(result.document.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-card px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <FileText size={16} className="shrink-0 text-primary" aria-hidden="true" />
          文档草稿预览
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭草稿预览"
          onClick={onClose}
          disabled={busy}
        >
          <X size={16} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        <article className="mx-auto max-w-2xl px-5 py-8 text-sm sm:px-10 sm:py-14 sm:text-base">
          <WritingMarkdown text={draft.text} />
        </article>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t bg-card px-4 py-3 sm:px-6">
        {error && (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        )}
        <p className="min-w-0 text-xs text-muted-foreground">
          {canCreate ? '将这版回复存入个人空间' : '联网并校验权限后可创建文档'}
        </p>
        <Button disabled={!canCreate || busy} onClick={() => void create()}>
          <FilePlus2 size={16} aria-hidden="true" />
          {busy ? '正在创建…' : '创建文档'}
        </Button>
      </div>
    </div>
  );
}
