/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { AlignLeft, X, ChevronRight } from 'lucide-react';
import { DocumentBlock } from '../../types/document';

interface OutlinePanelProps {
  blocks: DocumentBlock[];
  isOpen: boolean;
  onClose?: () => void;
  isDrawer?: boolean;
}

export const OutlinePanel: React.FC<OutlinePanelProps> = ({
  blocks,
  isOpen,
  onClose,
  isDrawer = false,
}) => {
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);

  // Extract all heading blocks
  const headings = blocks.filter(
    (b) => b.type === 'heading' && b.text && b.text.trim().length > 0
  );

  // Scroll listener to highlight closest visible heading block
  useEffect(() => {
    const handleScroll = () => {
      const headingElements = headings
        .map((h) => ({ id: h.id, el: document.getElementById(`heading-${h.id}`) }))
        .filter((item): item is { id: string; el: HTMLElement } => item.el !== null);

      if (headingElements.length === 0) return;

      const scrollY = window.scrollY;
      let currentId = headingElements[0].id;

      for (const item of headingElements) {
        const top = item.el.getBoundingClientRect().top;
        if (top <= 120) {
          currentId = item.id;
        } else {
          break;
        }
      }

      setActiveHeadingId(currentId);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [headings]);

  const scrollToHeading = (id: string) => {
    const el = document.getElementById(`heading-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveHeadingId(id);
      if (isDrawer && onClose) {
        onClose();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className={`${
        isDrawer
          ? 'fixed inset-y-0 right-0 z-40 w-72 bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800'
          : 'w-72 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shrink-0 sticky top-14 h-[calc(100vh-56px)] overflow-y-auto no-print'
      } flex flex-col`}
      style={{ width: 'var(--zhishu-ui-detail-w, 288px)' }}
    >
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <AlignLeft className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            文档正文大纲 (Outline)
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Headings list */}
      <div className="p-3 space-y-1 flex-1 overflow-y-auto">
        {headings.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400">
            暂无标题块。使用 H1/H2/H3 生成大纲。
          </div>
        ) : (
          headings.map((h) => {
            const isActive = activeHeadingId === h.id;
            const level = h.headingLevel || 1;
            const indentClass =
              level === 1 ? 'pl-2 font-semibold' : level === 2 ? 'pl-5 font-normal' : 'pl-8 text-[11px]';

            return (
              <button
                key={h.id}
                onClick={() => scrollToHeading(h.id)}
                className={`w-full text-left text-xs py-1.5 pr-2 rounded-md transition-all flex items-center gap-1.5 ${indentClass} ${
                  isActive
                    ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-50/70 dark:bg-indigo-950/40 font-medium'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                }`}
              >
                {isActive && <ChevronRight className="w-3 h-3 text-indigo-600 shrink-0" />}
                <span className="truncate">{h.text}</span>
              </button>
            );
          })
        )}
      </div>

      <div className="p-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400">
        共 {headings.length} 处章节标题
      </div>
    </div>
  );
};
