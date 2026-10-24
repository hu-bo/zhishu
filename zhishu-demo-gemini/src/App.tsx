/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { AppSidebar } from './components/layout/AppSidebar';
import { AppHeader } from './components/layout/AppHeader';
import { WorkbenchPage } from './components/workbench/WorkbenchPage';
import { DocumentEditorPage } from './components/editor/DocumentEditorPage';
import { SpacesPage } from './components/spaces/SpacesPage';
import { KnowledgePage } from './components/spaces/KnowledgePage';
import { GlobalSearchDialog } from './components/dialogs/GlobalSearchDialog';
import { DevTokenModal } from './components/dialogs/DevTokenModal';
import { NotificationCenterDialog } from './components/dialogs/NotificationCenterDialog';
import { CurrentUser, WorkbenchView, Workspace } from './types/document';
import { storageService, MOCK_USERS } from './services/storage';

export default function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser>(() =>
    storageService.getCurrentUser()
  );
  const [activeTab, setActiveTab] = useState<'documents' | 'spaces' | 'knowledge'>('documents');
  const [currentView, setCurrentView] = useState<WorkbenchView>('relevant');
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);

  // Layout states
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(false);

  // Dialogs
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isDevTokenOpen, setIsDevTokenOpen] = useState(false);
  const [isCreateDocOpen, setIsCreateDocOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);

  // Notifications state
  const [unreadNotificationsCount, setUnreadNotificationsCount] = useState<number>(() =>
    storageService.getUnreadNotificationCount(currentUser.id)
  );

  const [workspaces, setWorkspaces] = useState<Workspace[]>(() =>
    storageService.getWorkspaces()
  );

  const refreshNotificationCount = () => {
    setUnreadNotificationsCount(storageService.getUnreadNotificationCount(currentUser.id));
  };

  // Sync dark class on document element
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Global Ctrl/Cmd + K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSwitchUser = (role: 'owner' | 'editor' | 'viewer') => {
    const switched = storageService.switchUser(role);
    setCurrentUser(switched);
    setUnreadNotificationsCount(storageService.getUnreadNotificationCount(switched.id));
  };

  const handleOpenDocument = (docId: string) => {
    setActiveDocumentId(docId);
  };

  const handleBackToWorkbench = () => {
    setActiveDocumentId(null);
    refreshNotificationCount();
  };

  // If a document is currently active, render the dedicated DocumentEditorPage
  if (activeDocumentId) {
    return (
      <div className={isDark ? 'dark' : ''}>
        <DocumentEditorPage
          documentId={activeDocumentId}
          onBackToWorkbench={handleBackToWorkbench}
          currentUser={currentUser}
        />
        {/* Global Search Dialog still available inside editor */}
        <GlobalSearchDialog
          isOpen={isSearchOpen}
          onClose={() => setIsSearchOpen(false)}
          onSelectDocument={(id) => {
            setActiveDocumentId(id);
          }}
        />
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col ${isDark ? 'dark' : ''}`}>
      {/* Fixed Sidebar */}
      <AppSidebar
        currentView={currentView}
        onViewChange={setCurrentView}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          if (tab === 'spaces' && !selectedSpaceId && workspaces.length > 0) {
            setSelectedSpaceId(workspaces[0].id);
          }
        }}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        currentUser={currentUser}
        onOpenDevTokenModal={() => setIsDevTokenOpen(true)}
        isDark={isDark}
        onToggleTheme={() => setIsDark(!isDark)}
      />

      {/* Top Application Header with Notifications Trigger */}
      <AppHeader
        title={
          activeTab === 'documents'
            ? '知书工作台'
            : activeTab === 'spaces'
            ? '企业空间目录'
            : '知识库与问答'
        }
        subtitle={
          activeTab === 'documents'
            ? currentView === 'relevant'
              ? '与我相关'
              : currentView === 'recent'
              ? '最近使用'
              : currentView === 'my'
              ? '我的文档'
              : currentView === 'all'
              ? '全部文档'
              : currentView === 'starred'
                ? '收藏夹'
                : currentView === 'trash'
                  ? '回收站'
                  : undefined
            : undefined
        }
        isSidebarCollapsed={isSidebarCollapsed}
        onOpenSearch={() => setIsSearchOpen(true)}
        onOpenCreateDialog={() => setIsCreateDocOpen(true)}
        onOpenNotifications={() => setIsNotificationsOpen(true)}
        unreadNotificationsCount={unreadNotificationsCount}
        workspaces={workspaces}
        selectedSpaceId={selectedSpaceId}
        onSelectSpace={setSelectedSpaceId}
      />

      {/* Main Content Area */}
      <main
        className="flex-1 transition-all duration-200"
        style={{
          marginLeft: isSidebarCollapsed
            ? 'var(--zhishu-ui-sidebar-collapsed-w, 56px)'
            : 'var(--zhishu-ui-sidebar-w, 288px)',
        }}
      >
        {activeTab === 'documents' && (
          <WorkbenchPage
            currentView={currentView}
            onViewChange={setCurrentView}
            selectedSpaceId={selectedSpaceId}
            onOpenDocument={handleOpenDocument}
            workspaces={workspaces}
            currentUser={currentUser}
            isCreateOpen={isCreateDocOpen}
            onCloseCreate={() => setIsCreateDocOpen(false)}
            onOpenCreate={() => setIsCreateDocOpen(true)}
          />
        )}

        {activeTab === 'spaces' && (
          <SpacesPage
            workspaces={workspaces}
            selectedSpaceId={selectedSpaceId}
            onSelectSpace={setSelectedSpaceId}
            onOpenDocument={handleOpenDocument}
            onOpenCreateDoc={(spaceId) => {
              setSelectedSpaceId(spaceId);
              setIsCreateDocOpen(true);
            }}
          />
        )}

        {activeTab === 'knowledge' && <KnowledgePage />}
      </main>

      {/* Global Search Dialog (Ctrl+K) */}
      <GlobalSearchDialog
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onSelectDocument={handleOpenDocument}
      />

      {/* Dev Token & Role Switcher Modal */}
      <DevTokenModal
        isOpen={isDevTokenOpen}
        onClose={() => setIsDevTokenOpen(false)}
        currentUser={currentUser}
        onSwitchUser={handleSwitchUser}
      />

      {/* Notification Center Dialog (@我的通知) */}
      <NotificationCenterDialog
        isOpen={isNotificationsOpen}
        onClose={() => setIsNotificationsOpen(false)}
        currentUser={currentUser}
        onSelectDocument={handleOpenDocument}
        onNotificationsChanged={refreshNotificationCount}
      />
    </div>
  );
}
