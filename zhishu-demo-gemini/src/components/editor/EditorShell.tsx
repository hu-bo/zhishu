/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { DocumentBlock, DocumentMode } from '../../types/document';

interface EditorShellProps {
  children: React.ReactNode;
  blocks: DocumentBlock[];
  mode: DocumentMode;
  durableSeq?: number;
  snapshotRevision?: number;
  generation?: string;
  isReadOnly?: boolean;
}

export const EditorShell: React.FC<EditorShellProps> = ({
  children,
  blocks,
  mode,
  durableSeq = 0,
  snapshotRevision = 1,
  generation = 'none',
  isReadOnly = false,
}) => {
  // Calculate text statistics
  const fullText = blocks
    .map((b) => {
      if (b.type === 'heading' || b.type === 'paragraph') return b.text || '';
      if (b.type === 'code') return b.codeContent || '';
      if (b.type === 'bullet-list' || b.type === 'ordered-list') return (b.listItems || []).join(' ');
      if (b.type === 'task-list') return (b.taskItems || []).map((t) => t.text).join(' ');
      if (b.type === 'callout') return b.calloutContent || '';
      return '';
    })
    .join(' ');

  const charCount = fullText.length;
  // Word count heuristic for Chinese + English
  const englishWords = (fullText.match(/[a-zA-Z0-9_-]+/g) || []).length;
  const chineseChars = (fullText.match(/[\u4e00-\u9fa5]/g) || []).length;
  const totalWords = englishWords + chineseChars;
  const readingTimeMin = Math.max(1, Math.ceil(totalWords / 300));

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* 896px max width content canvas (syncscribe baseline) */}
      <div className="flex-1 w-full max-w-[896px] mx-auto px-4 sm:px-8 py-8">
        <div className="bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 rounded-xl shadow-xs p-6 sm:p-12 min-h-[750px] transition-colors">
          {children}
        </div>
      </div>

      {/* Package-level Statistics & Revision Footer */}
      <footer className="sticky bottom-0 z-10 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-t border-slate-200 dark:border-slate-800 px-6 py-2 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between no-print">
        <div className="flex items-center gap-3">
          <span>总计 {totalWords} 字</span>
          <span>·</span>
          <span>{charCount} 字符</span>
          <span>·</span>
          <span>预估阅读 {readingTimeMin} 分钟</span>
        </div>

        <div className="flex items-center gap-3 font-mono text-[11px]">
          {mode === 'collaborative' ? (
            <span className="text-indigo-600 dark:text-indigo-400 font-medium">
              协同耐久序号 durableSeq: {durableSeq} ({generation})
            </span>
          ) : (
            <span className="text-slate-600 dark:text-slate-300 font-medium">
              快照修订号 snapshotRevision: rev {snapshotRevision}
            </span>
          )}

          {isReadOnly && (
            <span className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded text-[10px] font-sans">
              只读视图
            </span>
          )}
        </div>
      </footer>
    </div>
  );
};
