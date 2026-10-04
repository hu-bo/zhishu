/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  BookOpen,
  Sparkles,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileText,
  Send,
  Database,
  Search,
  FolderKanban,
  Check,
  ChevronDown,
  CornerDownLeft,
  Lightbulb,
} from 'lucide-react';
import { KnowledgeSource, Workspace } from '../../types/document';
import { storageService } from '../../services/storage';
import { askKnowledgeBase, AiTaskResult } from '../../services/geminiService';

export const KnowledgePage: React.FC = () => {
  const workspaces = storageService.getWorkspaces();
  const [sources, setSources] = useState<KnowledgeSource[]>(() =>
    storageService.getKnowledgeSources()
  );
  
  // Choosing domain = choosing space! Default to first space
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>(
    workspaces.length > 0 ? workspaces[0].id : ''
  );
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<AiTaskResult | null>(null);
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);

  const selectedSpace = workspaces.find((w) => w.id === selectedSpaceId) || workspaces[0];
  const matchingSource = sources.find((s) => s.spaceId === selectedSpaceId) || sources[0];

  const handleSyncSource = (sourceId: string) => {
    setSyncingSourceId(sourceId);
    setTimeout(() => {
      setSources((prev) =>
        prev.map((s) =>
          s.id === sourceId
            ? { ...s, indexStatus: 'ready', lastSyncedAt: new Date().toISOString() }
            : s
        )
      );
      setSyncingSourceId(null);
    }, 1200);
  };

  const handleAsk = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setResult(null);

    try {
      const snippets = [
        {
          title: matchingSource?.title || selectedSpace.name,
          snippet: matchingSource?.snippetSummary || selectedSpace.description,
        },
      ];
      const res = await askKnowledgeBase(query, selectedSpace.name, snippets);
      setResult(res);
    } catch {
      setResult({
        content: '检索异常，请重试。',
        hasSufficientEvidence: false,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const promptSuggestions = [
    '宿主适配器如何保持短时授权 URL 并在过期时自动续签？',
    '实时协同模式下的 durable ack 与新 generation 代次如何演进？',
    '普通快照模式如何检测并发写入冲突并阻止静默覆盖？',
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      <div>
        <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <span>企业知识库智能问答 (WEB-08)</span>
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          选择领域即选择企业知识空间，提问将基于选定空间已建立索引的权威文档证据进行精确溯源。
        </p>
      </div>

      {/* Modern AI Chat / Search Box with Domain Selector at Bottom-Left */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200/90 dark:border-slate-800 rounded-2xl p-4 sm:p-5 shadow-sm space-y-4">
        <form onSubmit={handleAsk} className="space-y-3">
          {/* Main Input Box with integrated bottom-left domain selector */}
          <div className="relative border border-slate-200 dark:border-slate-700/80 rounded-xl bg-slate-50/70 dark:bg-slate-800/50 focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 transition-all">
            <textarea
              rows={3}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAsk();
                }
              }}
              placeholder={`向「${selectedSpace.name}」提问... (例如：宿主适配器重试机制如何工作？并发冲突如何拦截？)`}
              className="w-full bg-transparent p-3.5 pb-2 text-xs sm:text-sm text-slate-900 dark:text-white placeholder-slate-400 outline-none resize-none leading-relaxed"
            />

            {/* Bottom Bar: Domain / Space selector placed at BOTTOM-LEFT as requested */}
            <div className="px-3 pb-2.5 flex items-center justify-between gap-2 flex-wrap">
              {/* Domain = Space selector pill at BOTTOM-LEFT */}
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  选择领域 (空间):
                </span>
                <div className="relative inline-flex items-center bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-800 dark:text-slate-200 shadow-2xs hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                  <span className="mr-1.5 select-none">{selectedSpace.icon}</span>
                  <select
                    value={selectedSpaceId}
                    onChange={(e) => setSelectedSpaceId(e.target.value)}
                    className="bg-transparent font-medium outline-none cursor-pointer pr-4 appearance-none text-xs"
                  >
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id} className="bg-white dark:bg-slate-900 text-slate-900 dark:text-white">
                        {w.name} ({storageService.getDocuments({ view: 'all', spaceId: w.id }).length} 篇)
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2 pointer-events-none" />
                </div>
              </div>

              {/* Bottom-Right Send Button */}
              <button
                type="submit"
                disabled={isLoading || !query.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-xs font-semibold rounded-lg shadow-xs transition-colors"
              >
                {isLoading ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>检索溯源中...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5" />
                    <span>发起问答</span>
                    <span className="hidden sm:inline text-[10px] text-indigo-200 font-mono">↵</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Quick Prompt Suggestions */}
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            <span className="text-[11px] text-slate-400 flex items-center gap-1">
              <Lightbulb className="w-3 h-3 text-amber-500" />
              <span>推荐问题：</span>
            </span>
            {promptSuggestions.map((prompt, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setQuery(prompt)}
                className="text-[11px] text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-md px-2 py-0.5 transition-colors truncate max-w-xs"
              >
                {prompt}
              </button>
            ))}
          </div>
        </form>

        {/* Answer and Citations Card */}
        {result && (
          <div className="p-4 sm:p-5 bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/80 rounded-xl space-y-3 animate-in fade-in duration-150">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span className="text-slate-900 dark:text-white flex items-center gap-1.5">
                <Sparkles className="w-4 h-4 text-amber-500" />
                知识问答结果与证据核验：
              </span>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                  result.hasSufficientEvidence
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                }`}
              >
                {result.hasSufficientEvidence ? '依据充分已校验' : '无充足证据声明'}
              </span>
            </div>

            <p className="text-xs sm:text-sm text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">
              {result.content}
            </p>

            {/* Citations List */}
            {result.citations && result.citations.length > 0 && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  来源溯源文件与片段：
                </div>
                {result.citations.map((c, i) => (
                  <div
                    key={i}
                    className="text-xs text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-between"
                  >
                    <span className="truncate max-w-[85%] font-medium">
                      • [来源 {i + 1}] {c.title}
                    </span>
                    <span className="text-indigo-600 dark:text-indigo-400 text-[11px] font-medium shrink-0">
                      已核验
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Knowledge Sources & Index Status Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden shadow-xs">
        <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
            <Database className="w-4 h-4 text-indigo-600" />
            <span>知识空间索引与向量同步状态</span>
          </div>
          <span className="text-[11px] text-slate-400">每日 02:00 自动构建增量索引</span>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
          {sources.map((src) => {
            const isSyncing = syncingSourceId === src.id;

            return (
              <div
                key={src.id}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors"
              >
                <div className="space-y-1 max-w-2xl">
                  <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
                    <span>{src.title}</span>
                    <span className="text-[11px] text-indigo-600 dark:text-indigo-400 font-normal">
                      [对应空间: {src.spaceName || '企业空间'}]
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 line-clamp-1 leading-relaxed">
                    {src.snippetSummary}
                  </p>
                  <div className="text-[10px] text-slate-400">
                    最后同步: {new Date(src.lastSyncedAt).toLocaleString('zh-CN')}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  {src.indexStatus === 'ready' ? (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>索引已就绪</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-amber-600 font-medium">
                      <AlertCircle className="w-3.5 h-3.5" />
                      <span>增量索引中</span>
                    </span>
                  )}

                  <button
                    onClick={() => handleSyncSource(src.id)}
                    disabled={isSyncing}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    <span>{isSyncing ? '同步中...' : '重新同步'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
