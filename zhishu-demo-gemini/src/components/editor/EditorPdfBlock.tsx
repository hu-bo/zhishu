/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { FileText, Download, ExternalLink, ShieldCheck, XCircle } from 'lucide-react';
import { documentAssetService } from '../../services/-document-asset-services.ts';

interface EditorPdfBlockProps {
  assetId?: string;
  pdfFilename?: string;
  pdfFileSize?: string;
  pdfPageCount?: number;
  signedAuthUrl?: string;
  isReadOnly?: boolean;
  onDeleteBlock?: () => void;
}

export const EditorPdfBlock: React.FC<EditorPdfBlockProps> = ({
  assetId,
  pdfFilename = '文档附件.pdf',
  pdfFileSize = '1.8 MB',
  pdfPageCount = 12,
  signedAuthUrl,
  isReadOnly = false,
  onDeleteBlock,
}) => {
  const [downloading, setDownloading] = useState(false);

  const resolvedUrl = assetId
    ? documentAssetService.resolveSignedAuthUrl(assetId, signedAuthUrl)
    : signedAuthUrl || '#';

  const handleDownload = () => {
    setDownloading(true);
    setTimeout(() => {
      setDownloading(false);
      // Create mock download anchor
      const a = document.createElement('a');
      a.href = resolvedUrl;
      a.download = pdfFilename;
      a.target = '_blank';
      a.click();
    }, 300);
  };

  return (
    <div className="my-3 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-between gap-3 group transition-all hover:border-slate-300 dark:hover:border-slate-700">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-lg bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex items-center justify-center shrink-0 border border-rose-200 dark:border-rose-900/60">
          <FileText className="w-5 h-5" />
        </div>

        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
              {pdfFilename}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            <span>{pdfFileSize}</span>
            <span>·</span>
            <span>{pdfPageCount} 页</span>
            <span>·</span>
            <span className="flex items-center gap-1 text-[10px] text-indigo-600 dark:text-indigo-400 font-mono">
              <ShieldCheck className="w-3 h-3" />
              <span>{assetId || 'ast_pdf_01'}</span>
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-md transition-colors shadow-xs"
          title="从短时授权签名 URL 读取并下载"
        >
          {downloading ? (
            <span className="w-3 h-3 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
          )}
          <span>下载原件</span>
        </button>

        {!isReadOnly && onDeleteBlock && (
          <button
            onClick={onDeleteBlock}
            className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md transition-colors"
            title="移除附件"
          >
            <XCircle className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
};
