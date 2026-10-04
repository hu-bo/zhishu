import React, { useState } from 'react';
import {
  Star,
  Share2,
  Download,
  ListTree,
  Eye,
  Edit3,
  Split,
  Check,
  ChevronDown,
  Printer,
  FileCode,
  FileText,
  FileJson,
  Smile,
  Users,
} from 'lucide-react';
import { WikiDocument, Workspace } from '../types/knowledge';
import { PresenceUser } from './PresenceHeader';

const EMOJI_OPTIONS = ['⚡', '🌐', '🛡️', '🚀', '🎨', '🎯', '📚', '📝', '💡', '🔍', '⚙️', '📊', '🔥', '✨', '💻'];

interface DocumentHeaderProps {
  currentWorkspace: Workspace;
  currentDoc: WikiDocument;
  onUpdateDoc: (updated: Partial<WikiDocument>) => void;
  viewMode: 'edit' | 'read' | 'split';
  onChangeViewMode: (mode: 'edit' | 'read' | 'split') => void;
  isTocOpen: boolean;
  onToggleToc: () => void;
  onExportMarkdown: () => void;
  onExportHTML: () => void;
  onExportJSON: () => void;
  onPrint: () => void;
  peers: PresenceUser[];
}

export const DocumentHeader: React.FC<DocumentHeaderProps> = ({
  currentWorkspace,
  currentDoc,
  onUpdateDoc,
  viewMode,
  onChangeViewMode,
  isTocOpen,
  onToggleToc,
  onExportMarkdown,
  onExportHTML,
  onExportJSON,
  onPrint,
  peers,
}) => {
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [copiedShare, setCopiedShare] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(currentDoc.title);

  const handleShare = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('doc', currentDoc.id);
    navigator.clipboard.writeText(url.toString()).then(() => {
      setCopiedShare(true);
      setTimeout(() => setCopiedShare(false), 2000);
    });
  };

  const handleSaveTitle = () => {
    if (titleValue.trim()) {
      onUpdateDoc({ title: titleValue.trim() });
    }
    setIsEditingTitle(false);
  };

  return (
    <header className="sticky top-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-4 py-2 select-none transition-colors">
      <div className="flex items-center justify-between gap-3">
        {/* Left: Breadcrumbs & Page Icon */}
        <div className="flex items-center gap-2 min-w-0">
          {/* Document Emoji with Quick Picker */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
              className="text-lg p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              title="Change Document Icon"
            >
              {currentDoc.icon}
            </button>

            {emojiPickerOpen && (
              <div
                className="absolute left-0 mt-2 p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl grid grid-cols-5 gap-1 z-50 animate-in fade-in zoom-in-95 duration-100"
                onMouseLeave={() => setEmojiPickerOpen(false)}
              >
                {EMOJI_OPTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onUpdateDoc({ icon: emoji });
                      setEmojiPickerOpen(false);
                    }}
                    className="p-1.5 text-base rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Breadcrumb Path */}
          <div className="flex items-center gap-1.5 text-xs text-slate-400 min-w-0">
            <span className="font-medium text-slate-600 dark:text-slate-300 truncate hidden sm:inline">
              {currentWorkspace.name}
            </span>
            <span className="hidden sm:inline">/</span>
            <span className="font-medium truncate hidden md:inline">
              {currentDoc.category}
            </span>
            <span className="hidden md:inline">/</span>

            {isEditingTitle ? (
              <input
                type="text"
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value)}
                onBlur={handleSaveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveTitle();
                  if (e.key === 'Escape') setIsEditingTitle(false);
                }}
                className="font-bold text-slate-900 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded border border-indigo-400 outline-none text-xs"
                autoFocus
              />
            ) : (
              <span
                onClick={() => {
                  setTitleValue(currentDoc.title);
                  setIsEditingTitle(true);
                }}
                className="font-bold text-slate-800 dark:text-slate-200 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer truncate max-w-[200px] sm:max-w-xs md:max-w-md"
                title="Click to rename page"
              >
                {currentDoc.title}
              </span>
            )}
          </div>
        </div>

        {/* Right: View Mode Toggle, TOC, Export, Share */}
        <div className="flex items-center gap-2">
          {/* Active Collaborators Avatars */}
          {peers.length > 0 && (
            <div className="hidden lg:flex items-center -space-x-1.5 mr-1">
              {peers.map((peer) => (
                <div
                  key={peer.clientId}
                  className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold border-2 border-white dark:border-slate-900 shadow-xs"
                  style={{ backgroundColor: peer.color }}
                  title={`${peer.name} (${peer.role || 'Collaborator'})`}
                >
                  {peer.name.slice(0, 2).toUpperCase()}
                </div>
              ))}
            </div>
          )}

          {/* View Mode Segmented Controls */}
          <div className="flex items-center p-0.5 rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs">
            <button
              type="button"
              onClick={() => onChangeViewMode('edit')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium transition-all ${
                viewMode === 'edit'
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-2xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
              title="Edit Mode: Rich text and blocks"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Edit</span>
            </button>

            <button
              type="button"
              onClick={() => onChangeViewMode('read')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium transition-all ${
                viewMode === 'read'
                  ? 'bg-white dark:bg-slate-900 text-indigo-600 dark:text-indigo-400 shadow-2xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
              title="Read / Wiki Mode: Clean article layout"
            >
              <Eye className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Wiki View</span>
            </button>

            <button
              type="button"
              onClick={() => onChangeViewMode('split')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg font-medium transition-all ${
                viewMode === 'split'
                  ? 'bg-purple-600 text-white shadow-2xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
              title="Split Collab Mode: Live concurrent test peer"
            >
              <Split className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Split Collab</span>
            </button>
          </div>

          {/* Star / Bookmark Toggle */}
          <button
            type="button"
            onClick={() => onUpdateDoc({ isStarred: !currentDoc.isStarred })}
            className={`p-1.5 rounded-lg border transition-colors ${
              currentDoc.isStarred
                ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-500 border-amber-300 dark:border-amber-800'
                : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 border-transparent hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title={currentDoc.isStarred ? 'Unpin page' : 'Pin to favorites'}
          >
            <Star className={`w-4 h-4 ${currentDoc.isStarred ? 'fill-amber-500' : ''}`} />
          </button>

          {/* Table of Contents Drawer Toggle */}
          <button
            type="button"
            onClick={onToggleToc}
            className={`p-1.5 rounded-lg border transition-colors ${
              isTocOpen
                ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 border-indigo-200 dark:border-indigo-800'
                : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 border-transparent hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
            title="Toggle Outline (Table of Contents)"
          >
            <ListTree className="w-4 h-4" />
          </button>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportMenuOpen(!exportMenuOpen)}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              title="Export Document"
            >
              <Download className="w-4 h-4" />
            </button>

            {exportMenuOpen && (
              <div
                className="absolute right-0 mt-2 w-48 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl p-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
                onMouseLeave={() => setExportMenuOpen(false)}
              >
                <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Export Knowledge
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onExportMarkdown();
                    setExportMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <FileText className="w-4 h-4 text-blue-500" />
                  <span>Markdown (.md)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onExportHTML();
                    setExportMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <FileCode className="w-4 h-4 text-emerald-500" />
                  <span>Clean HTML (.html)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onExportJSON();
                    setExportMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <FileJson className="w-4 h-4 text-amber-500" />
                  <span>Tiptap JSON (.json)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onPrint();
                    setExportMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                >
                  <Printer className="w-4 h-4 text-purple-500" />
                  <span>Print / Save PDF</span>
                </button>
              </div>
            )}
          </div>

          {/* Share Link */}
          <button
            type="button"
            onClick={handleShare}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 text-xs font-semibold border border-indigo-200 dark:border-indigo-800 transition-colors"
            title="Share Document Link"
          >
            {copiedShare ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                <span className="hidden sm:inline text-emerald-600 dark:text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Share2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Share</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
