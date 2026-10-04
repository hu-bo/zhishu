import React, { useState, useEffect } from 'react';
import {
  ListTree,
  Tag,
  Clock,
  User,
  ExternalLink,
  ChevronRight,
  Shield,
  Layers,
  Sparkles,
  CheckCircle2,
  Bookmark,
  Share2,
  Plus,
  X,
} from 'lucide-react';
import { WikiDocument, OutlineItem } from '../types/knowledge';
import { StatusType, STATUS_CONFIGS } from '../types/collab';

interface TableOfContentsProps {
  currentDoc: WikiDocument;
  onUpdateDoc: (updated: Partial<WikiDocument>) => void;
  outline: OutlineItem[];
  onScrollToHeading: (text: string) => void;
  relatedDocs: WikiDocument[];
  onSelectDoc: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

export const TableOfContents: React.FC<TableOfContentsProps> = ({
  currentDoc,
  onUpdateDoc,
  outline,
  onScrollToHeading,
  relatedDocs,
  onSelectDoc,
  isOpen,
  onClose,
}) => {
  const [activeHeading, setActiveHeading] = useState<string>('');
  const [newTagInput, setNewTagInput] = useState('');
  const [isAddingTag, setIsAddingTag] = useState(false);

  const statusConfig = STATUS_CONFIGS[currentDoc.status] || STATUS_CONFIGS.IN_PROGRESS;

  const handleAddTag = () => {
    const trimmed = newTagInput.trim().replace(/^#/, '');
    if (trimmed && !currentDoc.tags.includes(trimmed)) {
      onUpdateDoc({ tags: [...currentDoc.tags, trimmed] });
      setNewTagInput('');
      setIsAddingTag(false);
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    onUpdateDoc({ tags: currentDoc.tags.filter((t) => t !== tagToRemove) });
  };

  if (!isOpen) return null;

  return (
    <aside className="w-72 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-xs flex flex-col h-full overflow-y-auto select-none transition-all">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <ListTree className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-bold text-slate-800 dark:text-slate-100 uppercase tracking-wider">
            Document Outline
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="Close Outline Drawer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 space-y-6">
        {/* Document Headings Outline (TOC) */}
        <div>
          <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
            Table of Contents
          </div>

          {outline.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-2">
              No headings found. Add H1, H2, or H3 headings to populate the outline.
            </p>
          ) : (
            <div className="space-y-1">
              {outline.map((item, idx) => {
                const isH1 = item.level === 1;
                const isH2 = item.level === 2;
                const isH3 = item.level === 3;

                return (
                  <button
                    key={`${item.text}-${idx}`}
                    type="button"
                    onClick={() => {
                      setActiveHeading(item.text);
                      onScrollToHeading(item.text);
                    }}
                    className={`w-full text-left py-1 text-xs rounded-md transition-all truncate block cursor-pointer ${
                      isH1 ? 'font-semibold' : isH2 ? 'pl-3' : 'pl-6 text-[11px]'
                    } ${
                      activeHeading === item.text
                        ? 'text-indigo-600 dark:text-indigo-400 font-bold bg-indigo-50 dark:bg-indigo-950/40 px-2'
                        : 'text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-300'
                    }`}
                    title={item.text}
                  >
                    {item.text}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Wiki Metadata & Workflow */}
        <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
          <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
            Document Metadata
          </div>

          {/* Workflow Status Dropdown */}
          <div>
            <span className="text-[11px] text-slate-400 block mb-1">Status Workflow</span>
            <select
              value={currentDoc.status}
              onChange={(e) => onUpdateDoc({ status: e.target.value as StatusType })}
              className="w-full text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer"
            >
              <option value="IN_PROGRESS">🟡 In Progress</option>
              <option value="COMPLETED">🟢 Completed</option>
              <option value="IN_REVIEW">🔵 In Review</option>
              <option value="BLOCKED">🔴 Blocked</option>
              <option value="TO_DO">⚪ To Do</option>
            </select>
          </div>

          {/* Author & Timestamp */}
          <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300 pt-1">
            <span className="text-slate-400 flex items-center gap-1">
              <User className="w-3.5 h-3.5" /> Author
            </span>
            <span className="font-semibold">{currentDoc.author}</span>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-300">
            <span className="text-slate-400 flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> Updated
            </span>
            <span className="font-medium text-slate-500">{currentDoc.updatedAt}</span>
          </div>

          {/* Tags */}
          <div className="pt-2">
            <span className="text-[11px] text-slate-400 block mb-1.5">Tags & Classification</span>
            <div className="flex flex-wrap gap-1">
              {currentDoc.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 text-[11px] font-medium"
                >
                  #{tag}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="hover:text-rose-500 transition-colors ml-0.5"
                  >
                    ×
                  </button>
                </span>
              ))}

              {isAddingTag ? (
                <div className="inline-flex items-center gap-1">
                  <input
                    type="text"
                    placeholder="tag"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleAddTag();
                      if (e.key === 'Escape') setIsAddingTag(false);
                    }}
                    className="w-16 px-1.5 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 rounded border border-indigo-400 outline-none"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={handleAddTag}
                    className="text-xs text-indigo-600 font-bold"
                  >
                    +
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsAddingTag(true)}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-dashed border-slate-300 dark:border-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-[10px] cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>Tag</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Related Wiki Documents / Backlinks */}
        {relatedDocs.length > 0 && (
          <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
              Related Documents ({relatedDocs.length})
            </div>
            <div className="space-y-1">
              {relatedDocs.slice(0, 4).map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => onSelectDoc(doc.id)}
                  className="w-full text-left p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 transition-colors cursor-pointer group"
                >
                  <span className="text-sm">{doc.icon}</span>
                  <span className="flex-1 truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400">
                    {doc.title}
                  </span>
                  <ChevronRight className="w-3 h-3 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
