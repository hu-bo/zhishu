import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import React, { useState } from 'react';
import { Trash2, Edit2, Check } from 'lucide-react';

function DividerWithLabelComponent({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const currentLabel = node.attrs.label || 'SECTION BREAK';
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(currentLabel);

  const handleSave = () => {
    updateAttributes({ label: editValue.trim() || 'SECTION BREAK' });
    setIsEditing(false);
  };

  return (
    <NodeViewWrapper
      className={`my-8 relative select-none group ${selected ? 'ring-2 ring-indigo-500 rounded-lg p-1' : ''}`}
      data-type="divider-with-label"
    >
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-linear-to-r from-transparent via-slate-300 dark:via-slate-700 to-slate-300 dark:to-slate-700" />
        
        <div className="relative inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-2xs">
          {isEditing ? (
            <div className="flex items-center gap-1" contentEditable={false}>
              <input
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSave();
                  if (e.key === 'Escape') setIsEditing(false);
                }}
                className="bg-white dark:bg-slate-900 border border-indigo-400 rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wider text-slate-800 dark:text-slate-100 uppercase outline-none w-36 text-center"
                autoFocus
              />
              <button
                type="button"
                onClick={handleSave}
                className="p-0.5 rounded text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setEditValue(currentLabel);
                setIsEditing(true);
              }}
              className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 flex items-center gap-1 transition-colors cursor-pointer"
              title="Click to edit section label"
            >
              <span>{currentLabel}</span>
              <Edit2 className="w-2.5 h-2.5 opacity-0 group-hover:opacity-60 transition-opacity" />
            </button>
          )}

          <button
            type="button"
            onClick={deleteNode}
            className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 transition-opacity p-0.5 ml-1"
            title="Delete Section Divider"
            contentEditable={false}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>

        <div className="flex-1 h-px bg-linear-to-l from-transparent via-slate-300 dark:via-slate-700 to-slate-300 dark:to-slate-700" />
      </div>
    </NodeViewWrapper>
  );
}

export const DividerWithLabel = Node.create({
  name: 'dividerWithLabel',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      label: {
        default: 'SECTION BREAK',
        parseHTML: (element) => element.getAttribute('data-label') || 'SECTION BREAK',
        renderHTML: (attributes) => ({
          'data-label': attributes.label,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="divider-with-label"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'divider-with-label' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DividerWithLabelComponent);
  },
});
