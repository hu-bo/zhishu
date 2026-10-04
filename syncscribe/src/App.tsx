/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  PRESET_COLLABORATORS,
  Collaborator,
} from './types/collab';
import {
  Workspace,
  WikiDocument,
  OutlineItem,
  WORKSPACES,
} from './types/knowledge';
import { INITIAL_DOCUMENTS } from './templates/presetTemplates';
import { KnowledgeSidebar } from './components/KnowledgeSidebar';
import { DocumentHeader } from './components/DocumentHeader';
import { TableOfContents } from './components/TableOfContents';
import { GlobalSearchModal } from './components/GlobalSearchModal';
import { EditorPane } from './components/EditorPane';
import { StatsFooter } from './components/StatsFooter';
import {
  DocumentStats,
  exportAsMarkdown,
  exportAsHTML,
  exportAsJSON,
} from './utils/exportUtils';
import {
  Split,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  MousePointer,
  HelpCircle,
  Copy,
  Users,
} from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  // Current user collaborator profile (defaults to Alex Chen)
  const [currentUser, setCurrentUser] = useState<Collaborator>(() => {
    try {
      const saved = localStorage.getItem('syncscribe_user');
      if (saved) return JSON.parse(saved);
    } catch {
      // Fallback
    }
    return PRESET_COLLABORATORS[0];
  });

  // Secondary peer for split-screen testing (Sarah Miller)
  const [secondaryUser, setSecondaryUser] = useState<Collaborator>(
    PRESET_COLLABORATORS[1]
  );

  // Knowledge Base Documents store (loaded from localStorage or initialized with rich presets)
  const [documents, setDocuments] = useState<WikiDocument[]>(() => {
    try {
      const saved = localStorage.getItem('syncscribe_documents');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // Fallback
    }
    return INITIAL_DOCUMENTS;
  });

  // Active Workspace
  const [currentWorkspace, setCurrentWorkspace] = useState<Workspace>(() => {
    return WORKSPACES[0]; // Engineering Hub by default
  });

  // Active Document ID
  const [currentDocId, setCurrentDocId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    const docParam = params.get('doc') || params.get('room');
    if (docParam) return docParam;
    return INITIAL_DOCUMENTS[0].id;
  });

  // Layout states
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTocOpen, setIsTocOpen] = useState(true);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'edit' | 'read' | 'split'>('edit');
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  // Real-time synchronization states
  const [peers, setPeers] = useState<any[]>([]);
  const [syncStatus, setSyncStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connecting');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [stats, setStats] = useState<DocumentStats>({
    words: 0,
    characters: 0,
    readingTimeMinutes: 0,
  });

  // Editor references
  const primaryEditorRef = useRef<any>(null);
  const secondaryEditorRef = useRef<any>(null);

  // Save documents to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('syncscribe_documents', JSON.stringify(documents));
    } catch {
      // Ignore
    }
  }, [documents]);

  // Save user profile to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('syncscribe_user', JSON.stringify(currentUser));
    } catch {
      // Ignore
    }
  }, [currentUser]);

  // Current active document object
  const currentDoc = documents.find((d) => d.id === currentDocId) || documents[0] || INITIAL_DOCUMENTS[0];

  // Sync workspace when current document changes if workspace does not match
  useEffect(() => {
    if (currentDoc) {
      const parentWorkspace = WORKSPACES.find((w) => w.id === currentDoc.workspaceId);
      if (parentWorkspace && parentWorkspace.id !== currentWorkspace.id) {
        setCurrentWorkspace(parentWorkspace);
      }
    }
  }, [currentDocId]);

  // Handle URL history state
  const handleSelectDocument = useCallback((docId: string) => {
    setCurrentDocId(docId);
    const url = new URL(window.location.href);
    url.searchParams.set('doc', docId);
    window.history.pushState({}, '', url.toString());
  }, []);

  // Keyboard shortcut listener for Cmd+K and Cmd+\
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setIsSidebarCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Update current document metadata
  const handleUpdateCurrentDoc = (updated: Partial<WikiDocument>) => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === currentDoc.id ? { ...d, ...updated, updatedAt: 'Just now' } : d))
    );
  };

  // Create new document
  const handleCreateDocument = (title?: string, category?: string) => {
    const newDocId = `doc-${Date.now().toString(36)}`;
    const newDoc: WikiDocument = {
      id: newDocId,
      workspaceId: currentWorkspace.id,
      title: title || 'Untitled Knowledge Page',
      icon: '📄',
      category: category || currentDoc?.category || 'General Notes',
      tags: ['New'],
      status: 'TO_DO',
      updatedAt: 'Just now',
      author: currentUser.name,
      isStarred: false,
      description: 'New knowledge base entry.',
    };

    setDocuments((prev) => [newDoc, ...prev]);
    handleSelectDocument(newDocId);
    setViewMode('edit');
  };

  // Delete document
  const handleDeleteDocument = (docId: string) => {
    if (documents.length <= 1) return;
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    if (currentDocId === docId) {
      const remaining = documents.filter((d) => d.id !== docId);
      if (remaining[0]) {
        handleSelectDocument(remaining[0].id);
      }
    }
  };

  // Toggle star / pinned
  const handleToggleStarDocument = (docId: string) => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, isStarred: !d.isStarred } : d))
    );
  };

  // Export handlers
  const handleExportMarkdown = () => {
    if (primaryEditorRef.current) {
      exportAsMarkdown(primaryEditorRef.current, currentDoc.title);
    }
  };

  const handleExportHTML = () => {
    if (primaryEditorRef.current) {
      exportAsHTML(primaryEditorRef.current, currentDoc.title);
    }
  };

  const handleExportJSON = () => {
    if (primaryEditorRef.current) {
      exportAsJSON(primaryEditorRef.current, currentDoc.title);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  // Scroll to heading in document
  const handleScrollToHeading = (text: string) => {
    const headings = document.querySelectorAll('.tiptap h1, .tiptap h2, .tiptap h3');
    for (const h of Array.from(headings)) {
      if (h.textContent?.trim().toLowerCase() === text.trim().toLowerCase()) {
        h.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }
  };

  // Secondary peer actions for Split Collab Testing
  const handleSecondarySimulateType = () => {
    if (!secondaryEditorRef.current) return;
    const ed = secondaryEditorRef.current;
    ed.chain().focus('end').insertContent({
      type: 'paragraph',
      content: [
        { type: 'text', text: `[${secondaryUser.name}]: Document review completed. Synchronized updates verified successfully!` },
      ],
    }).run();
  };

  const handleSecondaryAddChecklistItem = () => {
    if (!secondaryEditorRef.current) return;
    const ed = secondaryEditorRef.current;
    ed.chain().focus('end').insertContent({
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', text: `Specification audited by ${secondaryUser.name}` }],
        },
      ],
    }).run();

    try {
      confetti({ particleCount: 35, spread: 55, origin: { y: 0.8 } });
    } catch {
      // Ignore
    }
  };

  const handleSecondaryInsertCallout = () => {
    if (!secondaryEditorRef.current) return;
    const ed = secondaryEditorRef.current;
    ed.chain().focus('end').insertContent({
      type: 'callout',
      attrs: { type: 'success' },
      content: [
        {
          type: 'paragraph',
          text: `Verified milestone by ${secondaryUser.name}: All CRDT vector clocks are aligned across all nodes.`,
        },
      ],
    }).run();
  };

  // Related documents in the same workspace / category
  const relatedDocs = documents.filter(
    (d) => d.id !== currentDoc.id && (d.workspaceId === currentDoc.workspaceId || d.category === currentDoc.category)
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
      {/* 1. Left Navigation Sidebar (Workspaces & Knowledge Hierarchy Tree) */}
      <KnowledgeSidebar
        currentWorkspace={currentWorkspace}
        onSelectWorkspace={(ws) => {
          setCurrentWorkspace(ws);
          const firstInWs = documents.find((d) => d.workspaceId === ws.id);
          if (firstInWs) handleSelectDocument(firstInWs.id);
        }}
        documents={documents}
        currentDocId={currentDoc.id}
        onSelectDocument={handleSelectDocument}
        onCreateDocument={(category) => handleCreateDocument(undefined, category)}
        onDeleteDocument={handleDeleteDocument}
        onToggleStarDocument={handleToggleStarDocument}
        onOpenSearch={() => setIsSearchOpen(true)}
        currentUser={currentUser}
        onOpenProfile={() => setProfileModalOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        syncStatus={syncStatus}
      />

      {/* 2. Center & Right Workspace Panel */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-white dark:bg-slate-900">
        {/* Document Header & Navigation Bar */}
        <DocumentHeader
          currentWorkspace={currentWorkspace}
          currentDoc={currentDoc}
          onUpdateDoc={handleUpdateCurrentDoc}
          viewMode={viewMode}
          onChangeViewMode={setViewMode}
          isTocOpen={isTocOpen}
          onToggleToc={() => setIsTocOpen(!isTocOpen)}
          onExportMarkdown={handleExportMarkdown}
          onExportHTML={handleExportHTML}
          onExportJSON={handleExportJSON}
          onPrint={handlePrint}
          peers={peers}
        />

        {/* Split View Simulation Action Bar */}
        {viewMode === 'split' && (
          <div className="bg-linear-to-r from-purple-600 via-indigo-600 to-blue-600 text-white px-4 py-2 text-xs shadow-md select-none shrink-0">
            <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Split className="w-4 h-4 text-purple-200 animate-pulse" />
                <span className="font-bold">Split-Screen Collaboration Test Mode:</span>
                <span className="text-purple-100">
                  Left pane: <strong>{currentUser.name}</strong> · Right pane: <strong>{secondaryUser.name}</strong>. Both share room <code>{currentDoc.id}</code> in real time.
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-purple-200 mr-1 hidden sm:inline">
                  Simulate Peer:
                </span>
                <button
                  type="button"
                  onClick={handleSecondarySimulateType}
                  className="px-2 py-1 rounded bg-white/20 hover:bg-white/30 text-white font-medium text-[11px] transition-colors"
                >
                  Sarah: Type Note
                </button>
                <button
                  type="button"
                  onClick={handleSecondaryAddChecklistItem}
                  className="px-2 py-1 rounded bg-white/20 hover:bg-white/30 text-white font-medium text-[11px] transition-colors"
                >
                  Sarah: Add Task
                </button>
                <button
                  type="button"
                  onClick={handleSecondaryInsertCallout}
                  className="px-2 py-1 rounded bg-white/20 hover:bg-white/30 text-white font-medium text-[11px] transition-colors"
                >
                  Sarah: Insert Callout
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Editor & TOC Layout */}
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Main Document Content Canvas */}
          <main className="flex-1 overflow-hidden flex flex-col p-3 md:p-6 bg-slate-100/60 dark:bg-slate-950/60">
            {viewMode === 'split' ? (
              /* Split Screen View: Two Collaborative Panels */
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 h-full min-h-0">
                <div className="h-full min-h-0 flex flex-col">
                  <EditorPane
                    key={`left-${currentDoc.id}`}
                    roomName={currentDoc.id}
                    user={currentUser}
                    paneLabel="Primary Peer (You)"
                    paneColor={currentUser.color}
                    onStatsChange={setStats}
                    onOutlineChange={setOutline}
                    onPeersChange={setPeers}
                    onSyncStatusChange={setSyncStatus}
                    onEditorReady={(ed) => (primaryEditorRef.current = ed)}
                  />
                </div>

                <div className="h-full min-h-0 flex flex-col">
                  <EditorPane
                    key={`right-${currentDoc.id}`}
                    roomName={currentDoc.id}
                    user={secondaryUser}
                    paneLabel="Secondary Peer (Concurrent Tester)"
                    paneColor={secondaryUser.color}
                    isSecondary={true}
                    onEditorReady={(ed) => (secondaryEditorRef.current = ed)}
                  />
                </div>
              </div>
            ) : (
              /* Single Mode: Full-Width Document Workspace */
              <div className="flex-1 h-full min-h-0 flex flex-col max-w-5xl mx-auto w-full">
                <EditorPane
                  key={`single-${currentDoc.id}`}
                  roomName={currentDoc.id}
                  user={currentUser}
                  isReadOnly={viewMode === 'read'}
                  viewMode={viewMode}
                  onStatsChange={setStats}
                  onOutlineChange={setOutline}
                  onPeersChange={setPeers}
                  onSyncStatusChange={setSyncStatus}
                  onEditorReady={(ed) => (primaryEditorRef.current = ed)}
                />
              </div>
            )}
          </main>

          {/* 3. Right Table of Contents & Metadata Panel */}
          {isTocOpen && (
            <TableOfContents
              currentDoc={currentDoc}
              onUpdateDoc={handleUpdateCurrentDoc}
              outline={outline}
              onScrollToHeading={handleScrollToHeading}
              relatedDocs={relatedDocs}
              onSelectDoc={handleSelectDocument}
              isOpen={isTocOpen}
              onClose={() => setIsTocOpen(false)}
            />
          )}
        </div>

        {/* Real-time Statistics Footer */}
        <StatsFooter
          stats={stats}
          roomName={currentDoc.title}
          peerCount={peers.length + (viewMode === 'split' ? 2 : 1)}
          syncStatus={syncStatus}
          onOpenSlashPalette={() => {
            if (primaryEditorRef.current) {
              primaryEditorRef.current.commands.focus();
              const event = new KeyboardEvent('keydown', { key: '/' });
              window.dispatchEvent(event);
            }
          }}
        />
      </div>

      {/* 4. Global Command Palette Modal (Cmd + K) */}
      <GlobalSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        documents={documents}
        onSelectDocument={handleSelectDocument}
        onCreateDocument={(title) => handleCreateDocument(title)}
      />

      {/* 5. User Profile Customization Modal */}
      {profileModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-2xs"
          onClick={() => setProfileModalOpen(false)}
        >
          <div
            className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 p-6 animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-indigo-600" />
                <h3 className="font-bold text-slate-900 dark:text-slate-100 text-base">
                  Collaborator Profile
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <div className="py-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                  Display Name
                </label>
                <input
                  type="text"
                  value={currentUser.name}
                  onChange={(e) =>
                    setCurrentUser({
                      ...currentUser,
                      name: e.target.value,
                      avatarText: e.target.value.slice(0, 2).toUpperCase(),
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                  Role / Title
                </label>
                <input
                  type="text"
                  value={currentUser.role}
                  onChange={(e) => setCurrentUser({ ...currentUser, role: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-2">
                  Cursor & Avatar Color
                </label>
                <div className="flex items-center gap-2">
                  {[
                    '#3b82f6', // blue
                    '#10b981', // emerald
                    '#8b5cf6', // purple
                    '#f59e0b', // amber
                    '#ec4899', // pink
                    '#06b6d4', // cyan
                    '#f97316', // orange
                    '#ef4444', // red
                  ].map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setCurrentUser({ ...currentUser, color })}
                      className={`w-7 h-7 rounded-full transition-transform cursor-pointer ${
                        currentUser.color === color
                          ? 'ring-4 ring-indigo-200 dark:ring-indigo-900 scale-110 shadow-sm'
                          : 'hover:scale-105'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setProfileModalOpen(false)}
                className="px-4 py-2 text-xs font-semibold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors cursor-pointer"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
