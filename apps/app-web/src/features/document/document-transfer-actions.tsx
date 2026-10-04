import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Download, LoaderCircle, Upload } from 'lucide-react';
import { exportDocumentJson, importDocumentJson } from '@/api/generated/app-api';
import type { ImportDocumentJsonBody } from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  exportDocumentMarkdown,
  exportStandaloneDocumentHtml,
  exportPlainText,
  importDocumentHtml,
  importPlainText,
} from '@zhishu/editor-core/conversions';
import { createEditorSchema } from '@zhishu/editor-core/schema';
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from '@zhishu/document-contracts';

type ExportFormat = 'json' | 'html' | 'txt' | 'md';
type PendingLossConfirmation = {
  kind: 'export' | 'import';
  title: string;
  losses: string[];
  format?: ExportFormat;
  content?: string;
  body?: ImportDocumentJsonBody;
};

function isDocumentImport(value: unknown): value is ImportDocumentJsonBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.format === 'zhishu.document' &&
    record.formatVersion === 1 &&
    Number.isSafeInteger(record.schemaVersion) &&
    Number(record.schemaVersion) > 0 &&
    (record.title === undefined || typeof record.title === 'string') &&
    (record.extensions === undefined ||
      (Array.isArray(record.extensions) &&
        record.extensions.every(
          (extension) =>
            typeof extension === 'object' &&
            extension !== null &&
            typeof (extension as Record<string, unknown>).name === 'string' &&
            typeof (extension as Record<string, unknown>).version === 'string' &&
            typeof (extension as Record<string, unknown>).required === 'boolean',
        ))) &&
    typeof record.content === 'object' &&
    record.content !== null &&
    !Array.isArray(record.content) &&
    (record.content as Record<string, unknown>).type === 'doc' &&
    Array.isArray((record.content as Record<string, unknown>).content)
  );
}

function safeFileName(title: string): string {
  const withoutControls = [...title]
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('');
  return (
    withoutControls
      .replace(/[<>:"/\\|?*]/gu, '_')
      .trim()
      .slice(0, 120) || 'document'
  );
}

function download(content: string, title: string, format: ExportFormat): void {
  const mediaType =
    format === 'json' ? 'application/json' : format === 'html' ? 'text/html' : 'text/plain';
  const blob = new Blob([content], { type: `${mediaType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFileName(title)}.${format === 'json' ? 'zhishu.json' : format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function reportText(issues: readonly { message: string; path?: string }[]): string {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
    .join('\n');
}

function transferError(cause: unknown): string {
  return cause instanceof Error ? cause.message : errorMessage(cause);
}

export function DocumentTransferActions({
  documentId,
  title,
}: {
  documentId: string;
  title: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingLossConfirmation, setPendingLossConfirmation] =
    useState<PendingLossConfirmation | null>(null);

  const exportFile = async (format: ExportFormat) => {
    setBusy('export');
    setError(null);
    setNotice(null);
    try {
      const exported = await exportDocumentJson(documentId);
      if (format === 'json') {
        download(JSON.stringify(exported, null, 2), exported.title || title, format);
        setNotice('已导出服务端已保存版本的 JSON 包。');
        return;
      }

      const schema = createEditorSchema();
      const converted =
        format === 'html'
          ? exportStandaloneDocumentHtml(exported.content, schema, exported.title || title)
          : format === 'md'
            ? exportDocumentMarkdown(exported.content)
            : exportPlainText(exported.content);
      if (!converted.success) {
        const details = reportText(converted.report.rejected);
        throw new Error(details || converted.error.message);
      }
      const losses = [...converted.report.degraded, ...converted.report.rejected];
      if (losses.length > 0) {
        setPendingLossConfirmation({
          kind: 'export',
          title: exported.title || title,
          losses: reportText(losses).split('\n'),
          format,
          content: converted.value,
        });
        return;
      }
      download(converted.value, exported.title || title, format);
      setNotice(
        losses.length > 0 ? `已导出；转换损失：${reportText(losses)}` : '已导出服务端已保存版本。',
      );
    } catch (cause) {
      setError(transferError(cause));
    } finally {
      setBusy(null);
    }
  };

  const printSavedDocument = async () => {
    const preview = window.open('', '_blank');
    if (!preview) {
      setError('浏览器阻止了打印窗口，请允许弹出窗口后重试。');
      return;
    }
    preview.opener = null;
    setBusy('export');
    setError(null);
    try {
      const exported = await exportDocumentJson(documentId);
      const converted = exportStandaloneDocumentHtml(
        exported.content,
        createEditorSchema(),
        exported.title || title,
      );
      if (!converted.success) throw new Error(converted.error.message);
      if (preview.closed) return;
      preview.document.open();
      preview.document.write(converted.value);
      preview.document.close();
      await preview.document.fonts.ready;
      preview.focus();
      preview.print();
      setNotice('已打开服务端已保存正文的打印窗口，可选择保存为 PDF。私有附件仅呈现文字占位。');
    } catch (cause) {
      preview.close();
      setError(transferError(cause));
    } finally {
      setBusy(null);
    }
  };

  const performImport = async (body: ImportDocumentJsonBody, conversionLosses: string[]) => {
    setBusy('import');
    setError(null);
    setNotice(null);
    try {
      const result = await importDocumentJson(body);
      if (result.status === 'rejected') {
        const details = reportText(result.report.issues);
        throw new Error(details || '服务器拒绝了这份文档。');
      }
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      setPendingLossConfirmation(null);
      await navigate({
        to: '/documents/$documentId',
        params: { documentId: result.document.id },
      });
      if (conversionLosses.length > 0)
        setNotice(`导入完成；格式损失：${conversionLosses.join('；')}`);
      return true;
    } catch (cause) {
      setError(transferError(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const importFile = async (file: File) => {
    if (file.size > 2_200_000) {
      setError('文件超过 2.2 MB 导入限制。');
      return;
    }
    setBusy('import');
    setError(null);
    setNotice(null);
    try {
      const source = await file.text();
      const extension = file.name.split('.').pop()?.toLowerCase();
      let body: ImportDocumentJsonBody;
      let conversionLosses: string[] = [];
      if (extension === 'json') {
        const parsed: unknown = JSON.parse(source);
        if (!isDocumentImport(parsed)) {
          throw new Error('JSON 文件必须是知书 zhishu.document v1 导出包。');
        }
        body = parsed;
      } else {
        const schema = createEditorSchema();
        const converted =
          extension === 'html'
            ? importDocumentHtml(source, schema)
            : extension === 'txt'
              ? importPlainText(source)
              : null;
        if (!converted) throw new Error('仅支持 .zhishu.json、.html 和 .txt 文件。');
        if (!converted.success) {
          const details = reportText(converted.report.rejected);
          throw new Error(details || converted.error.message);
        }
        conversionLosses = [...converted.report.degraded, ...converted.report.rejected].map(
          (issue) => issue.message,
        );
        body = {
          format: 'zhishu.document',
          formatVersion: 1,
          title: file.name.replace(/\.[^.]+$/u, '').slice(0, 200) || '导入文档',
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
          extensions: [],
          content: converted.value,
        };
      }
      if (conversionLosses.length > 0) {
        setPendingLossConfirmation({
          kind: 'import',
          title: file.name,
          losses: conversionLosses.slice(0, 8),
          body,
        });
        return;
      }
      await performImport(body, conversionLosses);
    } catch (cause) {
      setError(transferError(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirmLoss = async () => {
    const pending = pendingLossConfirmation;
    if (!pending) return false;
    if (pending.kind === 'import') {
      return pending.body ? performImport(pending.body, pending.losses) : false;
    }
    if (!pending.format || pending.content === undefined) return false;
    setBusy('export');
    setError(null);
    try {
      download(pending.content, pending.title, pending.format);
      setNotice(`已导出；转换损失：${pending.losses.join('；')}`);
      setPendingLossConfirmation(null);
      return true;
    } catch (cause) {
      setError(transferError(cause));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy !== null} onClick={() => void exportFile('json')}>
          {busy === 'export' ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Download aria-hidden="true" />
          )}
          导出 JSON
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => void exportFile('html')}>
          导出 HTML
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => void exportFile('txt')}>
          导出文本
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => void exportFile('md')}>
          导出 Markdown
        </Button>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => void printSavedDocument()}
        >
          打印 / PDF
        </Button>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => inputRef.current?.click()}
        >
          {busy === 'import' ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <Upload aria-hidden="true" />
          )}
          导入为新文档
        </Button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".json,.html,.txt,application/json,text/html,text/plain"
          aria-label="选择要导入的知书文档、HTML 或纯文本文件"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
      </div>
      {(error || notice) && (
        <p className="text-sm" role={error ? 'alert' : 'status'} aria-live="polite">
          {error ?? notice}
        </p>
      )}
      <ConfirmDialog
        open={pendingLossConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLossConfirmation(null);
        }}
        title={
          pendingLossConfirmation?.kind === 'export' ? '确认导出格式损失？' : '确认导入格式损失？'
        }
        description={
          pendingLossConfirmation?.kind === 'export'
            ? `导出“${pendingLossConfirmation.title}”会丢失部分格式信息，继续将下载服务端已保存的内容。`
            : pendingLossConfirmation
              ? `导入“${pendingLossConfirmation.title}”会创建新文档，以下格式信息无法完整保留。`
              : ''
        }
        confirmLabel={pendingLossConfirmation?.kind === 'export' ? '继续导出' : '继续导入'}
        error={error}
        onConfirm={confirmLoss}
      >
        {pendingLossConfirmation && (
          <ul className="max-h-48 list-disc space-y-1 overflow-y-auto rounded-lg border bg-muted/30 px-8 py-3 text-sm text-muted-foreground">
            {pendingLossConfirmation.losses.map((loss, index) => (
              <li key={`${index}:${loss}`}>{loss}</li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </section>
  );
}
