/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  Search,
  Filter,
  ArrowUpDown,
  Plus,
  Trash2,
  FileText,
  Clock,
  Star,
  Archive,
  AlertTriangle,
  FolderPlus,
  Compass,
  AtSign,
} from 'lucide-react';
import {
  WorkbenchView,
  WorkbenchSortField,
  SortDirection,
  DocumentMetadata,
  Workspace,
  CurrentUser,
} from '../../types/document';
import { storageService } from '../../services/storage';
import { DocumentCard } from './DocumentCard';
import { CreateDocumentDialog } from './CreateDocumentDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { MoveDocumentDialog } from '../dialogs/MoveDocumentDialog';

interface WorkbenchPageProps {
  currentView: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  selectedSpaceId: string | null;
  onOpenDocument: (id: string) => void;
  workspaces: Workspace[];
  currentUser: CurrentUser;
  isCreateOpen: boolean;
  onCloseCreate: () => void;
  onOpenCreate: () => void;
}

export const WorkbenchPage: React.FC<WorkbenchPageProps> = ({
  currentView,
  onViewChange,
  selectedSpaceId,
  onOpenDocument,
  workspaces,
  currentUser,
  isCreateOpen,
  onCloseCreate,
  onOpenCreate,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<WorkbenchSortField>('updatedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [documents, setDocuments] = useState<DocumentMetadata[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [movingDoc, setMovingDoc] = useState<DocumentMetadata | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Sync state with URL search params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view') as WorkbenchView;
    if (v && ['relevant', 'recent', 'my', 'all', 'starred', 'archived', 'trash'].includes(v)) {
      onViewChange(v);
    }
    const q = params.get('search');
    if (q) setSearchQuery(q);
    const s = params.get('sort') as WorkbenchSortField;
    if (s && ['updatedAt', 'title', 'createdAt'].includes(s)) setSortField(s);
    const d = params.get('direction') as SortDirection;
    if (d && ['asc', 'desc'].includes(d)) setSortDirection(d);
  }, []);

  // Update URL params when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('view', currentView);
    if (searchQuery) params.set('search', searchQuery);
    params.set('sort', sortField);
    params.set('direction', sortDirection);
    if (selectedSpaceId) params.set('spaceId', selectedSpaceId);

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', newUrl);
  }, [currentView, searchQuery, sortField, sortDirection, selectedSpaceId]);

  // Load documents with current filters
  const reloadDocuments = () => {
    const docs = storageService.getDocuments({
      view: currentView,
      search: searchQuery,
      sort: sortField,
      direction: sortDirection,
      spaceId: selectedSpaceId || undefined,
    });
    setDocuments(docs);
  };

  useEffect(() => {
    reloadDocuments();
  }, [currentView, searchQuery, sortField, sortDirection, selectedSpaceId, currentUser]);

  const handleToggleStar = (id: string) => {
    storageService.toggleStar(id);
    reloadDocuments();
  };

  const handleToggleArchive = (id: string) => {
    storageService.toggleArchive(id);
    reloadDocuments();
  };

  const handleMoveToTrash = (id: string) => {
    storageService.moveToTrash(id);
    reloadDocuments();
  };

  const handleRestoreFromTrash = (id: string) => {
    storageService.restoreFromTrash(id);
    reloadDocuments();
  };

  const handleConfirmPermanentDelete = () => {
    if (!pendingDeleteId) return;
    setIsProcessing(true);

    try {
      storageService.permanentlyDelete(pendingDeleteId);
      setIsProcessing(false);
      setPendingDeleteId(null);
      reloadDocuments();
    } catch (err: any) {
      setIsProcessing(false);
      alert(err.message || '删除失败');
    }
  };

  const viewTitles: Record<WorkbenchView, { title: string; subtitle: string }> = {
    relevant: {
      title: '与我相关',
      subtitle: '展示与我相关的所有文档（由我创建、我参与协作授权或在批注中 @提及我）',
    },
    recent: { title: '最近使用', subtitle: '按最近访问与持久化排序的文档' },
    my: { title: '我的文档', subtitle: '当前用户负责创建与维护的文档集合' },
    all: { title: '全部文档', subtitle: '已授权可见的全部普通快照与协同文档' },
    starred: { title: '收藏夹', subtitle: '已加星标便于快速定位的重点文档' },
    trash: { title: '回收站', subtitle: '临时移入回收站的草稿文档，保留恢复与所有者永久销毁入口' },
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Workbench Header & Filters Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <span>{viewTitles[currentView].title}</span>
            {currentView === 'relevant' && (
              <span className="text-[11px] font-normal bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-200/60 dark:border-indigo-800/60">
                实时聚合我负责与协作的内容
              </span>
            )}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {viewTitles[currentView].subtitle}
          </p>
        </div>

        {/* Search & Sort Controls */}
        <div className="flex items-center gap-2.5">
          {/* Search box */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              placeholder="按标题或标签筛选..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 placeholder-slate-400 outline-none focus:ring-1 focus:ring-indigo-500 w-44 sm:w-56"
            />
          </div>

          {/* Sort field dropdown */}
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value as WorkbenchSortField)}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs text-slate-700 dark:text-slate-300 rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="updatedAt">按更新时间</option>
            <option value="createdAt">按创建时间</option>
            <option value="title">按标题字典序</option>
          </select>

          {/* Sort direction toggle */}
          <button
            type="button"
            onClick={() => setSortDirection(sortDirection === 'desc' ? 'asc' : 'desc')}
            className="p-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            title={sortDirection === 'desc' ? '当前降序 (点击切换升序)' : '当前升序 (点击切换降序)'}
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Trash Policy Notice */}
      {currentView === 'trash' && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/80 rounded-xl text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
          <div className="leading-relaxed">
            回收站保留策略说明：当前系统不自动永久删除回收站内容。仅文档所有者 (canManage: true) 具备永久删除权限并可触发底层对象清理；非所有者仅可执行恢复操作。
          </div>
        </div>
      )}

      {/* Documents Grid / Empty State */}
      {documents.length === 0 ? (
        <div className="p-12 text-center bg-white dark:bg-slate-900 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 space-y-3">
          <div className="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mx-auto">
            <FileText className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {searchQuery ? `未找到匹配「${searchQuery}」的文档` : '当前视图下暂无文档'}
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {currentView === 'trash'
                ? '回收站目前是空的，删除的文档将临时存放于此。'
                : currentView === 'relevant'
                ? '暂无与您相关的文档。您可以创建新文档，或等待团队成员在批注中 @提及您。'
                : '您可以立即创建实时协同文档或普通快照文档开启创作。'}
            </p>
          </div>

          {currentView !== 'trash' && (
            <button
              onClick={onOpenCreate}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg shadow-xs transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>新建知书文档</span>
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              isInTrash={currentView === 'trash'}
              onOpen={onOpenDocument}
              onToggleStar={handleToggleStar}
              onToggleArchive={handleToggleArchive}
              onMoveToTrash={handleMoveToTrash}
              onRestoreFromTrash={handleRestoreFromTrash}
              onRequestPermanentDelete={(id) => setPendingDeleteId(id)}
              onMoveDocument={(docToMove) => setMovingDoc(docToMove)}
              isProcessing={isProcessing}
            />
          ))}
        </div>
      )}

      {/* Create Document Dialog */}
      <CreateDocumentDialog
        isOpen={isCreateOpen}
        onClose={onCloseCreate}
        workspaces={workspaces}
        selectedSpaceId={selectedSpaceId}
        onCreate={(params) => {
          const newDoc = storageService.createDocument(params);
          reloadDocuments();
          onOpenDocument(newDoc.metadata.id);
        }}
      />

      {/* Move Document Modal (Directory Tree) */}
      {movingDoc && (
        <MoveDocumentDialog
          isOpen={true}
          onClose={() => setMovingDoc(null)}
          document={movingDoc}
          workspaces={workspaces}
          onMoved={() => {
            setMovingDoc(null);
            reloadDocuments();
          }}
        />
      )}

      {/* Permanent Delete Confirm Dialog */}
      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        title="确认永久彻底删除该文档？"
        message="此操作不可逆！文档正文数据、所有历史版本、批注及关联存储对象将被彻底销毁清除。"
        confirmLabel="确认永久删除"
        variant="danger"
        isProcessing={isProcessing}
        onConfirm={handleConfirmPermanentDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
    </div>
  );
};
