/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, FileText, Users2, Sparkles, BookCheck, Shield } from 'lucide-react';
import { DocumentMode, Workspace } from '../../types/document';

interface CreateDocumentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaces: Workspace[];
  selectedSpaceId: string | null;
  onCreate: (params: {
    title: string;
    mode: DocumentMode;
    emoji: string;
    spaceId: string | null;
    template: 'blank' | 'rfc' | 'meeting' | 'api';
    idempotencyKey: string;
  }) => void;
}

export const CreateDocumentDialog: React.FC<CreateDocumentDialogProps> = ({
  isOpen,
  onClose,
  workspaces,
  selectedSpaceId,
  onCreate,
}) => {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<DocumentMode>('collaborative');
  const [template, setTemplate] = useState<'blank' | 'rfc' | 'meeting' | 'api'>('blank');
  const [spaceId, setSpaceId] = useState<string | null>(selectedSpaceId);
  const [emoji, setEmoji] = useState('📘');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsSubmitting(true);
    const idempotencyKey = `idem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    setTimeout(() => {
      onCreate({
        title: title.trim(),
        mode,
        emoji,
        spaceId,
        template,
        idempotencyKey,
      });
      setIsSubmitting(false);
      onClose();
    }, 250);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              新建知书文档
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Title and Icon */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              文档标题与图标：
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value.slice(0, 2))}
                className="w-10 text-center bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg py-2 text-base outline-none"
              />
              <input
                type="text"
                required
                placeholder="输入文档标题 (例如：知书双模式协同技术白皮书)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          {/* Mode Selection (Explicit Dual Mode) */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              选择内容模式 (双模式规范)：
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setMode('collaborative');
                  setEmoji('📘');
                }}
                className={`p-3 rounded-lg border text-left transition-all ${
                  mode === 'collaborative'
                    ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-950 dark:text-indigo-200 shadow-xs'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-600 dark:text-slate-400'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs mb-1 text-indigo-600 dark:text-indigo-400">
                  <Users2 className="w-4 h-4" />
                  <span>实时协同文档</span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  基于 Hocuspocus/Yjs 协议，支持多人实时共创、durable ack 持久化序列与 generation 代次演进。
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMode('snapshot');
                  setEmoji('📝');
                }}
                className={`p-3 rounded-lg border text-left transition-all ${
                  mode === 'snapshot'
                    ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-950 dark:text-indigo-200 shadow-xs'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-600 dark:text-slate-400'
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs mb-1 text-indigo-600 dark:text-indigo-400">
                  <FileText className="w-4 h-4" />
                  <span>普通快照文档</span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  独立 JSON 快照编辑器，显式提交修订号 (snapshotRevision)，具备并发版本冲突检测。
                </div>
              </button>
            </div>
          </div>

          {/* Template Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              预置模板：
            </label>
            <div className="grid grid-cols-4 gap-2 text-xs">
              {[
                { id: 'blank', label: '空白文档', desc: '自由起步' },
                { id: 'rfc', label: 'RFC技术规范', desc: '架构评审' },
                { id: 'meeting', label: '会议纪要', desc: '待办跟踪' },
                { id: 'api', label: 'API接口文档', desc: '规范定义' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplate(t.id as any)}
                  className={`p-2.5 rounded-lg border text-center transition-all ${
                    template === t.id
                      ? 'border-indigo-600 bg-indigo-50/50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-300 font-medium'
                      : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <div className="font-semibold text-xs">{t.label}</div>
                  <div className="text-[10px] text-slate-600 dark:text-slate-300 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Space Assignment */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              归属空间：
            </label>
            <select
              value={spaceId || ''}
              onChange={(e) => setSpaceId(e.target.value ? e.target.value : null)}
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-2 text-xs text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="">独立文档 (不归属于企业空间)</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.icon} {w.name}
                </option>
              ))}
            </select>
          </div>

          <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-100 dark:border-slate-800">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !title.trim()}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg transition-colors shadow-xs"
            >
              {isSubmitting && (
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              <span>立即创建</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
