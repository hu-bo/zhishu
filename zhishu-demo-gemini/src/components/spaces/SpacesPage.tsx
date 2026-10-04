/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  FolderKanban,
  Plus,
  FileText,
  ChevronRight,
  ChevronDown,
  Users,
  Search,
  Calendar,
  Folder,
  FolderOpen,
  ArrowRight,
  Sparkles,
  MoveRight,
} from 'lucide-react';
import { Workspace, DocumentMetadata } from '../../types/document';
import { storageService } from '../../services/storage';
import { MoveDocumentDialog } from '../dialogs/MoveDocumentDialog';

interface SpacesPageProps {
  workspaces: Workspace[];
  selectedSpaceId: string | null;
  onSelectSpace: (spaceId: string | null) => void;
  onOpenDocument: (docId: string) => void;
  onOpenCreateDoc: (spaceId: string) => void;
}

export const SpacesPage: React.FC<SpacesPageProps> = ({
  workspaces,
  selectedSpaceId,
  onSelectSpace,
  onOpenDocument,
  onOpenCreateDoc,
}) => {
  const [activeSpaceId, setActiveSpaceId] = useState<string>(
    selectedSpaceId || (workspaces.length > 0 ? workspaces[0].id : '')
  );
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [movingDoc, setMovingDoc] = useState<DocumentMetadata | null>(null);

  const currentSpace =
    workspaces.find((w) => w.id === activeSpaceId) || workspaces[0];

  // Fetch all documents for this space, optionally filtered by folder and search
  const allSpaceDocs = storageService.getDocuments({
    view: 'all',
    spaceId: currentSpace.id,
  });

  const filteredDocs = allSpaceDocs.filter((d) => {
    if (activeFolderId && d.folderId !== activeFolderId) return false;
    if (searchFilter.trim()) {
      const q = searchFilter.toLowerCase();
      return d.title.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q);
    }
    return true;
  });

  const handleSelectSpace = (id: string) => {
    setActiveSpaceId(id);
    setActiveFolderId(null);
    onSelectSpace(id);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* 1. Header Overview & Spaces List Cards */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
              <FolderKanban className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
              <span>企业空间与目录树 (Spaces & Directories)</span>
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              按空间列表展示，清晰掌握每个知识空间的文档体量、创建时间与成员协同范围。
            </p>
          </div>

          <button
            onClick={() => onOpenCreateDoc(currentSpace.id)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg shadow-xs transition-colors self-start sm:self-auto"
          >
            <Plus className="w-4 h-4" />
            <span>在当前空间新建文档</span>
          </button>
        </div>

        {/* Space List: Show document count, creation time, member count */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {workspaces.map((space) => {
            const isSelected = activeSpaceId === space.id;
            const spaceDocCount = storageService.getDocuments({ view: 'all', spaceId: space.id }).length;

            return (
              <div
                key={space.id}
                onClick={() => handleSelectSpace(space.id)}
                className={`p-4 rounded-xl border transition-all cursor-pointer relative overflow-hidden flex flex-col justify-between ${
                  isSelected
                    ? 'border-indigo-600 bg-white dark:bg-slate-900 shadow-md ring-2 ring-indigo-500/20'
                    : 'border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-2xl select-none">{space.icon}</span>
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          {space.name}
                        </h3>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">
                          {space.description}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Metadata: Document count, Creation time, Member count */}
                  <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg">
                      <div className="text-[10px] text-slate-400 font-medium">空间文档</div>
                      <div className="text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5">
                        {spaceDocCount} 篇
                      </div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg">
                      <div className="text-[10px] text-slate-400 font-medium">成员数量</div>
                      <div className="text-xs font-bold text-slate-800 dark:text-slate-200 mt-0.5 flex items-center justify-center gap-1">
                        <Users className="w-3 h-3 text-slate-400" />
                        <span>{space.memberCount}</span>
                      </div>
                    </div>
                    <div className="bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg">
                      <div className="text-[10px] text-slate-400 font-medium">创建时间</div>
                      <div className="text-[11px] font-medium text-slate-700 dark:text-slate-300 mt-0.5 truncate">
                        {new Date(space.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                      </div>
                    </div>
                  </div>
                </div>

                {isSelected && (
                  <div className="mt-3 flex items-center justify-end text-[11px] text-indigo-600 dark:text-indigo-400 font-semibold gap-1">
                    <span>当前选定空间</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Directory Tree Navigation & Document Management in Active Space */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left Column: Directory Tree (目录树) */}
        <div className="lg:col-span-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3 shadow-xs">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-2.5">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span className="text-xs font-bold text-slate-800 dark:text-slate-200">
                空间目录树 (Directory)
              </span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">
              {currentSpace.folders.length} 目录
            </span>
          </div>

          <div className="space-y-1 pt-1">
            {/* All documents in space root */}
            <button
              onClick={() => setActiveFolderId(null)}
              className={`w-full flex items-center justify-between p-2 rounded-lg text-xs transition-colors ${
                activeFolderId === null
                  ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-indigo-500" />
                <span>全部文档 (根目录)</span>
              </div>
              <span className="text-[10px] font-mono text-slate-400">
                {allSpaceDocs.length}
              </span>
            </button>

            {/* Sub-folders in current space */}
            {currentSpace.folders.map((folder) => {
              const isSelected = activeFolderId === folder.id;
              const folderDocsCount = allSpaceDocs.filter((d) => d.folderId === folder.id).length;

              return (
                <button
                  key={folder.id}
                  onClick={() => setActiveFolderId(folder.id)}
                  className={`w-full flex items-center justify-between p-2 rounded-lg text-xs transition-colors pl-5 ${
                    isSelected
                      ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="truncate">{folder.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">
                    {folderDocsCount}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
            提示：点击任意文档右侧的「移动」按钮，可通过弹出的目录树自由在空间与文件夹之间归类迁移。
          </div>
        </div>

        {/* Right Column: Documents in Active Folder / Space */}
        <div className="lg:col-span-3 space-y-4">
          {/* Search bar inside selected space */}
          <div className="flex items-center justify-between gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                placeholder={`在 ${currentSpace.name} 中检索标题或摘要...`}
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <span className="text-xs text-slate-500">
              展示 {filteredDocs.length} 篇文档
            </span>
          </div>

          {/* Documents Grid */}
          {filteredDocs.length === 0 ? (
            <div className="p-12 text-center bg-white dark:bg-slate-900 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 space-y-2">
              <FileText className="w-8 h-8 text-slate-400 mx-auto" />
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                该目录下暂无文档
              </div>
              <p className="text-[11px] text-slate-500">
                您可以新建文档，或从其他空间将文档移动至此目录。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {filteredDocs.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => onOpenDocument(doc.id)}
                  className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-indigo-400/60 hover:shadow-xs transition-all cursor-pointer flex flex-col justify-between group"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className="text-xl select-none mt-0.5">{doc.emoji || '📄'}</span>
                        <div className="min-w-0">
                          <h4 className="text-xs font-semibold text-slate-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                            {doc.title}
                          </h4>
                          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                            <span>{doc.folderName || '根目录'}</span>
                            <span>·</span>
                            <span>{doc.mode === 'collaborative' ? `协同 seq:${doc.durableSeq}` : `快照 rev:${doc.snapshotRevision}`}</span>
                          </div>
                        </div>
                      </div>

                      {/* Move Document Action Button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMovingDoc(doc);
                        }}
                        className="p-1.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
                        title="移动至其他空间或目录"
                      >
                        <MoveRight className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-2.5 line-clamp-2 leading-relaxed">
                      {doc.summary || '暂无摘要'}
                    </p>
                  </div>

                  <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                    <span>{new Date(doc.updatedAt).toLocaleDateString('zh-CN')}</span>
                    <span className="text-indigo-600 dark:text-indigo-400 group-hover:underline">
                      进入编辑 →
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Move Document Modal using Directory Tree */}
      {movingDoc && (
        <MoveDocumentDialog
          isOpen={true}
          onClose={() => setMovingDoc(null)}
          document={movingDoc}
          workspaces={workspaces}
          onMoved={() => {
            setMovingDoc(null);
          }}
        />
      )}
    </div>
  );
};
