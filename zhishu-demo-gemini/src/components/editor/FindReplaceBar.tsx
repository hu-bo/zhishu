/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

interface FindReplaceBarProps {
  isOpen: boolean;
  onClose: () => void;
  onSearchChange: (query: string) => void;
  onNavigateMatch: (direction: 'next' | 'prev') => void;
  currentMatchIndex: number;
  totalMatches: number;
}

export const FindReplaceBar: React.FC<FindReplaceBarProps> = ({
  isOpen,
  onClose,
  onSearchChange,
  onNavigateMatch,
  currentMatchIndex,
  totalMatches,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    onSearchChange(val);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onNavigateMatch('prev');
      } else {
        onNavigateMatch('next');
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="absolute top-3 right-6 z-30 flex items-center gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg rounded-lg p-1.5 animate-in slide-in-from-top-2 duration-150 text-xs">
      <div className="flex items-center gap-1.5 px-2 bg-slate-50 dark:bg-slate-800 rounded-md border border-slate-200 dark:border-slate-700">
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="文内查找 (大小写不敏感)..."
          className="w-48 bg-transparent py-1 text-xs text-slate-800 dark:text-slate-200 outline-none placeholder-slate-400"
        />
        <span className="text-[11px] text-slate-400 font-mono select-none">
          {totalMatches > 0 ? `${currentMatchIndex + 1}/${totalMatches}` : query.trim() ? '0/0' : ''}
        </span>
      </div>

      <button
        type="button"
        disabled={totalMatches === 0}
        onClick={() => onNavigateMatch('prev')}
        className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-30"
        title="上一个匹配 (Shift+Enter)"
      >
        <ChevronUp className="w-4 h-4" />
      </button>

      <button
        type="button"
        disabled={totalMatches === 0}
        onClick={() => onNavigateMatch('next')}
        className="p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded disabled:opacity-30"
        title="下一个匹配 (Enter)"
      >
        <ChevronDown className="w-4 h-4" />
      </button>

      <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" />

      <button
        type="button"
        onClick={onClose}
        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
        title="关闭查找 (Esc)"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};
