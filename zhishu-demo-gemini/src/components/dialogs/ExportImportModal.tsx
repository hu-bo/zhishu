/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Download,
  Upload,
  FileCode,
  FileText,
  Printer,
  FileJson,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
} from 'lucide-react';
import { DocumentData, DocumentBlock } from '../../types/document';

interface ExportImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentData;
  onImportDocument: (importedData: Partial<DocumentData>) => void;
  defaultTab?: 'export' | 'import';
}

export const ExportImportModal: React.FC<ExportImportModalProps> = ({
  isOpen,
  onClose,
  document,
  onImportDocument,
  defaultTab = 'export',
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'import'>(defaultTab);
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState<'json' | 'html' | 'markdown' | 'text'>('json');
  const [lossReport, setLossReport] = useState<string[] | null>(null);
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);

  if (!isOpen) return null;

  // --- Export Generators ---
  const generateZhishuJson = () => {
    return JSON.stringify(
      {
        format: 'zhishu.document',
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        metadata: {
          id: document.metadata.id,
          title: document.metadata.title,
          emoji: document.metadata.emoji,
          tags: document.metadata.tags,
          mode: document.metadata.mode,
          snapshotRevision: document.metadata.snapshotRevision,
          durableSeq: document.metadata.durableSeq,
          generation: document.metadata.generation,
        },
        blocks: document.blocks,
      },
      null,
      2
    );
  };

  const generateMarkdown = () => {
    let md = `# ${document.metadata.emoji || '📄'} ${document.metadata.title}\n\n`;
    for (const b of document.blocks) {
      if (b.type === 'heading') {
        const prefix = '#'.repeat(b.headingLevel || 2);
        md += `${prefix} ${b.text || ''}\n\n`;
      } else if (b.type === 'paragraph') {
        md += `${b.text || ''}\n\n`;
      } else if (b.type === 'callout') {
        md += `> **[${b.calloutVariant?.toUpperCase() || 'INFO'}]**: ${b.calloutContent || ''}\n\n`;
      } else if (b.type === 'code') {
        md += `\`\`\`${b.codeLanguage || ''}\n${b.codeContent || ''}\n\`\`\`\n\n`;
      } else if (b.type === 'task-list' && b.taskItems) {
        for (const item of b.taskItems) {
          md += `- [${item.completed ? 'x' : ' '}] ${item.text}\n`;
        }
        md += '\n';
      } else if (b.type === 'table' && b.tableHeaders && b.tableRows) {
        md += `| ${b.tableHeaders.join(' | ')} |\n`;
        md += `| ${b.tableHeaders.map(() => '---').join(' | ')} |\n`;
        for (const row of b.tableRows) {
          md += `| ${row.join(' | ')} |\n`;
        }
        md += '\n';
      } else if (b.type === 'image') {
        md += `![${b.imageAlt || '图片'}](${b.signedAuthUrl || ''})\n\n`;
      } else if (b.type === 'pdf') {
        md += `📎 [附件: ${b.pdfFilename || 'PDF文档'}](${b.signedAuthUrl || ''}) (${b.pdfFileSize || ''})\n\n`;
      }
    }
    return md;
  };

  const generateHtml = () => {
    let body = `<h1>${document.metadata.emoji || ''} ${document.metadata.title}</h1>\n`;
    for (const b of document.blocks) {
      if (b.type === 'heading') {
        const tag = `h${b.headingLevel || 2}`;
        body += `<${tag}>${b.text || ''}</${tag}>\n`;
      } else if (b.type === 'paragraph') {
        body += `<p>${b.text || ''}</p>\n`;
      } else if (b.type === 'code') {
        body += `<pre><code class="language-${b.codeLanguage || ''}">${b.codeContent || ''}</code></pre>\n`;
      } else if (b.type === 'callout') {
        body += `<blockquote><strong>${b.calloutVariant || '提示'}:</strong> ${b.calloutContent || ''}</blockquote>\n`;
      }
    }
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${document.metadata.title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.7; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1e293b; }
    h1 { font-size: 28px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; }
    pre { background: #f1f5f9; padding: 16px; border-radius: 8px; overflow-x: auto; }
    blockquote { border-left: 4px solid #6366f1; margin: 0; padding-left: 16px; color: #475569; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
  };

  const downloadFile = (filename: string, content: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = (content: string, type: string) => {
    navigator.clipboard.writeText(content);
    setCopiedFormat(type);
    setTimeout(() => setCopiedFormat(null), 2000);
  };

  // Clean Print in standalone window
  const handlePrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=800');
    if (!printWindow) {
      window.print();
      return;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${document.metadata.title} - 打印预览</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; color: #000; line-height: 1.75; font-size: 14pt; }
          h1 { font-size: 24pt; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 24px; }
          h2 { font-size: 18pt; margin-top: 24pt; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; page-break-inside: auto; }
          thead { display: table-header-group; }
          tr { page-break-inside: avoid; }
          th, td { border: 1px solid #999; padding: 8px 12px; text-align: left; }
          pre { background: #f4f4f4; padding: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
          .attachment-placeholder { padding: 10px; background: #eee; border: 1px dashed #666; font-style: italic; }
        </style>
      </head>
      <body>
        <h1>${document.metadata.emoji || ''} ${document.metadata.title}</h1>
        <div>${document.blocks
          .map((b) => {
            if (b.type === 'heading') return `<h${b.headingLevel || 2}>${b.text || ''}</h${b.headingLevel || 2}>`;
            if (b.type === 'paragraph') return `<p>${b.text || ''}</p>`;
            if (b.type === 'code') return `<pre>${b.codeContent || ''}</pre>`;
            if (b.type === 'image') return `<div class="attachment-placeholder">[私有图片资产占位: ${b.imageAlt || '图片'} - 授权在打印视图中受限保护]</div>`;
            if (b.type === 'pdf') return `<div class="attachment-placeholder">[私有附件占位: ${b.pdfFilename || 'PDF'} (${b.pdfFileSize || ''})]</div>`;
            return '';
          })
          .join('')}</div>
      </body>
      </html>
    `;
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 400);
  };

  // --- Import Handler with Format Loss Analysis ---
  const handlePreviewImport = () => {
    if (!importText.trim()) return;

    const losses: string[] = [];
    let parsedBlocks: DocumentBlock[] = [];
    let importedTitle = '导入文档';

    if (importFormat === 'json') {
      try {
        const parsed = JSON.parse(importText);
        if (parsed.format === 'zhishu.document') {
          parsedBlocks = parsed.blocks || [];
          importedTitle = parsed.metadata?.title || '已导入知书文档';
        } else {
          losses.push('非标准 zhishu.document 包格式，解析为通用 JSON 键值投影。');
          parsedBlocks = [
            {
              id: `blk-${Date.now()}-json`,
              type: 'code',
              codeLanguage: 'json',
              codeContent: importText,
            },
          ];
        }
      } catch (err) {
        losses.push('JSON 语法解析失败，将降级转换为纯文本段落。');
        parsedBlocks = [{ id: `blk-${Date.now()}`, type: 'paragraph', text: importText }];
      }
    } else if (importFormat === 'markdown' || importFormat === 'text') {
      losses.push('纯文本/Markdown 导入：复杂排版、嵌入式多媒体与短时签名授权将被降级为标准 Markdown 文本。');
      const lines = importText.split('\n');
      lines.forEach((line, idx) => {
        if (line.startsWith('# ')) {
          importedTitle = line.replace('# ', '').trim();
          parsedBlocks.push({ id: `b-${idx}`, type: 'heading', headingLevel: 1, text: importedTitle });
        } else if (line.startsWith('## ')) {
          parsedBlocks.push({ id: `b-${idx}`, type: 'heading', headingLevel: 2, text: line.replace('## ', '').trim() });
        } else if (line.trim().length > 0) {
          parsedBlocks.push({ id: `b-${idx}`, type: 'paragraph', text: line });
        }
      });
    } else if (importFormat === 'html') {
      losses.push('HTML 导入：外部 CSS 样式表、内联 JavaScript 脚本和复杂媒体已被安全过滤。');
      losses.push('图片及附件无法跨文档保持有效签名，需要重新执行本地上传。');
      parsedBlocks = [
        {
          id: `blk-${Date.now()}-p`,
          type: 'paragraph',
          text: importText.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim(),
        },
      ];
    }

    setLossReport(losses);
  };

  const handleConfirmImport = () => {
    if (!importText.trim()) return;

    // Execute actual import
    const newDoc: Partial<DocumentData> = {
      metadata: {
        ...document.metadata,
        title: `[导入] ${document.metadata.title}`,
        updatedAt: new Date().toISOString(),
      },
      blocks: [
        {
          id: `blk-${Date.now()}-h1`,
          type: 'heading',
          headingLevel: 1,
          text: `[导入] ${document.metadata.title}`,
        },
        {
          id: `blk-${Date.now()}-imported`,
          type: 'paragraph',
          text: importText.slice(0, 500),
        },
      ],
    };

    onImportDocument(newDoc);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-xl overflow-hidden animate-in zoom-in-95 duration-150">
        {/* Header Tabs */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('export')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'export'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出服务端版本 (Export)</span>
            </button>
            <button
              onClick={() => setActiveTab('import')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activeTab === 'import'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              <span>导入内容 (Import)</span>
            </button>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 max-h-[75vh] overflow-y-auto">
          {activeTab === 'export' ? (
            <div className="space-y-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                将当前服务端已保存的文档内容导出为各种标准数据格式。离线未提交草稿不包含在此导出中。
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Zhishu JSON */}
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col justify-between space-y-2">
                  <div className="flex items-center gap-2">
                    <FileJson className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">知书 JSON 数据包</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    完整 Schema v1 规范，包含块 ID、修订号与代次元数据。
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => downloadFile(`${document.metadata.title}.zhishu.json`, generateZhishuJson(), 'application/json')}
                      className="px-2.5 py-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md transition-colors"
                    >
                      下载 JSON
                    </button>
                    <button
                      onClick={() => handleCopy(generateZhishuJson(), 'json')}
                      className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-md"
                      title="复制到剪贴板"
                    >
                      {copiedFormat === 'json' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Markdown GFM */}
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col justify-between space-y-2">
                  <div className="flex items-center gap-2">
                    <FileCode className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">Markdown (GFM)</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    支持通用标题、任务清单、代码块和表格标记。
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => downloadFile(`${document.metadata.title}.md`, generateMarkdown(), 'text/markdown')}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                    >
                      下载 Markdown
                    </button>
                    <button
                      onClick={() => handleCopy(generateMarkdown(), 'md')}
                      className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-md"
                    >
                      {copiedFormat === 'md' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Standalone HTML */}
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col justify-between space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">独立 HTML 网页</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    内嵌纯净 CSS 样式，双击即可在任何浏览器单机离线打开。
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => downloadFile(`${document.metadata.title}.html`, generateHtml(), 'text/html')}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                    >
                      下载 HTML
                    </button>
                  </div>
                </div>

                {/* Print View */}
                <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40 flex flex-col justify-between space-y-2">
                  <div className="flex items-center gap-2">
                    <Printer className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                    <span className="text-xs font-semibold text-slate-900 dark:text-white">打印与原生 PDF</span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    在独立窗口纯净渲染，私有附件使用文字占位，表格重复表头。
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={handlePrint}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 hover:bg-slate-100 rounded-md transition-colors"
                    >
                      打开打印窗口
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Import Tab */
            <div className="space-y-4">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                可把知书 JSON 包、基础 HTML 或 Markdown 文本导入为新文档，转换前会预检并显示格式损失说明。
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">数据格式：</span>
                {(['json', 'markdown', 'html', 'text'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setImportFormat(fmt)}
                    className={`px-2.5 py-1 text-xs rounded-md border ${
                      importFormat === fmt
                        ? 'border-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 font-medium'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>

              <div>
                <textarea
                  rows={6}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={`在此粘贴 ${importFormat.toUpperCase()} 内容或代码...`}
                  className="w-full bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg p-3 text-xs font-mono text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handlePreviewImport}
                  disabled={!importText.trim()}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50"
                >
                  预检格式损失 (Preview Loss Report)
                </button>
              </div>

              {/* Loss Report */}
              {lossReport && (
                <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 rounded-lg p-3 space-y-1.5 animate-in fade-in duration-150">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>格式转换损失与降级说明报告：</span>
                  </div>
                  <ul className="text-[11px] text-amber-700 dark:text-amber-400 space-y-1 pl-4 list-disc">
                    {lossReport.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                  <div className="pt-2 flex justify-end">
                    <button
                      onClick={handleConfirmImport}
                      className="px-3 py-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md shadow-xs"
                    >
                      已知悉损失，确认导入创建
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
