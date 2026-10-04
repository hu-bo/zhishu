import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent, NodeViewProps } from '@tiptap/react';
import React, { useState } from 'react';
import { Copy, Check, Code2, Trash2 } from 'lucide-react';

const SUPPORTED_LANGUAGES = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'sql', label: 'SQL' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'bash', label: 'Bash' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'json', label: 'JSON' },
];

function CodeBlockComponent({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const currentLang = node.attrs.language || 'typescript';
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = node.textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <NodeViewWrapper
      className={`my-4 rounded-xl border border-slate-700/80 bg-slate-900 text-slate-100 shadow-md overflow-hidden transition-all duration-150 ${
        selected ? 'ring-2 ring-indigo-500' : ''
      }`}
    >
      {/* Header bar */}
      <div
        className="flex items-center justify-between px-3.5 py-2 bg-slate-800/90 border-b border-slate-700/80 text-xs select-none"
        contentEditable={false}
      >
        <div className="flex items-center gap-2">
          <Code2 className="w-3.5 h-3.5 text-indigo-400" />
          <select
            value={currentLang}
            onChange={(e) => updateAttributes({ language: e.target.value })}
            className="bg-slate-700 hover:bg-slate-650 text-slate-200 border border-slate-600 rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.id} value={lang.id}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors ${
              copied
                ? 'bg-emerald-600/30 text-emerald-300 border border-emerald-500/40'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700'
            }`}
            title="Copy code to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={deleteNode}
            className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-700/80 transition-colors ml-1"
            title="Delete code block"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Code text content */}
      <pre className="p-4 font-mono text-xs md:text-sm text-slate-200 overflow-x-auto leading-relaxed tab-4">
        <NodeViewContent className="outline-none" />
      </pre>
    </NodeViewWrapper>
  );
}

export const CustomCodeBlock = Node.create({
  name: 'customCodeBlock',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  addAttributes() {
    return {
      language: {
        default: 'typescript',
        parseHTML: (element) => element.getAttribute('data-language') || 'typescript',
        renderHTML: (attributes) => ({
          'data-language': attributes.language,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'pre[data-type="custom-code-block"]',
        preserveWhitespace: 'full',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(HTMLAttributes, { 'data-type': 'custom-code-block' }),
      ['code', 0],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockComponent);
  },
});
