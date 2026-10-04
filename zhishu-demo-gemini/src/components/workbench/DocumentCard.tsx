/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Star,
  Archive,
  Trash2,
  RotateCcw,
  Clock,
  MoveRight,
  Folder,
} from 'lucide-react';
import { DocumentMetadata } from '../../types/document';

interface DocumentCardProps {
  document: DocumentMetadata;
  isInTrash?: boolean;
  onOpen: (id: string) => void;
  onToggleStar: (id: string) => void;
  onToggleArchive: (id: string) => void;
  onMoveToTrash: (id: string) => void;
  onRestoreFromTrash: (id: string) => void;
  onRequestPermanentDelete: (id: string) => void;
  onMoveDocument?: (doc: DocumentMetadata) => void;
  isProcessing?: boolean;
}

export const DocumentCard: React.FC<DocumentCardProps> = ({
  document,
  isInTrash = false,
  onOpen,
  onToggleStar,
  onToggleArchive,
  onMoveToTrash,
  onRestoreFromTrash,
  onRequestPermanentDelete,
  onMoveDocument,
  isProcessing = false,
}) => {
  return (
    <div
      onClick={() => !isInTrash && onOpen(document.id)}
      className={`group relative p-4 rounded-xl border transition-all duration-150 flex flex-col justify-between ${
        isInTrash
          ? 'bg-slate-50/60 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800'
          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-xs cursor-pointer'
      }`}
    >
      <div>
        {/* Top Header: Emoji + Title + Quick Actions */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="text-xl shrink-0 mt-0.5 select-none">{document.emoji || '📄'}</span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                {document.title}
              </h3>

              {/* Zero-Pill Unboxed Metadata with · separator */}
              <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                <span>{document.spaceName || '独立文档'}</span>
                {document.folderName && (
                  <>
                    <span aria-hidden="true">/</span>
                    <span className="text-slate-600 dark:text-slate-300 font-medium truncate">
                      {document.folderName}
                    </span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className={document.mode === 'collaborative' ? 'text-indigo-600 dark:text-indigo-400 font-medium' : ''}>
                  {document.mode === 'collaborative'
                    ? `协同 seq:${document.durableSeq}`
                    : `快照 rev:${document.snapshotRevision}`}
                </span>
              </div>
            </div>
          </div>

          {/* Quick Action Buttons */}
          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {!isInTrash ? (
              <>
                {onMoveDocument && (
                  <button
                    type="button"
                    onClick={() => onMoveDocument(document)}
                    className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                    title="移动文档目录与空间"
                  >
                    <MoveRight className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => onToggleStar(document.id)}
                  className={`p-1.5 rounded-md transition-colors ${
                    document.isStarred
                      ? 'text-amber-500 hover:text-amber-600'
                      : 'text-slate-300 dark:text-slate-600 hover:text-slate-500 opacity-0 group-hover:opacity-100'
                  }`}
                  title={document.isStarred ? '取消收藏' : '加入收藏'}
                >
                  <Star className={`w-4 h-4 ${document.isStarred ? 'fill-amber-400' : ''}`} />
                </button>

                <button
                  type="button"
                  onClick={() => onToggleArchive(document.id)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                  title={document.isArchived ? '取消归档' : '移入归档'}
                >
                  <Archive className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => onMoveToTrash(document.id)}
                  className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                  title="移入回收站"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            ) : null}
          </div>
        </div>

        {/* Document brief snippet / summary */}
        <p className="text-xs text-slate-600 dark:text-slate-400 mt-2.5 line-clamp-2 leading-relaxed">
          {document.summary || '暂无正文摘要'}
        </p>
      </div>

      {/* Footer Info & Trash Controls */}
      <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300">
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          <span>
            {isInTrash && document.deletedAt
              ? `移入时间: ${new Date(document.deletedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
              : `更新于 ${new Date(document.updatedAt).toLocaleDateString('zh-CN')}`}
          </span>
        </div>

        {/* Trash Actions: Restore & Permanent Delete with canManage verification */}
        {isInTrash ? (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              disabled={isProcessing}
              onClick={() => onRestoreFromTrash(document.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/50 rounded-md transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>恢复文档</span>
            </button>

            <button
              type="button"
              disabled={isProcessing || !document.canManage}
              onClick={() => onRequestPermanentDelete(document.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-md transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
              title={document.canManage ? '彻底永久删除文档' : '仅文档所有者 (canManage: true) 可执行永久删除'}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>永久删除</span>
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {document.canManage ? (
              <span className="text-[10px] text-slate-600 dark:text-slate-300">所有者</span>
            ) : (
              <span className="text-[10px] text-slate-600 dark:text-slate-300">协作成员</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
