import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import React, { useState } from 'react';
import { UserCheck } from 'lucide-react';

function CollaboratorMentionComponent({ node, selected }: NodeViewProps) {
  const { name, color, role } = node.attrs;
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <NodeViewWrapper
      as="span"
      className="inline-flex items-center align-middle mx-1 relative select-none"
      contentEditable={false}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-all cursor-pointer ${
          selected ? 'ring-2 ring-indigo-500 shadow-xs' : 'hover:brightness-95'
        }`}
        style={{
          backgroundColor: `${color}18`,
          borderColor: `${color}40`,
          color: color,
        }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="font-semibold">@{name || 'teammate'}</span>
      </span>

      {showTooltip && (
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] whitespace-nowrap shadow-xl z-50 pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex items-center gap-1.5"
        >
          <UserCheck className="w-3 h-3 text-emerald-400" />
          <span>{name}</span>
          {role && <span className="text-slate-400 font-normal">· {role}</span>}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const CollaboratorMention = Node.create({
  name: 'collaboratorMention',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-id') || '',
        renderHTML: (attributes) => ({
          'data-id': attributes.id,
        }),
      },
      name: {
        default: 'Teammate',
        parseHTML: (element) => element.getAttribute('data-name') || 'Teammate',
        renderHTML: (attributes) => ({
          'data-name': attributes.name,
        }),
      },
      color: {
        default: '#3b82f6',
        parseHTML: (element) => element.getAttribute('data-color') || '#3b82f6',
        renderHTML: (attributes) => ({
          'data-color': attributes.color,
        }),
      },
      role: {
        default: 'Collaborator',
        parseHTML: (element) => element.getAttribute('data-role') || 'Collaborator',
        renderHTML: (attributes) => ({
          'data-role': attributes.role,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="collaborator-mention"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-type': 'collaborator-mention' }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CollaboratorMentionComponent);
  },
});
