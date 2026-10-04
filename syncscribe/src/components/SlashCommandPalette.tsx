import React, { useState, useEffect, useRef } from 'react';
import { Editor } from '@tiptap/core';
import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Code2,
  AlertCircle,
  Tag,
  AtSign,
  Minus,
  Search,
  Sparkles,
} from 'lucide-react';
import { PRESET_COLLABORATORS, StatusType, CalloutTheme } from '../types/collab';

export interface CommandItem {
  id: string;
  title: string;
  description: string;
  category: 'Custom Blocks' | 'Basic Blocks' | 'Lists & Quotes';
  icon: React.ComponentType<{ className?: string }>;
  action: (editor: Editor) => void;
  keywords?: string[];
}

interface SlashCommandPaletteProps {
  editor: Editor | null;
  isOpen: boolean;
  onClose: () => void;
  position?: { top: number; left: number } | null;
}

export const SlashCommandPalette: React.FC<SlashCommandPaletteProps> = ({
  editor,
  isOpen,
  onClose,
  position,
}) => {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const commands: CommandItem[] = [
    // Custom Blocks
    {
      id: 'callout-info',
      title: 'Callout Banner (Info)',
      description: 'Highlight key information with an informational banner',
      category: 'Custom Blocks',
      icon: AlertCircle,
      action: (ed) => {
        ed.chain().focus().insertContent({
          type: 'callout',
          attrs: { type: 'info' as CalloutTheme },
          content: [{ type: 'paragraph', text: 'Important note for teammates...' }],
        }).run();
      },
      keywords: ['callout', 'info', 'alert', 'box', 'note'],
    },
    {
      id: 'callout-tip',
      title: 'Callout Banner (Pro Tip)',
      description: 'Highlight best practices and advice',
      category: 'Custom Blocks',
      icon: Sparkles,
      action: (ed) => {
        ed.chain().focus().insertContent({
          type: 'callout',
          attrs: { type: 'tip' as CalloutTheme },
          content: [{ type: 'paragraph', text: 'Pro Tip: Always verify before deploying.' }],
        }).run();
      },
      keywords: ['callout', 'tip', 'advice', 'sparkle'],
    },
    {
      id: 'status-badge',
      title: 'Interactive Status Badge',
      description: 'Pulsing pill to cycle In Progress, Completed, In Review...',
      category: 'Custom Blocks',
      icon: Tag,
      action: (ed) => {
        ed.chain().focus().insertContent({
          type: 'statusBadge',
          attrs: { status: 'IN_PROGRESS' as StatusType },
        }).insertContent(' ').run();
      },
      keywords: ['status', 'badge', 'progress', 'tag', 'pill'],
    },
    {
      id: 'code-block',
      title: 'Syntax Code Block',
      description: 'Preformatted code block with language switcher & copy',
      category: 'Custom Blocks',
      icon: Code2,
      action: (ed) => {
        ed.chain().focus().insertContent({
          type: 'customCodeBlock',
          attrs: { language: 'typescript' },
          content: [{ type: 'text', text: '// Enter your code snippet here\nconst result = await fetchSync();' }],
        }).run();
      },
      keywords: ['code', 'syntax', 'snippet', 'typescript', 'pre'],
    },
    {
      id: 'divider-labeled',
      title: 'Section Divider with Label',
      description: 'Horizontal rule with an editable uppercase section title',
      category: 'Custom Blocks',
      icon: Minus,
      action: (ed) => {
        ed.chain().focus().insertContent({
          type: 'dividerWithLabel',
          attrs: { label: 'NEW SECTION' },
        }).run();
      },
      keywords: ['divider', 'line', 'hr', 'section', 'separator'],
    },
    {
      id: 'mention-collab',
      title: 'Teammate Mention (@)',
      description: 'Mention a collaborator with color-matched pill and role',
      category: 'Custom Blocks',
      icon: AtSign,
      action: (ed) => {
        const collab = PRESET_COLLABORATORS[0];
        ed.chain().focus().insertContent({
          type: 'collaboratorMention',
          attrs: {
            id: collab.id,
            name: collab.name,
            color: collab.color,
            role: collab.role,
          },
        }).insertContent(' ').run();
      },
      keywords: ['mention', 'user', 'collaborator', 'team', 'person'],
    },

    // Basic Blocks
    {
      id: 'heading-1',
      title: 'Heading 1',
      description: 'Top-level document title',
      category: 'Basic Blocks',
      icon: Heading1,
      action: (ed) => {
        ed.chain().focus().toggleHeading({ level: 1 }).run();
      },
      keywords: ['h1', 'title', 'heading', 'large'],
    },
    {
      id: 'heading-2',
      title: 'Heading 2',
      description: 'Key section heading',
      category: 'Basic Blocks',
      icon: Heading2,
      action: (ed) => {
        ed.chain().focus().toggleHeading({ level: 2 }).run();
      },
      keywords: ['h2', 'section', 'subtitle'],
    },
    {
      id: 'heading-3',
      title: 'Heading 3',
      description: 'Sub-section header',
      category: 'Basic Blocks',
      icon: Heading3,
      action: (ed) => {
        ed.chain().focus().toggleHeading({ level: 3 }).run();
      },
      keywords: ['h3', 'subheading'],
    },

    // Lists & Quotes
    {
      id: 'task-list',
      title: 'Task Checklist',
      description: 'Interactive checklist synced collaboratively across peers',
      category: 'Lists & Quotes',
      icon: CheckSquare,
      action: (ed) => {
        ed.chain().focus().toggleTaskList().run();
      },
      keywords: ['todo', 'task', 'checklist', 'checkbox'],
    },
    {
      id: 'bullet-list',
      title: 'Bullet List',
      description: 'Unordered bullet point list',
      category: 'Lists & Quotes',
      icon: List,
      action: (ed) => {
        ed.chain().focus().toggleBulletList().run();
      },
      keywords: ['bullet', 'list', 'ul'],
    },
    {
      id: 'numbered-list',
      title: 'Numbered List',
      description: 'Ordered sequential list',
      category: 'Lists & Quotes',
      icon: ListOrdered,
      action: (ed) => {
        ed.chain().focus().toggleOrderedList().run();
      },
      keywords: ['numbered', 'order', 'ol', '123'],
    },
    {
      id: 'blockquote',
      title: 'Blockquote',
      description: 'Highlight an important quote or callout text',
      category: 'Lists & Quotes',
      icon: Quote,
      action: (ed) => {
        ed.chain().focus().toggleBlockquote().run();
      },
      keywords: ['quote', 'blockquote', 'cite'],
    },
  ];

  const filtered = commands.filter((cmd) => {
    if (!search.trim()) return true;
    const query = search.toLowerCase();
    return (
      cmd.title.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query) ||
      cmd.category.toLowerCase().includes(query) ||
      cmd.keywords?.some((k) => k.toLowerCase().includes(query))
    );
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex] && editor) {
          filtered[selectedIndex].action(editor);
          onClose();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, filtered, editor, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/20 backdrop-blur-2xs"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
        style={
          position
            ? {
                position: 'absolute',
                top: Math.min(position.top, window.innerHeight - 400),
                left: Math.min(position.left, window.innerWidth - 500),
              }
            : undefined
        }
      >
        {/* Search header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command or search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-200 dark:bg-slate-800 text-slate-500 rounded">
            ESC
          </kbd>
        </div>

        {/* Command list */}
        <div className="max-h-80 overflow-y-auto p-2 divide-y divide-slate-100 dark:divide-slate-800/60">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">
              No matching commands found for "{search}"
            </div>
          ) : (
            <div>
              {filtered.map((item, index) => {
                const Icon = item.icon;
                const isSelected = index === selectedIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (editor) {
                        item.action(editor);
                        onClose();
                      }
                    }}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div
                      className={`p-2 rounded-lg border transition-colors ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-600'
                          : 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold flex items-center justify-between">
                        <span>{item.title}</span>
                        <span className="text-[10px] uppercase tracking-wider text-slate-400 font-normal">
                          {item.category}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400 truncate mt-0.5">
                        {item.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer shortcuts hint */}
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 flex items-center justify-between text-[11px] text-slate-400">
          <span>
            Use <kbd className="font-semibold text-slate-600 dark:text-slate-300">↑</kbd>{' '}
            <kbd className="font-semibold text-slate-600 dark:text-slate-300">↓</kbd> to navigate
          </span>
          <span>
            Press <kbd className="font-semibold text-slate-600 dark:text-slate-300">ENTER</kbd> to select
          </span>
        </div>
      </div>
    </div>
  );
};
