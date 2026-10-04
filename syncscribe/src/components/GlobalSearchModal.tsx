import React, { useState, useEffect, useRef } from 'react';
import { Search, FileText, ArrowRight, Tag, Folder, Sparkles, Plus } from 'lucide-react';
import { WikiDocument, Workspace, WORKSPACES } from '../types/knowledge';
import { STATUS_CONFIGS } from '../types/collab';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  documents: WikiDocument[];
  onSelectDocument: (docId: string) => void;
  onCreateDocument: (title?: string) => void;
}

export const GlobalSearchModal: React.FC<GlobalSearchModalProps> = ({
  isOpen,
  onClose,
  documents,
  onSelectDocument,
  onCreateDocument,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const filtered = documents.filter((doc) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      doc.title.toLowerCase().includes(q) ||
      doc.category.toLowerCase().includes(q) ||
      doc.tags.some((t) => t.toLowerCase().includes(q)) ||
      (doc.description && doc.description.toLowerCase().includes(q))
    );
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length + 1) % Math.max(1, filtered.length + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex === filtered.length && query.trim()) {
          onCreateDocument(query.trim());
          onClose();
        } else if (filtered[selectedIndex]) {
          onSelectDocument(filtered[selectedIndex].id);
          onClose();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, filtered, query, onSelectDocument, onCreateDocument, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4 bg-black/40 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <Search className="w-5 h-5 text-indigo-500" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search documents, tags, architecture RFCs, notes..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm md:text-base text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
          <kbd className="px-2 py-0.5 text-[11px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-500 rounded font-semibold">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div className="max-h-96 overflow-y-auto p-2 divide-y divide-slate-100 dark:divide-slate-800/60">
          {filtered.length === 0 ? (
            <div className="py-10 text-center space-y-3">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No documents found matching "{query}"
              </p>
              {query.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    onCreateDocument(query.trim());
                    onClose();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create page "{query.trim()}"</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Matching Documents ({filtered.length})
              </div>

              {filtered.map((doc, idx) => {
                const isSelected = idx === selectedIndex;
                const status = STATUS_CONFIGS[doc.status] || STATUS_CONFIGS.IN_PROGRESS;
                const ws = WORKSPACES.find((w) => w.id === doc.workspaceId);

                return (
                  <button
                    key={doc.id}
                    type="button"
                    onClick={() => {
                      onSelectDocument(doc.id);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-all cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-950 dark:text-indigo-100'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="text-xl shrink-0 p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800">
                        {doc.icon}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs md:text-sm font-semibold truncate">
                            {doc.title}
                          </span>
                          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                          <span>{ws?.name}</span>
                          <span>·</span>
                          <span>{doc.category}</span>
                          {doc.tags.length > 0 && (
                            <>
                              <span>·</span>
                              <span className="text-indigo-500">#{doc.tags[0]}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <ArrowRight className={`w-4 h-4 shrink-0 transition-opacity ${
                      isSelected ? 'opacity-100 text-indigo-600' : 'opacity-0'
                    }`} />
                  </button>
                );
              })}

              {/* Create new document quick option */}
              {query.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    onCreateDocument(query.trim());
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(filtered.length)}
                  className={`w-full flex items-center gap-2.5 p-2.5 rounded-xl text-left transition-all border border-dashed border-indigo-300 dark:border-indigo-800 cursor-pointer ${
                    selectedIndex === filtered.length
                      ? 'bg-indigo-100/60 dark:bg-indigo-950 text-indigo-900 dark:text-indigo-200'
                      : 'hover:bg-indigo-50 dark:hover:bg-indigo-950/30 text-indigo-600 dark:text-indigo-400'
                  }`}
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-xs font-semibold">
                    Create new document: "{query.trim()}"
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer Navigation Help */}
        <div className="px-4 py-2.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-3">
            <span>
              <kbd className="font-semibold text-slate-600 dark:text-slate-300">↑</kbd>{' '}
              <kbd className="font-semibold text-slate-600 dark:text-slate-300">↓</kbd> to select
            </span>
            <span>
              <kbd className="font-semibold text-slate-600 dark:text-slate-300">ENTER</kbd> to open
            </span>
          </div>
          <span>SyncScribe Knowledge Search</span>
        </div>
      </div>
    </div>
  );
};
