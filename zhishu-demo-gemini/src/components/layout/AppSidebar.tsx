/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  FileText,
  Clock,
  User,
  Star,
  Archive,
  Trash2,
  FolderKanban,
  BookOpen,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Moon,
  Sun,
  Layers,
  Compass,
  Bell,
} from 'lucide-react';
import { CurrentUser, WorkbenchView } from '../../types/document';

interface AppSidebarProps {
  currentView: WorkbenchView;
  onViewChange: (view: WorkbenchView) => void;
  activeTab: 'documents' | 'spaces' | 'knowledge';
  onTabChange: (tab: 'documents' | 'spaces' | 'knowledge') => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  currentUser: CurrentUser;
  onOpenDevTokenModal: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  currentView,
  onViewChange,
  activeTab,
  onTabChange,
  isCollapsed,
  onToggleCollapse,
  currentUser,
  onOpenDevTokenModal,
  isDark,
  onToggleTheme,
}) => {
  const workbenchViews: { key: WorkbenchView; label: string; icon: React.ReactNode }[] = [
    { key: 'relevant', label: '与我相关', icon: <Compass className="w-4 h-4 text-indigo-500" /> },
    { key: 'recent', label: '最近使用', icon: <Clock className="w-4 h-4" /> },
    { key: 'my', label: '我的文档', icon: <User className="w-4 h-4" /> },
    { key: 'all', label: '全部文档', icon: <FileText className="w-4 h-4" /> },
    { key: 'starred', label: '收藏夹', icon: <Star className="w-4 h-4" /> },
    { key: 'trash', label: '回收站', icon: <Trash2 className="w-4 h-4" /> },
  ];

  return (
    <aside
      className={`fixed top-0 left-0 h-screen bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 z-30 transition-all duration-200 flex flex-col justify-between ${
        isCollapsed ? 'w-14' : 'w-72'
      }`}
      style={{
        width: isCollapsed ? 'var(--zhishu-ui-sidebar-collapsed-w, 56px)' : 'var(--zhishu-ui-sidebar-w, 288px)',
      }}
    >
      {/* Top Header / Brand */}
      <div className="flex flex-col">
        <div className="h-14 flex items-center justify-between px-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-semibold shadow-xs shrink-0">
              知
            </div>
            {!isCollapsed && (
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold text-slate-900 dark:text-white tracking-tight truncate">
                  知书 Zhishu
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  独立文档与知识平台
                </span>
              </div>
            )}
          </div>
          <button
            onClick={onToggleCollapse}
            title={isCollapsed ? '展开导航 (288px)' : '收起导航 (56px)'}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
          >
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* Primary Sections Switcher */}
        <div className="p-2 space-y-1">
          <button
            onClick={() => onTabChange('documents')}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium rounded-md transition-colors ${
              activeTab === 'documents'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="独立文档工作台 (WEB-01)"
          >
            <Layers className="w-4 h-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
            {!isCollapsed && <span className="truncate">文档工作台</span>}
          </button>

          <button
            onClick={() => onTabChange('spaces')}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium rounded-md transition-colors ${
              activeTab === 'spaces'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="空间与知识目录 (WEB-05)"
          >
            <FolderKanban className="w-4 h-4 shrink-0 text-slate-500" />
            {!isCollapsed && <span className="truncate">企业空间目录</span>}
          </button>

          <button
            onClick={() => onTabChange('knowledge')}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-xs font-medium rounded-md transition-colors ${
              activeTab === 'knowledge'
                ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="知识库与智能问答 (WEB-07/08)"
          >
            <Sparkles className="w-4 h-4 shrink-0 text-amber-500" />
            {!isCollapsed && <span className="truncate">知识库与问答</span>}
          </button>
        </div>

        {/* Workbench Views sub-navigation (Only active when in documents tab) */}
        {activeTab === 'documents' && (
          <div className="mt-2 px-2">
            {!isCollapsed && (
              <div className="px-2.5 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300 tracking-wider">
                工作台视图
              </div>
            )}
            <div className="space-y-0.5 mt-1">
              {workbenchViews.map((item) => {
                const isActive = currentView === item.key;
                return (
                  <button
                    key={item.key}
                    onClick={() => onViewChange(item.key)}
                    title={item.label}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                      isActive
                        ? 'bg-slate-100 dark:bg-slate-800/90 text-slate-900 dark:text-white font-medium'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:text-slate-900 dark:hover:text-slate-200'
                    }`}
                  >
                    <span className={isActive ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}>
                      {item.icon}
                    </span>
                    {!isCollapsed && <span className="truncate">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Bottom User Profile & Settings */}
      <div className="p-2 border-t border-slate-100 dark:border-slate-800 space-y-1">
        {/* Current User with Mock Bearer Token dialog trigger */}
        <button
          onClick={onOpenDevTokenModal}
          title="切换测试身份 / 查看短期 Bearer Token"
          className="w-full flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left transition-colors group"
        >
          <img
            src={currentUser.avatar}
            alt={currentUser.name}
            className="w-7 h-7 rounded-full object-cover shrink-0 ring-1 ring-slate-200 dark:ring-slate-700"
          />
          {!isCollapsed && (
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                {currentUser.name}
              </span>
              <span className="text-[10px] text-slate-600 dark:text-slate-300 truncate">
                {currentUser.role === 'owner' ? '所有者 (Owner)' : currentUser.role === 'editor' ? '协作编辑 (Editor)' : '只读查看 (Viewer)'}
              </span>
            </div>
          )}
        </button>

        {/* Theme and Token info */}
        <div className="flex items-center justify-between pt-1 px-1">
          <button
            onClick={onToggleTheme}
            className="p-1.5 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md transition-colors"
            title={isDark ? '切换至明亮模式' : '切换至暗色模式'}
          >
            {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
          </button>

          {!isCollapsed && (
            <button
              onClick={onOpenDevTokenModal}
              className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>开发令牌</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  );
};
