import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, NodeViewProps } from '@tiptap/react';
import React, { useState } from 'react';
import { 
  Info, 
  Sparkles, 
  AlertTriangle, 
  CheckCircle2, 
  Flame, 
  Trash2, 
  ChevronDown 
} from 'lucide-react';
import { CalloutTheme, CALLOUT_CONFIGS } from '../types/collab';

const THEME_ICONS: Record<CalloutTheme, React.ComponentType<{ className?: string }>> = {
  info: Info,
  tip: Sparkles,
  warning: AlertTriangle,
  success: CheckCircle2,
  danger: Flame,
};

const THEMES: CalloutTheme[] = ['info', 'tip', 'warning', 'success', 'danger'];

function CalloutComponent({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const currentTheme = (node.attrs.type as CalloutTheme) || 'info';
  const config = CALLOUT_CONFIGS[currentTheme] || CALLOUT_CONFIGS.info;
  const IconComponent = THEME_ICONS[currentTheme] || Info;
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <NodeViewWrapper
      className={`my-4 relative rounded-xl border p-4 transition-all duration-150 ${config.bg} ${config.border} ${
        selected ? 'ring-2 ring-indigo-500 shadow-md' : 'shadow-xs hover:shadow-sm'
      }`}
      data-type="callout"
    >
      {/* Top action bar: theme switcher & delete */}
      <div
        className="flex items-center justify-between pb-2 mb-2 border-b border-black/5 dark:border-white/10 select-none"
        contentEditable={false}
      >
        <div className="relative inline-block text-left">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: config.accent }}
            title="Change Callout Theme"
          >
            <div className={`p-1 rounded-full ${config.iconBg}`}>
              <IconComponent className="w-3.5 h-3.5" />
            </div>
            <span>{config.title}</span>
            <ChevronDown className="w-3 h-3 opacity-60" />
          </button>

          {menuOpen && (
            <div
              className="absolute left-0 mt-1 w-44 rounded-lg bg-white dark:bg-slate-900 shadow-xl border border-slate-200 dark:border-slate-800 py-1.5 z-30 animate-in fade-in zoom-in-95 duration-100"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <div className="px-3 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Theme Preset
              </div>
              {THEMES.map((theme) => {
                const itemConfig = CALLOUT_CONFIGS[theme];
                const ItemIcon = THEME_ICONS[theme];
                const isActive = theme === currentTheme;
                return (
                  <button
                    key={theme}
                    type="button"
                    onClick={() => {
                      updateAttributes({ type: theme });
                      setMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left transition-colors ${
                      isActive
                        ? 'bg-slate-100 dark:bg-slate-800 font-semibold text-slate-900 dark:text-slate-100'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/60'
                    }`}
                  >
                    <div className={`p-1 rounded-full ${itemConfig.iconBg}`}>
                      <ItemIcon className="w-3 h-3" />
                    </div>
                    <span>{itemConfig.title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={deleteNode}
          className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
          title="Delete Callout"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Editable Content */}
      <NodeViewContent className="callout-body prose prose-slate max-w-none text-slate-800 dark:text-slate-200 text-sm leading-relaxed outline-none" />
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (element) => element.getAttribute('data-callout-type') || 'info',
        renderHTML: (attributes) => ({
          'data-callout-type': attributes.type,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutComponent);
  },
});
