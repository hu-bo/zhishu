import React, { useState } from 'react';
import { Editor } from '@tiptap/core';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  Highlighter,
  AlignLeft,
  AlignCenter,
  AlignRight,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  ChevronDown,
  MessageSquare,
  Tag,
  Code2,
  Minus,
  AtSign,
  Eraser,
  Sparkles,
} from 'lucide-react';
import { CalloutTheme, StatusType, PRESET_COLLABORATORS, CALLOUT_CONFIGS, STATUS_CONFIGS } from '../types/collab';

interface TopToolbarProps {
  editor: Editor | null;
  onOpenSlashPalette?: () => void;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({ editor, onOpenSlashPalette }) => {
  const [calloutMenuOpen, setCalloutMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [codeLangMenuOpen, setCodeLangMenuOpen] = useState(false);

  if (!editor) return null;

  const currentHeading = editor.isActive('heading', { level: 1 })
    ? 'H1'
    : editor.isActive('heading', { level: 2 })
    ? 'H2'
    : editor.isActive('heading', { level: 3 })
    ? 'H3'
    : 'Text';

  return (
    <div className="flex flex-wrap items-center gap-1 px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 select-none">
      {/* Undo / Redo */}
      <div className="flex items-center gap-0.5 mr-1">
        <button
          type="button"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
          title="Redo (Ctrl+Y)"
        >
          <Redo2 className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      {/* Headings Selector */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => editor.chain().focus().setParagraph().run()}
          className={`px-2 py-1 text-xs font-medium rounded-lg transition-colors ${
            editor.isActive('paragraph') && !editor.isActive('heading')
              ? 'bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-semibold'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Normal Text"
        >
          Text
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={`px-2 py-1 text-xs font-bold rounded-lg transition-colors ${
            editor.isActive('heading', { level: 1 })
              ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Heading 1"
        >
          H1
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`px-2 py-1 text-xs font-bold rounded-lg transition-colors ${
            editor.isActive('heading', { level: 2 })
              ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Heading 2"
        >
          H2
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={`px-2 py-1 text-xs font-bold rounded-lg transition-colors ${
            editor.isActive('heading', { level: 3 })
              ? 'bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Heading 3"
        >
          H3
        </button>
      </div>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      {/* Formatting Marks */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('bold')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 font-bold'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Bold (Ctrl+B)"
        >
          <Bold className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('italic')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Italic (Ctrl+I)"
        >
          <Italic className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('underline')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Underline (Ctrl+U)"
        >
          <UnderlineIcon className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('strike')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Strikethrough"
        >
          <Strikethrough className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleCode().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('code')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Inline Code"
        >
          <Code className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('highlight')
              ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Highlight"
        >
          <Highlighter className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      {/* Alignment */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive({ textAlign: 'left' })
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Align Left"
        >
          <AlignLeft className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive({ textAlign: 'center' })
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Align Center"
        >
          <AlignCenter className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive({ textAlign: 'right' })
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Align Right"
        >
          <AlignRight className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      {/* Lists & Quotes */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('taskList')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Collaborative Task Checklist"
        >
          <CheckSquare className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('bulletList')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Bullet List"
        >
          <List className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('orderedList')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Numbered List"
        >
          <ListOrdered className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('blockquote')
              ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400'
              : 'hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
          title="Blockquote"
        >
          <Quote className="w-4 h-4" />
        </button>
      </div>

      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

      {/* Custom Extensions Group */}
      <div className="flex items-center gap-1">
        {/* Callout Menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setCalloutMenuOpen(!calloutMenuOpen);
              setStatusMenuOpen(false);
              setMentionMenuOpen(false);
              setCodeLangMenuOpen(false);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-lg bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 transition-colors cursor-pointer"
            title="Insert Callout Banner"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Callout</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {calloutMenuOpen && (
            <div
              className="absolute left-0 mt-1.5 w-44 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
              onMouseLeave={() => setCalloutMenuOpen(false)}
            >
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Theme
              </div>
              {(['info', 'tip', 'warning', 'success', 'danger'] as CalloutTheme[]).map((theme) => {
                const config = CALLOUT_CONFIGS[theme];
                return (
                  <button
                    key={theme}
                    type="button"
                    onClick={() => {
                      editor.chain().focus().insertContent({
                        type: 'callout',
                        attrs: { type: theme },
                        content: [{ type: 'paragraph', text: `Callout content (${config.title})...` }],
                      }).run();
                      setCalloutMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors"
                  >
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: config.accent }} />
                    <span>{config.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Status Badge Menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setStatusMenuOpen(!statusMenuOpen);
              setCalloutMenuOpen(false);
              setMentionMenuOpen(false);
              setCodeLangMenuOpen(false);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 transition-colors cursor-pointer"
            title="Insert Status Badge"
          >
            <Tag className="w-3.5 h-3.5" />
            <span>Status</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {statusMenuOpen && (
            <div
              className="absolute left-0 mt-1.5 w-44 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
              onMouseLeave={() => setStatusMenuOpen(false)}
            >
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Initial Status
              </div>
              {(['IN_PROGRESS', 'COMPLETED', 'IN_REVIEW', 'BLOCKED', 'TO_DO'] as StatusType[]).map((st) => {
                const config = STATUS_CONFIGS[st];
                return (
                  <button
                    key={st}
                    type="button"
                    onClick={() => {
                      editor.chain().focus().insertContent({
                        type: 'statusBadge',
                        attrs: { status: st },
                      }).insertContent(' ').run();
                      setStatusMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-full ${config.dot}`} />
                    <span>{config.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Code Block Quick Insert */}
        <button
          type="button"
          onClick={() => {
            editor.chain().focus().insertContent({
              type: 'customCodeBlock',
              attrs: { language: 'typescript' },
              content: [{ type: 'text', text: '// Enter syntax code here\nconsole.log("SyncScribe ready");' }],
            }).run();
          }}
          className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          title="Insert Syntax Code Block"
        >
          <Code2 className="w-3.5 h-3.5 text-indigo-500" />
          <span>Code</span>
        </button>

        {/* Section Divider */}
        <button
          type="button"
          onClick={() => {
            editor.chain().focus().insertContent({
              type: 'dividerWithLabel',
              attrs: { label: 'SECTION TITLE' },
            }).run();
          }}
          className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          title="Insert Section Divider with Label"
        >
          <Minus className="w-3.5 h-3.5" />
          <span>Divider</span>
        </button>

        {/* Mention Teammate */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setMentionMenuOpen(!mentionMenuOpen);
              setCalloutMenuOpen(false);
              setStatusMenuOpen(false);
              setCodeLangMenuOpen(false);
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-lg bg-purple-50 dark:bg-purple-950/50 text-purple-700 dark:text-purple-300 hover:bg-purple-100 transition-colors cursor-pointer"
            title="Mention Teammate"
          >
            <AtSign className="w-3.5 h-3.5" />
            <span>@Mention</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {mentionMenuOpen && (
            <div
              className="absolute right-0 mt-1.5 w-48 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
              onMouseLeave={() => setMentionMenuOpen(false)}
            >
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Select Peer
              </div>
              {PRESET_COLLABORATORS.map((collab) => (
                <button
                  key={collab.id}
                  type="button"
                  onClick={() => {
                    editor.chain().focus().insertContent({
                      type: 'collaboratorMention',
                      attrs: {
                        id: collab.id,
                        name: collab.name,
                        color: collab.color,
                        role: collab.role,
                      },
                    }).insertContent(' ').run();
                    setMentionMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/80 transition-colors"
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: collab.color }}
                  />
                  <div className="flex-1 truncate">
                    <div className="font-semibold">{collab.name}</div>
                    <div className="text-[10px] text-slate-400">{collab.role}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {/* Slash Command trigger hint */}
        {onOpenSlashPalette && (
          <button
            type="button"
            onClick={onOpenSlashPalette}
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
            title="Open Slash Command Palette"
          >
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded font-bold">
              /
            </kbd>
            <span className="hidden sm:inline text-xs">Commands</span>
          </button>
        )}

        {/* Clear formatting */}
        <button
          type="button"
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          title="Clear Formatting"
        >
          <Eraser className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
