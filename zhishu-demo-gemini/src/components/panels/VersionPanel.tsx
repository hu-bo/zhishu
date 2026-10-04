/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  History,
  X,
  RotateCcw,
  Eye,
  GitCompare,
  Plus,
  Bookmark,
  Clock,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  FileDown,
} from 'lucide-react';
import { VersionRecord, DocumentData, DocumentBlock } from '../../types/document';
import { storageService } from '../../services/storage';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { EditorCodeBlockView } from '../editor/EditorCodeBlockView';

interface VersionPanelProps {
  document: DocumentData;
  isOpen: boolean;
  onClose?: () => void;
  isDrawer?: boolean;
  onRestoreSuccess: (updatedDoc: DocumentData) => void;
  onDownloadDraft: () => void;
}

export const VersionPanel: React.FC<VersionPanelProps> = ({
  document,
  isOpen,
  onClose,
  isDrawer = false,
  onRestoreSuccess,
  onDownloadDraft,
}) => {
  const [versions, setVersions] = useState<VersionRecord[]>(() =>
    storageService.getVersions(document.metadata.id)
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    versions.length > 0 ? versions[0].id : null
  );
  const [viewMode, setViewMode] = useState<'diff' | 'preview'>('diff');

  // New named version form state
  const [isCreatingNamed, setIsCreatingNamed] = useState(false);
  const [namedTitle, setNamedTitle] = useState('');
  const [namedSummary, setNamedSummary] = useState('');

  // Confirm Restore Dialog
  const [isConfirmRestoreOpen, setIsConfirmRestoreOpen] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  if (!isOpen) return null;

  const selectedVersion = versions.find((v) => v.id === selectedVersionId) || versions[0];

  // Refresh version list
  const refreshVersions = () => {
    const list = storageService.getVersions(document.metadata.id);
    setVersions(list);
  };

  const handleCreateNamedVersion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!namedTitle.trim()) return;

    storageService.createVersionRecord({
      documentId: document.metadata.id,
      versionType: 'named',
      name: namedTitle.trim(),
      blocks: document.blocks,
      changeSummary: namedSummary.trim() || '创建手动命名发布快照',
      snapshotRevision: document.metadata.snapshotRevision,
      durableSeq: document.metadata.durableSeq,
      generation: document.metadata.generation,
    });

    setNamedTitle('');
    setNamedSummary('');
    setIsCreatingNamed(false);
    refreshVersions();
  };

  const handleConfirmRestore = () => {
    if (!selectedVersion) return;
    setIsRestoring(true);

    try {
      const restored = storageService.restoreVersion(
        document.metadata.id,
        selectedVersion.id
      );
      setIsRestoring(false);
      setIsConfirmRestoreOpen(false);
      onRestoreSuccess(restored);
      refreshVersions();
    } catch (err) {
      setIsRestoring(false);
      alert('恢复失败：' + err);
    }
  };

  // Block-by-block visual difference
  const renderBlockDiff = () => {
    if (!selectedVersion) return null;

    const historicalBlocks = selectedVersion.blocks || [];
    const currentBlocks = document.blocks || [];

    return (
      <div className="space-y-3 text-xs">
        <div className="p-2.5 bg-slate-100 dark:bg-slate-800/80 rounded-lg text-slate-600 dark:text-slate-300 text-[11px] leading-relaxed">
          比对历史版本 <strong className="text-slate-900 dark:text-white">[{selectedVersion.name}]</strong> 与当前文档正文差异：
        </div>

        <div className="space-y-2">
          {historicalBlocks.map((histBlock, idx) => {
            const currentBlock = currentBlocks[idx];
            const isTextDiff =
              currentBlock &&
              ((histBlock.text && histBlock.text !== currentBlock.text) ||
                (histBlock.codeContent && histBlock.codeContent !== currentBlock.codeContent));

            if (!currentBlock) {
              return (
                <div key={idx} className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60">
                  <div className="text-[10px] text-rose-600 dark:text-rose-400 font-semibold mb-1">
                    [-] 历史块在当前版本中已删除：
                  </div>
                  <div className="line-through text-slate-500">{histBlock.text || histBlock.codeContent || `[${histBlock.type} 块]`}</div>
                </div>
              );
            }

            if (isTextDiff) {
              return (
                <div key={idx} className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 space-y-1.5">
                  <div className="text-[10px] text-amber-700 dark:text-amber-400 font-semibold">
                    [~] 历史与当前正文差异对比：
                  </div>
                  <div className="bg-rose-100/70 dark:bg-rose-950/50 p-1.5 rounded text-rose-800 dark:text-rose-300">
                    <span className="font-mono text-[10px] text-rose-500 mr-1.5">历史:</span>
                    {histBlock.text || histBlock.codeContent}
                  </div>
                  <div className="bg-emerald-100/70 dark:bg-emerald-950/50 p-1.5 rounded text-emerald-800 dark:text-emerald-300">
                    <span className="font-mono text-[10px] text-emerald-500 mr-1.5">当前:</span>
                    {currentBlock.text || currentBlock.codeContent}
                  </div>
                </div>
              );
            }

            return (
              <div key={idx} className="p-2 rounded bg-slate-50 dark:bg-slate-800/40 text-slate-500 text-[11px] truncate">
                <span className="text-slate-400 mr-1.5">相同:</span>
                {histBlock.text || histBlock.codeContent || `[${histBlock.type} 块]`}
              </div>
            );
          })}

          {currentBlocks.length > historicalBlocks.length && (
            <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/60">
              <div className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold mb-1">
                [+] 当前版本新增了 {currentBlocks.length - historicalBlocks.length} 个新块
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div
        className={`${
          isDrawer
            ? 'fixed inset-y-0 right-0 z-40 w-96 bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800'
            : 'w-96 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shrink-0 sticky top-14 h-[calc(100vh-56px)] overflow-y-auto no-print'
        } flex flex-col`}
      >
        {/* Header */}
        <div className="h-12 flex items-center justify-between px-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              版本控制与差异回溯 (Versions)
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

        {/* Action button: Create Named Version */}
        <div className="p-3 border-b border-slate-100 dark:border-slate-800">
          {isCreatingNamed ? (
            <form onSubmit={handleCreateNamedVersion} className="space-y-2 bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-lg border border-slate-200 dark:border-slate-700">
              <div className="text-[11px] font-semibold text-slate-800 dark:text-slate-200">
                创建命名版本 (如发布定稿、评审快照)
              </div>
              <input
                type="text"
                required
                placeholder="版本名称 (如 v1.2 正式版)"
                value={namedTitle}
                onChange={(e) => setNamedTitle(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2.5 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <input
                type="text"
                placeholder="变更说明摘要..."
                value={namedSummary}
                onChange={(e) => setNamedSummary(e.target.value)}
                className="w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded px-2.5 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <div className="flex justify-end gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setIsCreatingNamed(false)}
                  className="px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-200 rounded"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 text-[11px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded"
                >
                  保存快照
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setIsCreatingNamed(true)}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 bg-indigo-50 dark:bg-indigo-950/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-indigo-700 dark:text-indigo-300 text-xs font-medium rounded-lg transition-colors border border-indigo-200 dark:border-indigo-800/60"
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>保存当前为命名版本</span>
            </button>
          )}
        </div>

        {/* Version List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 p-2 space-y-1">
          {versions.map((ver) => {
            const isSelected = ver.id === selectedVersion?.id;
            return (
              <div
                key={ver.id}
                onClick={() => setSelectedVersionId(ver.id)}
                className={`p-3 rounded-lg cursor-pointer transition-all ${
                  isSelected
                    ? 'bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800/80 shadow-xs'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/40 text-slate-600 dark:text-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5">
                    {ver.versionType === 'named' ? (
                      <Bookmark className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                    ) : (
                      <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                    <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                      {ver.name}
                    </span>
                  </div>

                  <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300 shrink-0">
                    {ver.durableSeq !== undefined ? `seq:${ver.durableSeq}` : `rev:${ver.snapshotRevision}`}
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">
                  {ver.changeSummary}
                </p>

                <div className="flex items-center justify-between text-[10px] text-slate-600 dark:text-slate-300 mt-2 pt-1 border-t border-slate-100/60 dark:border-slate-800/60">
                  <span className="truncate">{ver.author.name}</span>
                  <span>{new Date(ver.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected Version Preview / Diff & Restore Action Footer */}
        {selectedVersion && (
          <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 bg-slate-200 dark:bg-slate-800 p-0.5 rounded-md text-[11px]">
                <button
                  onClick={() => setViewMode('diff')}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    viewMode === 'diff'
                      ? 'bg-white dark:bg-slate-900 font-medium text-slate-800 dark:text-white shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  <GitCompare className="w-3 h-3 inline mr-1" />
                  差异比对
                </button>
                <button
                  onClick={() => setViewMode('preview')}
                  className={`px-2 py-0.5 rounded transition-colors ${
                    viewMode === 'preview'
                      ? 'bg-white dark:bg-slate-900 font-medium text-slate-800 dark:text-white shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  <Eye className="w-3 h-3 inline mr-1" />
                  只读预览
                </button>
              </div>

              {/* Restore Button */}
              <button
                type="button"
                onClick={() => setIsConfirmRestoreOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg shadow-xs transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>恢复此版本</span>
              </button>
            </div>

            {/* Bounded Scroll Panel for Diff / Preview */}
            <div className="max-h-56 overflow-y-auto p-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
              {viewMode === 'diff' ? (
                renderBlockDiff()
              ) : (
                <div className="space-y-2 text-xs">
                  {selectedVersion.blocks.map((b) => (
                    <div key={b.id} className="p-1 border-b border-slate-100 dark:border-slate-800 last:border-b-0">
                      {b.type === 'heading' && <div className="font-bold">{b.text}</div>}
                      {b.type === 'paragraph' && <div>{b.text}</div>}
                      {b.type === 'code' && (
                        <EditorCodeBlockView
                          code={b.codeContent || ''}
                          language={b.codeLanguage || 'typescript'}
                          isReadOnly={true}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Dialog on Restore */}
      <ConfirmDialog
        isOpen={isConfirmRestoreOpen}
        title="确认恢复至选定历史版本？"
        message={
          document.metadata.mode === 'collaborative'
            ? `您即将把正文恢复至 [${selectedVersion?.name}]。\n• 协同文档将 Fork 演进至新代次 (当前: ${document.metadata.generation}) 并向所有协作者广播。\n• 如有尚未持久化的本地草稿，建议先点击下方下载草稿备份。`
            : `您即将把正文恢复至 [${selectedVersion?.name}]。\n• 快照文档将递增 snapshotRevision (当前: rev ${document.metadata.snapshotRevision}) 并形成新的保存节点。\n• 如有尚未提交的修改，建议先点击下方下载草稿备份。`
        }
        confirmLabel="确认恢复正文"
        variant="warning"
        isProcessing={isRestoring}
        extraAction={{
          label: '先下载当前草稿备份',
          onClick: onDownloadDraft,
          icon: <FileDown className="w-3.5 h-3.5" />,
        }}
        onConfirm={handleConfirmRestore}
        onCancel={() => setIsConfirmRestoreOpen(false)}
      />
    </>
  );
};
