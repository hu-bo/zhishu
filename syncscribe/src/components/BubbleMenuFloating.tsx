import React, { useState, useEffect, useRef } from 'react';
import { Editor } from '@tiptap/core';
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Code,
  Highlighter,
  Link as LinkIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  MessageSquarePlus,
  Check,
  X,
  ExternalLink,
} from 'lucide-react';

interface BubbleMenuFloatingProps {
  editor: Editor | null;
}

const HIGHLIGHT_COLORS = [
  { name: 'Yellow', color: '#fef08a' },
  { name: 'Green', color: '#bbf7d0' },
  { name: 'Blue', color: '#bfdbfe' },
  { name: 'Pink', color: '#fbcfe8' },
  { name: 'Purple', color: '#e9d5ff' },
];

export const BubbleMenuFloating: React.FC<BubbleMenuFloatingProps> = ({ editor }) => {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;

    const updateMenu = () => {
      const { state, view } = editor;
      const { selection } = state;

      // Only show if there is non-empty text selection
      if (selection.empty || !view.hasFocus()) {
        setCoords(null);
        setShowColorPicker(false);
        setShowLinkDialog(false);
        return;
      }

      // Calculate position above selection
      try {
        const start = view.coordsAtPos(selection.from);
        const end = view.coordsAtPos(selection.to);
        const editorBox = view.dom.getBoundingClientRect();

        const left = (start.left + end.left) / 2;
        const top = start.top - 50;

        // Ensure inside viewport
        const boundedLeft = Math.max(16, Math.min(window.innerWidth - 360, left - 180));
        const boundedTop = Math.max(10, top);

        setCoords({ top: boundedTop, left: boundedLeft });
      } catch {
        setCoords(null);
      }
    };

    editor.on('selectionUpdate', updateMenu);
    editor.on('blur', updateMenu);

    return () => {
      editor.off('selectionUpdate', updateMenu);
      editor.off('blur', updateMenu);
    };
  }, [editor]);

  if (!editor || !coords) return null;

  const handleSetLink = () => {
    if (!linkUrl) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      let formattedUrl = linkUrl.trim();
      if (!/^https?:\/\//i.test(formattedUrl) && !formattedUrl.startsWith('#')) {
        formattedUrl = `https://${formattedUrl}`;
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: formattedUrl }).run();
    }
    setShowLinkDialog(false);
    setLinkUrl('');
  };

  const handleWrapInCallout = () => {
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    editor
      .chain()
      .focus()
      .deleteRange({ from, to })
      .insertContent({
        type: 'callout',
        attrs: { type: 'tip' },
        content: [{ type: 'paragraph', text: selectedText || 'Highlight insight...' }],
      })
      .run();
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: `${coords.top}px`,
        left: `${coords.left}px`,
      }}
      className="z-40 flex items-center gap-0.5 bg-slate-900 text-white rounded-xl shadow-2xl border border-slate-700 p-1 animate-in fade-in zoom-in-95 duration-100"
    >
      {/* Bold */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={`p-1.5 rounded-lg transition-colors ${
          editor.isActive('bold')
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }`}
        title="Bold (Ctrl+B)"
      >
        <Bold className="w-4 h-4" />
      </button>

      {/* Italic */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={`p-1.5 rounded-lg transition-colors ${
          editor.isActive('italic')
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }`}
        title="Italic (Ctrl+I)"
      >
        <Italic className="w-4 h-4" />
      </button>

      {/* Underline */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={`p-1.5 rounded-lg transition-colors ${
          editor.isActive('underline')
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }`}
        title="Underline (Ctrl+U)"
      >
        <UnderlineIcon className="w-4 h-4" />
      </button>

      {/* Strikethrough */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={`p-1.5 rounded-lg transition-colors ${
          editor.isActive('strike')
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }`}
        title="Strikethrough"
      >
        <Strikethrough className="w-4 h-4" />
      </button>

      {/* Inline Code */}
      <button
        type="button"
        onClick={() => editor.chain().focus().toggleCode().run()}
        className={`p-1.5 rounded-lg transition-colors ${
          editor.isActive('code')
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }`}
        title="Inline Code"
      >
        <Code className="w-4 h-4" />
      </button>

      <div className="w-px h-4 bg-slate-700 mx-1" />

      {/* Highlight Color Picker */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowColorPicker(!showColorPicker)}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('highlight')
              ? 'bg-amber-400 text-slate-900'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
          }`}
          title="Highlight Text"
        >
          <Highlighter className="w-4 h-4" />
        </button>

        {showColorPicker && (
          <div className="absolute left-0 bottom-full mb-2 bg-slate-900 border border-slate-700 rounded-lg p-1.5 shadow-xl flex items-center gap-1 z-50">
            {HIGHLIGHT_COLORS.map((item) => (
              <button
                key={item.color}
                type="button"
                onClick={() => {
                  editor.chain().focus().setHighlight({ color: item.color }).run();
                  setShowColorPicker(false);
                }}
                className="w-5 h-5 rounded-full border border-slate-600 hover:scale-110 transition-transform"
                style={{ backgroundColor: item.color }}
                title={item.name}
              />
            ))}
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().unsetHighlight().run();
                setShowColorPicker(false);
              }}
              className="px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-white hover:bg-slate-800 rounded"
              title="Remove Highlight"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Link Dialog */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            const currentHref = editor.getAttributes('link').href || '';
            setLinkUrl(currentHref);
            setShowLinkDialog(!showLinkDialog);
          }}
          className={`p-1.5 rounded-lg transition-colors ${
            editor.isActive('link')
              ? 'bg-indigo-600 text-white'
              : 'text-slate-300 hover:text-white hover:bg-slate-800'
          }`}
          title="Add / Edit Link"
        >
          <LinkIcon className="w-4 h-4" />
        </button>

        {showLinkDialog && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 w-64 bg-slate-900 border border-slate-700 rounded-xl p-2 shadow-2xl z-50 flex items-center gap-1">
            <input
              type="text"
              placeholder="https://example.com"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSetLink();
                if (e.key === 'Escape') setShowLinkDialog(false);
              }}
              className="flex-1 bg-slate-800 text-xs text-white px-2 py-1 rounded border border-slate-600 outline-none"
              autoFocus
            />
            <button
              type="button"
              onClick={handleSetLink}
              className="p-1 rounded text-emerald-400 hover:bg-emerald-950/60"
              title="Apply Link"
            >
              <Check className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().unsetLink().run();
                setShowLinkDialog(false);
              }}
              className="p-1 rounded text-rose-400 hover:bg-rose-950/60"
              title="Remove Link"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <div className="w-px h-4 bg-slate-700 mx-1" />

      {/* Text Alignment */}
      <button
        type="button"
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        className={`p-1.5 rounded-lg transition-colors ${
          editor.isActive({ textAlign: 'left' })
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
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
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
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
            ? 'bg-indigo-600 text-white'
            : 'text-slate-300 hover:text-white hover:bg-slate-800'
        }`}
        title="Align Right"
      >
        <AlignRight className="w-4 h-4" />
      </button>

      <div className="w-px h-4 bg-slate-700 mx-1" />

      {/* Wrap in Callout */}
      <button
        type="button"
        onClick={handleWrapInCallout}
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
        title="Convert selection to Callout Banner"
      >
        <MessageSquarePlus className="w-3.5 h-3.5 text-indigo-400" />
        <span>Callout</span>
      </button>
    </div>
  );
};
