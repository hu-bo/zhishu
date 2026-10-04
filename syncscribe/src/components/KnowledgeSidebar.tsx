import React, { useState } from 'react';
import {
  Folder,
  FileText,
  ChevronDown,
  ChevronRight,
  Plus,
  Star,
  Search,
  Layers,
  Settings,
  Sparkles,
  Trash2,
  Share2,
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  FolderOpen,
  Hash,
  Users,
} from 'lucide-react';
import { WikiDocument, Workspace, WORKSPACES } from '../types/knowledge';
import { Collaborator, STATUS_CONFIGS } from '../types/collab';

interface KnowledgeSidebarProps {
  currentWorkspace: Workspace;
  onSelectWorkspace: (ws: Workspace) => void;
  documents: WikiDocument[];
  currentDocId: string;
  onSelectDocument: (docId: string) => void;
  onCreateDocument: (category?: string) => void;
  onDeleteDocument: (docId: string) => void;
  onToggleStarDocument: (docId: string) => void;
  onOpenSearch: () => void;
  currentUser: Collaborator;
  onOpenProfile: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  syncStatus: 'connected' | 'connecting' | 'disconnected';
}

export const KnowledgeSidebar: React.FC<KnowledgeSidebarProps> = ({
  currentWorkspace,
  onSelectWorkspace,
  documents,
  currentDocId,
  onSelectDocument,
  onCreateDocument,
  onDeleteDocument,
  onToggleStarDocument,
  onOpenSearch,
  currentUser,
  onOpenProfile,
  isCollapsed,
  onToggleCollapse,
  syncStatus,
}) => {
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

  // Filter documents belonging to current workspace
  const workspaceDocs = documents.filter((d) => d.workspaceId === currentWorkspace.id);
  const starredDocs = documents.filter((d) => d.isStarred);

  // Group by category
  const categories = Array.from(new Set(workspaceDocs.map((d) => d.category)));

  const toggleCategory = (category: string) => {
    setCollapsedCategories((prev) => ({
      ...prev,
      [category]: !prev[category],
    }));
  };

  if (isCollapsed) {
    return (
      <div className="w-14 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col items-center py-3 select-none z-20">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="p-2 rounded-xl text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors mb-3"
          title="Expand Sidebar (Cmd+\)"
        >
          <PanelLeftOpen className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={onOpenSearch}
          className="p-2 rounded-xl text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950 transition-colors mb-2"
          title="Search Documents (Cmd+K)"
        >
          <Search className="w-5 h-5" />
        </button>

        <button
          type="button"
          onClick={() => onCreateDocument()}
          className="p-2 rounded-xl text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950 transition-colors mb-4"
          title="New Document"
        >
          <Plus className="w-5 h-5" />
        </button>

        <div className="w-8 h-px bg-slate-200 dark:bg-slate-800 my-2" />

        {/* Collapsed document icons */}
        <div className="flex-1 overflow-y-auto space-y-1.5 w-full px-2">
          {workspaceDocs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => onSelectDocument(doc.id)}
              className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all ${
                doc.id === currentDocId
                  ? 'bg-indigo-100 dark:bg-indigo-950 ring-2 ring-indigo-500 shadow-xs'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
              title={doc.title}
            >
              {doc.icon}
            </button>
          ))}
        </div>

        {/* User avatar */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-xs cursor-pointer mt-2"
          style={{ backgroundColor: currentUser.color }}
          onClick={onOpenProfile}
          title={`User: ${currentUser.name}`}
        >
          {currentUser.name.slice(0, 2).toUpperCase()}
        </div>
      </div>
    );
  }

  return (
    <aside className="w-72 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col h-full select-none z-20 transition-all">
      {/* Workspace Switcher Header */}
      <div className="p-3 border-b border-slate-100 dark:border-slate-800 relative">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setWorkspaceMenuOpen(!workspaceMenuOpen)}
            className="flex-1 flex items-center gap-2.5 p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left cursor-pointer"
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center text-lg shadow-2xs border border-black/5 dark:border-white/10"
              style={{ backgroundColor: `${currentWorkspace.color}15` }}
            >
              {currentWorkspace.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-xs text-slate-900 dark:text-slate-100 truncate">
                  {currentWorkspace.name}
                </span>
                <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" />
              </div>
              <span className="text-[10px] text-slate-400 font-medium">
                {currentWorkspace.badge} · {workspaceDocs.length} Docs
              </span>
            </div>
          </button>

          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ml-1"
            title="Collapse Sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* Workspace Dropdown Menu */}
        {workspaceMenuOpen && (
          <div
            className="absolute left-3 right-3 top-full mt-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl p-2 z-50 animate-in fade-in zoom-in-95 duration-100"
            onMouseLeave={() => setWorkspaceMenuOpen(false)}
          >
            <div className="px-2.5 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Switch Workspace
            </div>
            <div className="space-y-1">
              {WORKSPACES.map((ws) => {
                const isActive = ws.id === currentWorkspace.id;
                return (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => {
                      onSelectWorkspace(ws);
                      setWorkspaceMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 p-2 rounded-xl text-left transition-all ${
                      isActive
                        ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-900 dark:text-indigo-200 font-semibold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="text-xl">{ws.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs truncate">{ws.name}</div>
                      <div className="text-[10px] text-slate-400 line-clamp-1">{ws.badge}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Quick Search & New Doc Buttons */}
      <div className="px-3 pt-3 space-y-1">
        <button
          type="button"
          onClick={onOpenSearch}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-slate-100/70 dark:bg-slate-800/60 hover:bg-slate-200/70 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700/60 text-xs text-slate-500 dark:text-slate-400 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <span>Search Knowledge...</span>
          </div>
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-700 text-slate-400">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => onCreateDocument()}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New Document</span>
        </button>
      </div>

      {/* Navigation List Area */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
        {/* Starred / Pinned Section */}
        {starredDocs.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 px-2 mb-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
              <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
              <span>Pinned ({starredDocs.length})</span>
            </div>
            <div className="space-y-0.5">
              {starredDocs.map((doc) => {
                const isActive = doc.id === currentDocId;
                return (
                  <button
                    key={`star-${doc.id}`}
                    type="button"
                    onClick={() => onSelectDocument(doc.id)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all text-left truncate cursor-pointer group ${
                      isActive
                        ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-900 dark:text-indigo-200 font-semibold'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="text-sm shrink-0">{doc.icon}</span>
                    <span className="truncate flex-1">{doc.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Categories & Document Tree */}
        <div className="space-y-3">
          <div className="flex items-center justify-between px-2 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
            <span>Library Tree</span>
            <button
              type="button"
              onClick={() => onCreateDocument()}
              className="text-slate-400 hover:text-indigo-600 transition-colors p-0.5"
              title="Add page"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {categories.map((category) => {
            const isCatCollapsed = collapsedCategories[category];
            const catDocs = workspaceDocs.filter((d) => d.category === category);

            return (
              <div key={category} className="space-y-0.5">
                {/* Category Header */}
                <div className="flex items-center justify-between px-2 py-1 rounded-md text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100/50 dark:hover:bg-slate-800/50 cursor-pointer">
                  <div
                    className="flex items-center gap-1.5 flex-1"
                    onClick={() => toggleCategory(category)}
                  >
                    {isCatCollapsed ? (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                    )}
                    <span className="truncate">{category}</span>
                  </div>
                  <span className="text-[10px] text-slate-400 px-1 font-mono">
                    {catDocs.length}
                  </span>
                </div>

                {/* Category Documents */}
                {!isCatCollapsed && (
                  <div className="pl-2 space-y-0.5 border-l border-slate-100 dark:border-slate-800 ml-3">
                    {catDocs.map((doc) => {
                      const isActive = doc.id === currentDocId;
                      const status = STATUS_CONFIGS[doc.status] || STATUS_CONFIGS.IN_PROGRESS;

                      return (
                        <div
                          key={doc.id}
                          className={`group flex items-center justify-between px-2 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
                            isActive
                              ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-900 dark:text-indigo-200 font-semibold'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                          }`}
                          onClick={() => onSelectDocument(doc.id)}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="text-sm shrink-0">{doc.icon}</span>
                            <span className="truncate">{doc.title}</span>
                          </div>

                          {/* Hover Actions */}
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onToggleStarDocument(doc.id);
                              }}
                              className={`p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 ${
                                doc.isStarred ? 'text-amber-500' : 'text-slate-400'
                              }`}
                              title={doc.isStarred ? 'Unstar' : 'Star page'}
                            >
                              <Star
                                className={`w-3 h-3 ${doc.isStarred ? 'fill-amber-500' : ''}`}
                              />
                            </button>

                            {workspaceDocs.length > 1 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteDocument(doc.id);
                                }}
                                className="p-0.5 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                                title="Delete page"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Sidebar Footer */}
      <div className="p-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-850">
        <div
          className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
          onClick={onOpenProfile}
        >
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-2xs"
            style={{ backgroundColor: currentUser.color }}
          >
            {currentUser.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate">
              {currentUser.name}
            </div>
            <div className="flex items-center gap-1 text-[10px] text-slate-400">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  syncStatus === 'connected'
                    ? 'bg-emerald-500'
                    : syncStatus === 'connecting'
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                }`}
              />
              <span className="capitalize">{syncStatus}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onOpenProfile}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors"
          title="Account Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
};
