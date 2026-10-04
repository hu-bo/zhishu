/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  FolderKanban,
  Folder,
  FolderOpen,
  X,
  ChevronRight,
  ChevronDown,
  Check,
  MoveRight,
} from 'lucide-react';
import { Workspace, WorkspaceFolder, DocumentMetadata } from '../../types/document';
import { storageService } from '../../services/storage';

interface MoveDocumentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  document: DocumentMetadata;
  workspaces: Workspace[];
  onMoved: (targetSpaceName?: string, targetFolderName?: string) => void;
}

export const MoveDocumentDialog: React.FC<MoveDocumentDialogProps> = ({
  isOpen,
  onClose,
  document,
  workspaces,
  onMoved,
}) => {
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(document.spaceId);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(document.folderId || null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const currentSpace = workspaces.find((w) => w.id === selectedSpaceId);

  const handleConfirmMove = () => {
    setIsSubmitting(true);
    try {
      storageService.moveDocument(document.id, selectedSpaceId, selectedFolderId);
      const targetSpace = workspaces.find((w) => w.id === selectedSpaceId);
      const targetFolder = targetSpace?.folders.find((f) => f.id === selectedFolderId);
      onMoved(targetSpace?.name, targetFolder?.name);
      onClose();
    } catch (err: any) {
      alert(err.message || '移动失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              移动文档到空间或目录
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            当前移动对象：<strong className="text-slate-800 dark:text-slate-200">{document.emoji || '📄'} {document.title}</strong>
          </div>

          {/* Step 1: Select Space */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              1. 选择目标企业空间：
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedSpaceId(null);
                  setSelectedFolderId(null);
                }}
                className={`p-2.5 rounded-lg border text-left text-xs transition-all ${
                  selectedSpaceId === null
                    ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-300 font-medium shadow-xs'
                    : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-700 dark:text-slate-300'
                }`}
              >
                <div className="font-semibold">独立文档</div>
                <div className="text-[10px] text-slate-600 dark:text-slate-300 mt-0.5">无归属空间</div>
              </button>

              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => {
                    setSelectedSpaceId(w.id);
                    setSelectedFolderId(null);
                  }}
                  className={`p-2.5 rounded-lg border text-left text-xs transition-all ${
                    selectedSpaceId === w.id
                      ? 'border-indigo-600 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-300 font-medium shadow-xs'
                      : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-1 font-semibold truncate">
                    <span>{w.icon}</span>
                    <span className="truncate">{w.name}</span>
                  </div>
                  <div className="text-[10px] text-slate-600 dark:text-slate-300 mt-0.5 truncate">
                    {w.folders.length} 个目录
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Step 2: Directory Tree within chosen space */}
          {currentSpace && (
            <div className="space-y-1.5 pt-2">
              <div className="flex items-center justify-between text-xs font-medium text-slate-700 dark:text-slate-300">
                <span>2. 选择该空间下的目录层级 (Directory Tree)：</span>
                <span className="text-[11px] text-slate-400">点击目录节点即可指定</span>
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 bg-slate-50 dark:bg-slate-900/60 max-h-48 overflow-y-auto space-y-1">
                {/* Root level option */}
                <button
                  type="button"
                  onClick={() => setSelectedFolderId(null)}
                  className={`w-full flex items-center justify-between p-2 rounded-md text-xs text-left transition-colors ${
                    selectedFolderId === null
                      ? 'bg-indigo-100/70 dark:bg-indigo-950/60 text-indigo-900 dark:text-indigo-300 font-medium'
                      : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-indigo-500" />
                    <span>[空间根目录] (不放入子文件夹)</span>
                  </div>
                  {selectedFolderId === null && <Check className="w-3.5 h-3.5 text-indigo-600" />}
                </button>

                {/* Sub-folders in space */}
                {currentSpace.folders.map((folder) => {
                  const isSelected = selectedFolderId === folder.id;
                  return (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => setSelectedFolderId(folder.id)}
                      className={`w-full flex items-center justify-between p-2 pl-6 rounded-md text-xs text-left transition-colors ${
                        isSelected
                          ? 'bg-indigo-100/70 dark:bg-indigo-950/60 text-indigo-900 dark:text-indigo-300 font-medium'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                        <span className="truncate">{folder.name}</span>
                      </div>
                      {isSelected && <Check className="w-3.5 h-3.5 text-indigo-600 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="text-[11px] text-slate-500 truncate max-w-[60%]">
            移动至: <strong>{currentSpace ? currentSpace.name : '独立文档'}</strong>
            {selectedFolderId && (
              <span> / {currentSpace?.folders.find((f) => f.id === selectedFolderId)?.name}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg"
            >
              取消
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleConfirmMove}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium shadow-xs transition-colors"
            >
              <MoveRight className="w-3.5 h-3.5" />
              <span>确认移动</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
