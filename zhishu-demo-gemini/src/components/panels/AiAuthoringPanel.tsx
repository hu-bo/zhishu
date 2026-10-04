/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Wand2,
  X,
  Check,
  RotateCcw,
  Sparkles,
  Languages,
  FileSpreadsheet,
  FileEdit,
  GitCompare,
} from 'lucide-react';
import { processAiAuthoring } from '../../services/geminiService';
import { DocumentBlock } from '../../types/document';

interface AiAuthoringPanelProps {
  isOpen: boolean;
  onClose?: () => void;
  isDrawer?: boolean;
  selectedBlockText?: string;
  onApplyProposal: (newText: string) => void;
}

export const AiAuthoringPanel: React.FC<AiAuthoringPanelProps> = ({
  isOpen,
  onClose,
  isDrawer = false,
  selectedBlockText = '',
  onApplyProposal,
}) => {
  const [action, setAction] = useState<'continue' | 'rewrite' | 'summarize' | 'translate' | 'outline'>('rewrite');
  const [inputText, setInputText] = useState(selectedBlockText || '知书采用双模式架构，支持实时协同与普通快照。');
  const [extraPrompt, setExtraPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;

    setIsLoading(true);
    setProposal(null);

    try {
      const generated = await processAiAuthoring(action, inputText, extraPrompt);
      setProposal(generated);
    } catch (err) {
      alert('AI 创作提案生成失败，请重试');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAccept = () => {
    if (proposal) {
      onApplyProposal(proposal);
      setProposal(null);
      if (onClose) onClose();
    }
  };

  const actions = [
    { key: 'rewrite', label: '润色改写', icon: <FileEdit className="w-3.5 h-3.5" /> },
    { key: 'continue', label: '智能续写', icon: <Sparkles className="w-3.5 h-3.5" /> },
    { key: 'summarize', label: '提炼摘要', icon: <FileSpreadsheet className="w-3.5 h-3.5" /> },
    { key: 'translate', label: '专业翻译', icon: <Languages className="w-3.5 h-3.5" /> },
    { key: 'outline', label: '生成大纲', icon: <Wand2 className="w-3.5 h-3.5" /> },
  ];

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
          <Wand2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            编辑器 AI 创作助手 (WEB-09)
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
        {/* Action Tabs */}
        <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
          {actions.map((act) => (
            <button
              key={act.key}
              onClick={() => {
                setAction(act.key as any);
                setProposal(null);
              }}
              className={`flex items-center justify-center gap-1 py-1.5 px-2 rounded-md text-[11px] font-medium transition-colors ${
                action === act.key
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {act.icon}
              <span>{act.label}</span>
            </button>
          ))}
        </div>

        {/* Target Text Form */}
        <form onSubmit={handleGenerate} className="space-y-2.5">
          <div>
            <label className="text-[11px] font-medium text-slate-500">
              目标处理文本：
            </label>
            <textarea
              rows={4}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="选定或输入需要处理的正文..."
              className="w-full bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg p-2 text-xs outline-none focus:ring-1 focus:ring-indigo-500 mt-1"
            />
          </div>

          <div>
            <label className="text-[11px] font-medium text-slate-500">
              定制提示词 (选填)：
            </label>
            <input
              type="text"
              value={extraPrompt}
              onChange={(e) => setExtraPrompt(e.target.value)}
              placeholder="例如：采用严谨工程术语、中英双语对照"
              className="w-full bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-indigo-500 mt-1"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading || !inputText.trim()}
            className="w-full flex items-center justify-center gap-1.5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-medium shadow-xs transition-colors"
          >
            {isLoading ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>生成提案中...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>生成 AI 建议与差异</span>
              </>
            )}
          </button>
        </form>

        {/* Proposal Diff & Accept / Reject Preview */}
        {proposal && (
          <div className="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-xs space-y-2.5 animate-in fade-in duration-150">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-slate-200">
              <span className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
                <GitCompare className="w-3.5 h-3.5" />
                AI 提案预览
              </span>
              <span className="text-[10px] text-slate-600 dark:text-slate-300">需用户确认才生效</span>
            </div>

            <div className="p-2.5 bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/60 rounded-md text-emerald-950 dark:text-emerald-200 text-xs leading-relaxed whitespace-pre-wrap">
              {proposal}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setProposal(null)}
                className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
              >
                拒绝
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="flex items-center gap-1 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium shadow-xs"
              >
                <Check className="w-3.5 h-3.5" />
                <span>接受并写入正文</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
