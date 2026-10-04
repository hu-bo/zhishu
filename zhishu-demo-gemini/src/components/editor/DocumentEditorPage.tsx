/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Save,
  Users,
  Share2,
  Download,
  History,
  Info,
  AlignLeft,
  Sparkles,
  BookOpen,
  MessageSquare,
  Search,
  Wifi,
  WifiOff,
  CheckCircle2,
  AlertCircle,
  Eye,
  Edit3,
  FileDown,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import { DocumentData, DocumentBlock, BlockType, DocumentMetadata, CurrentUser } from '../../types/document';
import { storageService } from '../../services/storage';
import { EditorToolbar } from './EditorToolbar';
import { EditorSurface } from './EditorSurface';
import { EditorShell } from './EditorShell';
import { FindReplaceBar } from './FindReplaceBar';
import { OutlinePanel } from '../panels/OutlinePanel';
import { DocumentInfoPanel } from '../panels/DocumentInfoPanel';
import { VersionPanel } from '../panels/VersionPanel';
import { CommentsPanel } from '../panels/CommentsPanel';
import { KnowledgeQaPanel } from '../panels/KnowledgeQaPanel';
import { AiAuthoringPanel } from '../panels/AiAuthoringPanel';
import { ShareAclDialog } from '../dialogs/ShareAclDialog';
import { ExportImportModal } from '../dialogs/ExportImportModal';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';

interface DocumentEditorPageProps {
  documentId: string;
  onBackToWorkbench: () => void;
  currentUser: CurrentUser;
}

export const DocumentEditorPage: React.FC<DocumentEditorPageProps> = ({
  documentId,
  onBackToWorkbench,
  currentUser,
}) => {
  const [docData, setDocData] = useState<DocumentData | null>(() =>
    storageService.getDocumentById(documentId)
  );
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [baseSnapshotRevision, setBaseSnapshotRevision] = useState(1);
  const [saveConflictError, setSaveConflictError] = useState<string | null>(null);

  // Edit Mode vs. Reading Mode (Local preference, does not change server permissions)
  const [isReadingMode, setIsReadingMode] = useState(false);

  // Realtime Collab simulation states
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connected');
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'pending'>('synced');

  // Active side panel: 'outline' | 'info' | 'versions' | 'comments' | 'knowledge' | 'ai' | null
  const [activePanel, setActivePanel] = useState<string | null>('outline');

  // Modals
  const [isShareAclOpen, setIsShareAclOpen] = useState(false);
  const [isExportImportOpen, setIsExportImportOpen] = useState(false);
  const [isConfirmLeaveOpen, setIsConfirmLeaveOpen] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);

  // Find & Replace
  const [searchQuery, setSearchQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  // Undo / Redo history stack
  const [historyStack, setHistoryStack] = useState<DocumentBlock[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Initial load
  useEffect(() => {
    const loaded = storageService.getDocumentById(documentId);
    if (loaded) {
      setDocData(loaded);
      setBlocks(loaded.blocks);
      setBaseSnapshotRevision(loaded.metadata.snapshotRevision);
      setHistoryStack([loaded.blocks]);
      setHistoryIndex(0);
      setHasUnsavedChanges(false);
    }
  }, [documentId]);

  // Native beforeunload warning for unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '您有未保存的文档修改，刷新或离开可能丢失草稿。';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Keyboard shortcut Ctrl/Cmd + F for Find & Replace, Ctrl+S for Save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsFindOpen((prev) => !prev);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSaveDocument();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [blocks, hasUnsavedChanges, baseSnapshotRevision]);

  if (!docData) {
    return (
      <div className="p-12 text-center text-slate-500">
        文档未找到或无权访问，
        <button onClick={onBackToWorkbench} className="text-indigo-600 underline ml-1">
          返回工作台
        </button>
      </div>
    );
  }

  const isReadOnly =
    isReadingMode ||
    !docData.metadata.canEdit ||
    docData.metadata.isArchived ||
    docData.metadata.deletedAt !== null;

  // Block update dispatcher with history tracking
  const pushBlockState = (newBlocks: DocumentBlock[]) => {
    setBlocks(newBlocks);
    setHasUnsavedChanges(true);

    const newStack = historyStack.slice(0, historyIndex + 1);
    newStack.push(newBlocks);
    setHistoryStack(newStack);
    setHistoryIndex(newStack.length - 1);

    // If in collaborative mode, simulate instant optimistic durable ack update
    if (docData.metadata.mode === 'collaborative' && connectionStatus === 'connected') {
      setSyncStatus('pending');
      setTimeout(() => {
        const result = storageService.saveDocument(documentId, {
          blocks: newBlocks,
          isCollabAck: true,
        });
        setDocData(result.doc);
        setSyncStatus('synced');
        setHasUnsavedChanges(false);
      }, 350);
    }
  };

  const handleUpdateBlock = (id: string, updates: Partial<DocumentBlock>) => {
    const updated = blocks.map((b) => (b.id === id ? { ...b, ...updates } : b));
    pushBlockState(updated);
  };

  const handleDeleteBlock = (id: string) => {
    if (blocks.length <= 1) return;
    const updated = blocks.filter((b) => b.id !== id);
    pushBlockState(updated);
  };

  const handleInsertBlockAfter = (afterId: string, type: BlockType, extra?: any) => {
    const index = blocks.findIndex((b) => b.id === afterId);
    const newBlock: DocumentBlock = {
      id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      text: '',
      ...extra,
    };
    const updated = [...blocks];
    updated.splice(index + 1, 0, newBlock);
    pushBlockState(updated);
  };

  const handleToolbarInsert = (type: BlockType, extra?: any) => {
    const newBlock: DocumentBlock = {
      id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      text: '',
      ...extra,
    };
    pushBlockState([...blocks, newBlock]);
  };

  // Undo / Redo
  const handleUndo = () => {
    if (historyIndex > 0) {
      const prev = historyStack[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setBlocks(prev);
      setHasUnsavedChanges(true);
    }
  };

  const handleRedo = () => {
    if (historyIndex < historyStack.length - 1) {
      const next = historyStack[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setBlocks(next);
      setHasUnsavedChanges(true);
    }
  };

  // Explicit Save (for Snapshot Mode)
  const handleSaveDocument = () => {
    setSaveConflictError(null);
    setSyncStatus('syncing');

    try {
      const result = storageService.saveDocument(documentId, {
        blocks,
        baseSnapshotRevision,
      });

      if (result.conflict) {
        setSaveConflictError(result.message || '保存冲突：服务端已存在更高版本。');
        setSyncStatus('synced');
        return;
      }

      setDocData(result.doc);
      setBaseSnapshotRevision(result.doc.metadata.snapshotRevision);
      setHasUnsavedChanges(false);
      setSyncStatus('synced');
    } catch (err: any) {
      setSyncStatus('synced');
      alert('保存失败：' + err.message);
    }
  };

  // Metadata Updates (Emoji, tags, title)
  const handleUpdateMetadata = (updates: Partial<DocumentMetadata>) => {
    const result = storageService.updateMetadata(documentId, updates);
    if (result.conflict) {
      alert('元数据已被其他协作者修改，请刷新重试。');
      return;
    }
    setDocData((prev) => (prev ? { ...prev, metadata: result.metadata } : null));
  };

  // Download draft JSON helper
  const handleDownloadDraft = () => {
    const draftJson = JSON.stringify(
      {
        format: 'zhishu.document',
        version: '1.0.0',
        isDraft: true,
        exportedAt: new Date().toISOString(),
        metadata: docData.metadata,
        blocks,
      },
      null,
      2
    );
    const blob = new Blob([draftJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `[草稿备份]_${docData.metadata.title}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Leave navigation check
  const handleRequestBack = () => {
    if (hasUnsavedChanges) {
      setIsConfirmLeaveOpen(true);
    } else {
      onBackToWorkbench();
    }
  };

  // Find & Replace match count
  const matchCount = searchQuery.trim()
    ? blocks.filter((b) => (b.text || b.codeContent || '').toLowerCase().includes(searchQuery.toLowerCase())).length
    : 0;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* Top Document Header */}
      <header className="sticky top-0 z-30 h-14 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 px-4 flex items-center justify-between gap-3">
        {/* Left: Back + Title + Emoji + Mode Badge */}
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            onClick={handleRequestBack}
            className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="返回独立工作台"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <span className="text-xl select-none">{docData.metadata.emoji || '📄'}</span>

          <div className="flex flex-col min-w-0">
            <input
              type="text"
              value={docData.metadata.title}
              disabled={isReadOnly}
              onChange={(e) => handleUpdateMetadata({ title: e.target.value })}
              className="font-semibold text-sm text-slate-900 dark:text-white bg-transparent outline-none truncate hover:bg-slate-100/60 dark:hover:bg-slate-800/40 rounded px-1 -ml-1 transition-colors"
            />
            {/* Zero-pill status bar */}
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 -mt-0.5 px-1 truncate">
              <span>{docData.metadata.spaceName || '独立文档'}</span>
              <span>·</span>
              {docData.metadata.mode === 'collaborative' ? (
                <span className="text-indigo-600 dark:text-indigo-400 font-medium">
                  协同 seq:{docData.metadata.durableSeq} ({docData.metadata.generation})
                </span>
              ) : (
                <span className="text-slate-600 dark:text-slate-300 font-medium">
                  快照 rev:{docData.metadata.snapshotRevision}
                </span>
              )}
              {hasUnsavedChanges && (
                <>
                  <span>·</span>
                  <span className="text-amber-600 dark:text-amber-400 font-medium">有未提交修改</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Center: Save Status & Sync Indicator */}
        <div className="hidden lg:flex items-center gap-3 text-xs">
          {docData.metadata.mode === 'collaborative' ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-900 rounded-md text-indigo-700 dark:text-indigo-300">
              <span className={`w-2 h-2 rounded-full ${syncStatus === 'synced' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
              <span>{syncStatus === 'synced' ? 'durable ack 已确认持久化' : '正在提交更新序列...'}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <button
                disabled={!hasUnsavedChanges || isReadOnly}
                onClick={handleSaveDocument}
                className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-md text-xs font-medium shadow-xs transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                <span>保存快照 (rev {baseSnapshotRevision})</span>
              </button>
            </div>
          )}
        </div>

        {/* Right Controls: Reading Mode Toggle, Share, Export, Side Panel Toggles */}
        <div className="flex items-center gap-1">
          {/* Find & Replace Trigger */}
          <button
            onClick={() => setIsFindOpen(!isFindOpen)}
            className={`p-1.5 rounded-md transition-colors ${
              isFindOpen
                ? 'bg-indigo-50 text-indigo-600'
                : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="文内查找 (Ctrl/Cmd + F)"
          >
            <Search className="w-4 h-4" />
          </button>

          {/* Reading / Edit Mode Toggle (按文档保存的本地界面偏好) */}
          <button
            onClick={() => setIsReadingMode(!isReadingMode)}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-colors ${
              isReadingMode
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="阅读模式隐藏编辑工具并保留大纲与查找"
          >
            {isReadingMode ? <Eye className="w-3.5 h-3.5" /> : <Edit3 className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{isReadingMode ? '阅读模式' : '编辑模式'}</span>
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />

          {/* Share / ACL */}
          <button
            onClick={() => setIsShareAclOpen(true)}
            className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="主体授权与访问控制 (ACL)"
          >
            <Share2 className="w-4 h-4" />
          </button>

          {/* Export / Import */}
          <button
            onClick={() => setIsExportImportOpen(true)}
            className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title="导出与导入 (JSON/HTML/MD/打印)"
          >
            <Download className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-800 mx-1" />

          {/* Side Panel Switchers: Outline, Details, Versions, Comments, Knowledge, AI */}
          <button
            onClick={() => setActivePanel(activePanel === 'outline' ? null : 'outline')}
            className={`p-1.5 rounded-md transition-colors ${
              activePanel === 'outline'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="正文大纲 (Outline)"
          >
            <AlignLeft className="w-4 h-4" />
          </button>

          <button
            onClick={() => setActivePanel(activePanel === 'versions' ? null : 'versions')}
            className={`p-1.5 rounded-md transition-colors ${
              activePanel === 'versions'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="历史版本对比与恢复 (Versions)"
          >
            <History className="w-4 h-4" />
          </button>

          <button
            onClick={() => setActivePanel(activePanel === 'comments' ? null : 'comments')}
            className={`p-1.5 rounded-md transition-colors ${
              activePanel === 'comments'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="批注讨论 (Comments)"
          >
            <MessageSquare className="w-4 h-4" />
          </button>

          <button
            onClick={() => setActivePanel(activePanel === 'knowledge' ? null : 'knowledge')}
            className={`p-1.5 rounded-md transition-colors ${
              activePanel === 'knowledge'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="知识库问答与证据核对 (WEB-08)"
          >
            <BookOpen className="w-4 h-4" />
          </button>

          <button
            onClick={() => setActivePanel(activePanel === 'ai' ? null : 'ai')}
            className={`p-1.5 rounded-md transition-colors ${
              activePanel === 'ai'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="AI 创作助手 (WEB-09)"
          >
            <Sparkles className="w-4 h-4 text-amber-500" />
          </button>

          <button
            onClick={() => setActivePanel(activePanel === 'info' ? null : 'info')}
            className={`p-1.5 rounded-md transition-colors ${
              activePanel === 'info'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="文档元信息与标签 (Info)"
          >
            <Info className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Save Conflict Warning Banner */}
      {saveConflictError && (
        <div className="bg-rose-50 dark:bg-rose-950/60 border-b border-rose-200 dark:border-rose-900 px-6 py-2.5 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{saveConflictError}</span>
          </div>
          <button
            onClick={handleDownloadDraft}
            className="flex items-center gap-1 text-xs font-semibold underline hover:text-rose-900"
          >
            <FileDown className="w-3.5 h-3.5" />
            下载本地草稿 JSON 备份
          </button>
        </div>
      )}

      {/* Editor Main Work Area with Sidebars */}
      <div className="flex-1 flex relative">
        {/* Main Editor Center Canvas */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {/* Find & Replace Bar */}
          <FindReplaceBar
            isOpen={isFindOpen}
            onClose={() => {
              setIsFindOpen(false);
              setSearchQuery('');
            }}
            onSearchChange={(q) => setSearchQuery(q)}
            onNavigateMatch={(dir) => {
              if (matchCount > 0) {
                setCurrentMatchIndex((prev) =>
                  dir === 'next' ? (prev + 1) % matchCount : (prev - 1 + matchCount) % matchCount
                );
              }
            }}
            currentMatchIndex={currentMatchIndex}
            totalMatches={matchCount}
          />

          {/* Editor Toolbar (Hidden in Reading Mode or Read-only) */}
          {!isReadOnly && !isReadingMode && (
            <EditorToolbar
              onInsertBlock={handleToolbarInsert}
              onUndo={handleUndo}
              onRedo={handleRedo}
              canUndo={historyIndex > 0}
              canRedo={historyIndex < historyStack.length - 1}
            />
          )}

          {/* Editor Shell with 896px content & stats */}
          <EditorShell
            blocks={blocks}
            mode={docData.metadata.mode}
            durableSeq={docData.metadata.durableSeq}
            snapshotRevision={docData.metadata.snapshotRevision}
            generation={docData.metadata.generation}
            isReadOnly={isReadOnly}
          >
            <EditorSurface
              blocks={blocks}
              isReadOnly={isReadOnly}
              searchQuery={searchQuery}
              currentMatchIndex={currentMatchIndex}
              onUpdateBlock={handleUpdateBlock}
              onDeleteBlock={handleDeleteBlock}
              onInsertBlockAfter={handleInsertBlockAfter}
              onAddCommentOnBlock={(blockId, quote) => {
                setActivePanel('comments');
              }}
            />
          </EditorShell>
        </div>

        {/* Right Docked Panels */}
        {activePanel === 'outline' && (
          <OutlinePanel
            blocks={blocks}
            isOpen={true}
            onClose={() => setActivePanel(null)}
          />
        )}

        {activePanel === 'info' && (
          <DocumentInfoPanel
            metadata={docData.metadata}
            isOpen={true}
            onClose={() => setActivePanel(null)}
            onUpdateMetadata={handleUpdateMetadata}
          />
        )}

        {activePanel === 'versions' && (
          <VersionPanel
            document={{ metadata: docData.metadata, blocks }}
            isOpen={true}
            onClose={() => setActivePanel(null)}
            onRestoreSuccess={(restoredDoc) => {
              setDocData(restoredDoc);
              setBlocks(restoredDoc.blocks);
              setBaseSnapshotRevision(restoredDoc.metadata.snapshotRevision);
              setHasUnsavedChanges(false);
            }}
            onDownloadDraft={handleDownloadDraft}
          />
        )}

        {activePanel === 'comments' && (
          <CommentsPanel
            documentId={documentId}
            isOpen={true}
            onClose={() => setActivePanel(null)}
            currentUser={currentUser}
          />
        )}

        {activePanel === 'knowledge' && (
          <KnowledgeQaPanel
            isOpen={true}
            onClose={() => setActivePanel(null)}
            onInsertToDocument={(text) => {
              handleToolbarInsert('paragraph', { text });
            }}
          />
        )}

        {activePanel === 'ai' && (
          <AiAuthoringPanel
            isOpen={true}
            onClose={() => setActivePanel(null)}
            selectedBlockText={blocks.find((b) => b.type === 'paragraph')?.text || ''}
            onApplyProposal={(proposalText) => {
              handleToolbarInsert('paragraph', { text: proposalText });
            }}
          />
        )}
      </div>

      {/* Share / ACL Dialog */}
      <ShareAclDialog
        isOpen={isShareAclOpen}
        onClose={() => setIsShareAclOpen(false)}
        documentId={documentId}
        documentTitle={docData.metadata.title}
        canManage={docData.metadata.canManage}
      />

      {/* Export / Import Modal */}
      <ExportImportModal
        isOpen={isExportImportOpen}
        onClose={() => setIsExportImportOpen(false)}
        document={{ metadata: docData.metadata, blocks }}
        onImportDocument={(imported) => {
          if (imported.blocks) {
            pushBlockState(imported.blocks);
          }
        }}
      />

      {/* Unsaved Leave Confirm Dialog */}
      <ConfirmDialog
        isOpen={isConfirmLeaveOpen}
        title="有未确认的修改，确认离开？"
        message="当前正文修改尚未持久化保存到服务端。您可以选择继续编辑、放弃修改，或先下载标准 JSON 草稿备份后离开。"
        confirmLabel="放弃修改并离开"
        cancelLabel="继续留在页面编辑"
        variant="warning"
        extraAction={{
          label: '先下载 JSON 草稿后离开',
          onClick: () => {
            handleDownloadDraft();
            onBackToWorkbench();
          },
          icon: <FileDown className="w-3.5 h-3.5" />,
        }}
        onConfirm={() => {
          setIsConfirmLeaveOpen(false);
          onBackToWorkbench();
        }}
        onCancel={() => setIsConfirmLeaveOpen(false)}
      />
    </div>
  );
};
