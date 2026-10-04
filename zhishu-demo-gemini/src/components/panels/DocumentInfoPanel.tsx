/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Info,
  X,
  Tag,
  Smile,
  Shield,
  Calendar,
  User,
  Hash,
  Layers,
  Check,
  Plus,
} from 'lucide-react';
import { DocumentMetadata } from '../../types/document';

interface DocumentInfoPanelProps {
  metadata: DocumentMetadata;
  isOpen: boolean;
  onClose?: () => void;
  isDrawer?: boolean;
  onUpdateMetadata: (updates: Partial<DocumentMetadata>) => void;
}

const EMOJI_OPTIONS = ['📄', '📘', '⚙️', '🛡️', '📱', '💡', '🚀', '📝', '🎯', '📦', '💻', '🧭'];

export const DocumentInfoPanel: React.FC<DocumentInfoPanelProps> = ({
  metadata,
  isOpen,
  onClose,
  isDrawer = false,
  onUpdateMetadata,
}) => {
  const [newTagInput, setNewTagInput] = useState('');
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);

  if (!isOpen) return null;

  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagInput.trim()) return;
    if (metadata.tags.length >= 12) {
      alert('最多允许添加 12 个标签');
      return;
    }
    const cleanTag = newTagInput.trim();
    if (!metadata.tags.includes(cleanTag)) {
      onUpdateMetadata({ tags: [...metadata.tags, cleanTag] });
    }
    setNewTagInput('');
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onUpdateMetadata({
      tags: metadata.tags.filter((t) => t !== tagToRemove),
    });
  };

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
          <Info className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            文档详情与元数据 (Metadata)
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

      <div className="p-4 space-y-4 flex-1 overflow-y-auto text-xs">
        {/* Emoji & Title Icon */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-slate-500">文档 Emoji 图标：</label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsEmojiPickerOpen(!isEmojiPickerOpen)}
              className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            >
              <span className="text-xl">{metadata.emoji || '📄'}</span>
              <span className="text-xs text-slate-600 dark:text-slate-300">更改图标</span>
            </button>

            {isEmojiPickerOpen && (
              <div className="absolute top-11 left-0 z-30 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg rounded-lg p-2 grid grid-cols-4 gap-2">
                {EMOJI_OPTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onUpdateMetadata({ emoji });
                      setIsEmojiPickerOpen(false);
                    }}
                    className="p-1.5 text-lg hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-center"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tags Management (Up to 12 tags with zero-pill aesthetic) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px] font-medium text-slate-500">
            <span>彩色标签 (最多 12 个)：</span>
            <span>{metadata.tags.length}/12</span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {metadata.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 text-[11px] text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 rounded-sm border border-slate-200 dark:border-slate-700"
              >
                <span>{tag}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveTag(tag)}
                  className="hover:text-rose-600 dark:hover:text-rose-400 text-slate-400"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>

          <form onSubmit={handleAddTag} className="flex gap-1 pt-1">
            <input
              type="text"
              placeholder="新增标签 (回车确认)"
              value={newTagInput}
              onChange={(e) => setNewTagInput(e.target.value)}
              className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              className="px-2 py-1 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded border border-slate-200 dark:border-slate-700"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </form>
        </div>

        <div className="w-full h-px bg-slate-100 dark:bg-slate-800" />

        {/* Mode & Revision Specs */}
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-slate-500">运行模式与代次：</div>
          <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 space-y-1.5 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">内容模式：</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {metadata.mode === 'collaborative' ? '实时协同模式 (Yjs CRDT)' : '普通快照模式 (JSON Snapshot)'}
              </span>
            </div>
            {metadata.mode === 'collaborative' ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">代次标识 (Generation)：</span>
                  <span className="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">{metadata.generation}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">持久化序号 (durableSeq)：</span>
                  <span className="font-mono text-slate-700 dark:text-slate-300">{metadata.durableSeq}</span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-slate-500">快照修订号 (snapshotRevision)：</span>
                <span className="font-mono text-slate-700 dark:text-slate-300">rev {metadata.snapshotRevision}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-500">元数据修订 (metadataRevision)：</span>
              <span className="font-mono text-slate-700 dark:text-slate-300">v{metadata.metadataRevision}</span>
            </div>
          </div>
        </div>

        {/* Real Permissions Capabilities Breakdown */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-slate-500">当前真实权限能力：</div>
          <div className="p-2.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700 space-y-1 text-[11px]">
            <div className="flex items-center justify-between">
              <span>正文读写 (canEdit)：</span>
              <strong className={metadata.canEdit ? 'text-emerald-600' : 'text-slate-400'}>
                {metadata.canEdit ? '允许' : '受限只读'}
              </strong>
            </div>
            <div className="flex items-center justify-between">
              <span>ACL与管理 (canManage)：</span>
              <strong className={metadata.canManage ? 'text-emerald-600' : 'text-slate-400'}>
                {metadata.canManage ? '所有者专享' : '无权'}
              </strong>
            </div>
          </div>
        </div>

        {/* Timestamps */}
        <div className="space-y-1.5 pt-2 text-[11px] text-slate-500 dark:text-slate-400">
          <div>创建时间：{new Date(metadata.createdAt).toLocaleString('zh-CN')}</div>
          <div>更新时间：{new Date(metadata.updatedAt).toLocaleString('zh-CN')}</div>
          <div>所有者：{metadata.ownerName} ({metadata.ownerId})</div>
        </div>
      </div>
    </div>
  );
};
