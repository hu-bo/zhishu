/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Sparkles,
  X,
  Send,
  BookOpen,
  ArrowRight,
  PlusCircle,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  ChevronDown,
  FolderKanban,
} from 'lucide-react';
import { KnowledgeSource, Workspace } from '../../types/document';
import { storageService } from '../../services/storage';
import { askKnowledgeBase, AiTaskResult } from '../../services/geminiService';

interface KnowledgeQaPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  isDrawer?: boolean;
  onInsertToDocument?: (text: string) => void;
}

export const KnowledgeQaPanel: React.FC<KnowledgeQaPanelProps> = ({
  isOpen,
  onClose,
  isDrawer = false,
  onInsertToDocument,
}) => {
  const workspaces = storageService.getWorkspaces();
  const [sources, setSources] = useState<KnowledgeSource[]>(() =>
    storageService.getKnowledgeSources()
  );
  // Choosing domain = choosing space!
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>(
    workspaces.length > 0 ? workspaces[0].id : ''
  );
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AiTaskResult | null>(null);
  const [insertedFeedback, setInsertedFeedback] = useState(false);

  if (!isOpen) return null;

  const currentSpace = workspaces.find((w) => w.id === selectedSpaceId) || workspaces[0];
  const matchingSource = sources.find((s) => s.spaceId === selectedSpaceId) || sources[0];

  const handleAsk = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setResult(null);
    setInsertedFeedback(false);

    try {
      const contextSnippets = [
        {
          title: matchingSource?.title || currentSpace.name,
          snippet: matchingSource?.snippetSummary || currentSpace.description,
        },
      ];

      const res = await askKnowledgeBase(query, currentSpace.name, contextSnippets);
      setResult(res);
    } catch (err) {
      setResult({
        content: '问答请求异常，请点击重试。',
        hasSufficientEvidence: false,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInsert = () => {
    if (result && onInsertToDocument) {
      onInsertToDocument(`【知识库引用·${currentSpace.name}】\n${result.content}`);
      setInsertedFeedback(true);
      setTimeout(() => setInsertedFeedback(false), 2500);
    }
  };

  return (
    <div
      className={`${
        isDrawer
          ? 'fixed inset-y-0 right-0 z-40 w-88 bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800'
          : 'w-88 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shrink-0 sticky top-14 h-[calc(100vh-56px)] overflow-y-auto no-print'
      } flex flex-col`}
    >
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-500" />
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            企业知识库问答 (WEB-08)
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

      <div className="p-3.5 space-y-3 flex-1 overflow-y-auto text-xs">
        {/* Answer Box */}
        {isLoading && (
          <div className="p-4 bg-indigo-50/50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900 rounded-lg flex items-center justify-center gap-2 text-indigo-600 text-xs">
            <span className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            <span>正在检索选定知识空间的证据...</span>
          </div>
        )}

        {result ? (
          <div className="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                问答结论：
              </span>
              {!result.hasSufficientEvidence && (
                <span className="text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950/60 px-1.5 py-0.5 rounded">
                  无充足证据
                </span>
              )}
            </div>

            <p className="text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
              {result.content}
            </p>

            {/* Citations chip */}
            {result.citations && result.citations.length > 0 && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
                <div className="text-[10px] font-semibold text-slate-400">核对证据来源：</div>
                {result.citations.map((c, i) => (
                  <div
                    key={i}
                    className="p-1.5 rounded bg-slate-50 dark:bg-slate-800 text-[11px] text-slate-600 dark:text-slate-300 flex items-center justify-between"
                  >
                    <span className="truncate max-w-[80%]">• [来源 {i + 1}] {c.title}</span>
                    <span className="text-[10px] text-indigo-500">已授权验证</span>
                  </div>
                ))}
              </div>
            )}

            {/* Action: Insert as new block */}
            {onInsertToDocument && result.hasSufficientEvidence && (
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={handleInsert}
                  className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-xs font-medium shadow-xs transition-colors"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  <span>插入新块到正文</span>
                </button>
              </div>
            )}

            {insertedFeedback && (
              <div className="text-[11px] text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                <span>已插入正文尾部！</span>
              </div>
            )}
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-slate-400 space-y-1.5">
            <BookOpen className="w-6 h-6 text-slate-300 dark:text-slate-700 mx-auto" />
            <div>在下方输入框选择空间领域发起知识溯源提问</div>
          </div>
        )}
      </div>

      {/* Modern Input Footer with Domain Selector at BOTTOM-LEFT */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90">
        <form onSubmit={handleAsk} className="space-y-2">
          <div className="border border-slate-200 dark:border-slate-700 rounded-xl bg-white dark:bg-slate-800 p-2 focus-within:ring-1 focus-within:ring-indigo-500">
            <textarea
              rows={2}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAsk();
                }
              }}
              placeholder={`向「${currentSpace.name}」提问...`}
              className="w-full bg-transparent text-xs outline-none resize-none placeholder-slate-400 text-slate-900 dark:text-white"
            />

            {/* Bottom bar inside input card: Domain / Space selector at BOTTOM-LEFT */}
            <div className="flex items-center justify-between pt-1 border-t border-slate-100 dark:border-slate-700/60">
              {/* Bottom-left space / domain selector */}
              <div className="relative inline-flex items-center text-[11px] text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-700/80 px-2 py-0.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                <span className="mr-1 select-none">{currentSpace.icon}</span>
                <select
                  value={selectedSpaceId}
                  onChange={(e) => setSelectedSpaceId(e.target.value)}
                  className="bg-transparent font-medium outline-none cursor-pointer pr-3 appearance-none text-[11px]"
                >
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
                      {w.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3 h-3 text-slate-400 pointer-events-none -ml-2" />
              </div>

              {/* Bottom-right send button */}
              <button
                type="submit"
                disabled={isLoading || !query.trim()}
                className="flex items-center gap-1 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-medium rounded-md shadow-xs transition-colors"
              >
                <Send className="w-3 h-3" />
                <span>提问</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
