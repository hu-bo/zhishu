import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewProps } from '@tiptap/react';
import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { StatusType, STATUS_CONFIGS } from '../types/collab';

const ALL_STATUSES: StatusType[] = [
  'IN_PROGRESS',
  'COMPLETED',
  'IN_REVIEW',
  'BLOCKED',
  'TO_DO',
];

function StatusBadgeComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const currentStatus = (node.attrs.status as StatusType) || 'IN_PROGRESS';
  const config = STATUS_CONFIGS[currentStatus] || STATUS_CONFIGS.IN_PROGRESS;
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as HTMLElement)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  return (
    <NodeViewWrapper
      as="span"
      className="inline-flex items-center align-middle mx-1 relative select-none"
      contentEditable={false}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropdownOpen(!dropdownOpen);
        }}
        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-all duration-150 cursor-pointer ${
          config.bg
        } ${config.border} ${config.text} ${
          selected ? 'ring-2 ring-indigo-500 shadow-sm' : 'hover:opacity-90 shadow-2xs'
        }`}
        title="Click to change status"
      >
        {/* Pulsing Dot */}
        <span className="relative flex h-2 w-2">
          <span
            className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${config.dot}`}
          />
          <span className={`relative inline-flex rounded-full h-2 w-2 ${config.dot}`} />
        </span>

        <span>{config.label}</span>
        <ChevronDown className="w-3 h-3 opacity-60 ml-0.5" />
      </button>

      {dropdownOpen && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full mt-1.5 w-44 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
            Change Status
          </div>
          {ALL_STATUSES.map((statusKey) => {
            const item = STATUS_CONFIGS[statusKey];
            const isCurrent = statusKey === currentStatus;
            return (
              <button
                key={statusKey}
                type="button"
                onClick={() => {
                  updateAttributes({ status: statusKey });
                  setDropdownOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
                  isCurrent
                    ? 'bg-slate-100 dark:bg-slate-800 font-semibold text-slate-900 dark:text-slate-100'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${item.dot}`} />
                  <span>{item.label}</span>
                </div>
                {isCurrent && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
              </button>
            );
          })}
        </div>
      )}
    </NodeViewWrapper>
  );
}

export const StatusBadge = Node.create({
  name: 'statusBadge',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      status: {
        default: 'IN_PROGRESS',
        parseHTML: (element) => element.getAttribute('data-status') || 'IN_PROGRESS',
        renderHTML: (attributes) => ({
          'data-status': attributes.status,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="status-badge"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'status-badge' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(StatusBadgeComponent);
  },
});
