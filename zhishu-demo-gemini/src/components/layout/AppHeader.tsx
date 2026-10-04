/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Search, Plus, Wifi, WifiOff, Sparkles, Command, Bell, AtSign } from 'lucide-react';
import { Workspace } from '../../types/document';

interface AppHeaderProps {
  title?: string;
  subtitle?: string;
  isSidebarCollapsed: boolean;
  onOpenSearch: () => void;
  onOpenCreateDialog: () => void;
  onOpenNotifications: () => void;
  unreadNotificationsCount?: number;
  workspaces: Workspace[];
  selectedSpaceId: string | null;
  onSelectSpace: (spaceId: string | null) => void;
  isOffline?: boolean;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  title = '独立文档工作台',
  subtitle,
  isSidebarCollapsed,
  onOpenSearch,
  onOpenCreateDialog,
  onOpenNotifications,
  unreadNotificationsCount = 0,
  workspaces,
  selectedSpaceId,
  onSelectSpace,
  isOffline = false,
}) => {
  return (
    <header
      className="sticky top-0 z-20 h-14 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xs border-b border-slate-200 dark:border-slate-800 transition-all duration-200 flex items-center justify-between px-4 sm:px-6"
      style={{
        marginLeft: isSidebarCollapsed ? 'var(--zhishu-ui-sidebar-collapsed-w, 56px)' : 'var(--zhishu-ui-sidebar-w, 288px)',
      }}
    >
      {/* Left: Breadcrumb / Title */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
              {title}
            </h1>
            {subtitle && (
              <>
                <span className="text-slate-300 dark:text-slate-600">/</span>
                <span className="text-xs text-slate-500 dark:text-slate-400 truncate">
                  {subtitle}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Space Filter selector */}
        <div className="hidden md:flex items-center ml-4 pl-3 border-l border-slate-200 dark:border-slate-800">
          <select
            value={selectedSpaceId || ''}
            onChange={(e) => onSelectSpace(e.target.value ? e.target.value : null)}
            className="text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">全部空间与独立文档</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.icon} {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Right Controls: Global Search, Notifications, Offline Status, New Doc Button */}
      <div className="flex items-center gap-2 sm:gap-2.5">
        {/* Network / Offline indicator */}
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-slate-500 dark:text-slate-400">
          {isOffline ? (
            <>
              <WifiOff className="w-3.5 h-3.5 text-amber-500" />
              <span className="hidden sm:inline text-amber-600 dark:text-amber-400">离线草稿模式</span>
            </>
          ) : (
            <>
              <Wifi className="w-3.5 h-3.5 text-emerald-500" />
              <span className="hidden sm:inline text-emerald-600 dark:text-emerald-400">服务正常</span>
            </>
          )}
        </div>

        {/* Global Search Button */}
        <button
          onClick={onOpenSearch}
          className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800/80 hover:bg-slate-200/70 dark:hover:bg-slate-700 rounded-lg transition-colors border border-slate-200/60 dark:border-slate-700/60"
          title="全局检索 (Ctrl/Cmd + K)"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="hidden md:inline">搜索文档与正文...</span>
          <kbd className="hidden md:inline-flex items-center gap-0.5 text-[10px] bg-white dark:bg-slate-900 px-1.5 py-0.5 rounded-sm border border-slate-200 dark:border-slate-700 text-slate-400">
            <Command className="w-2.5 h-2.5" /> K
          </kbd>
        </button>

        {/* Notifications & @Mentions Button */}
        <button
          onClick={onOpenNotifications}
          className="relative p-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
          title="@我的通知与提及"
        >
          <Bell className="w-4 h-4" />
          {unreadNotificationsCount > 0 && (
            <span className="absolute top-1 right-1 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold ring-2 ring-white dark:ring-slate-900 animate-pulse">
              {unreadNotificationsCount}
            </span>
          )}
        </button>

        {/* New Document Button */}
        <button
          onClick={onOpenCreateDialog}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors shadow-xs"
        >
          <Plus className="w-4 h-4" />
          <span>新建文档</span>
        </button>
      </div>
    </header>
  );
};
