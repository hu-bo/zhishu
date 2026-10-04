/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Copy, Check, Terminal } from 'lucide-react';

interface EditorCodeBlockViewProps {
  code: string;
  language: string;
  isReadOnly?: boolean;
  onChangeCode?: (newCode: string) => void;
  onChangeLanguage?: (newLanguage: string) => void;
}

const SUPPORTED_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'sql',
  'json',
  'html',
  'css',
  'bash',
  'yaml',
];

export const EditorCodeBlockView: React.FC<EditorCodeBlockViewProps> = ({
  code,
  language,
  isReadOnly = false,
  onChangeCode,
  onChangeLanguage,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = code.split('\n');

  return (
    <div className="my-4 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900 text-slate-100 text-xs font-mono shadow-xs">
      {/* Code Header: Language & Copy Button */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-950/80 border-b border-slate-800 text-slate-400">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-indigo-400" />
          {isReadOnly ? (
            <span className="text-[11px] font-semibold text-slate-300 uppercase tracking-wider">
              {language || 'text'} <span className="text-[10px] text-slate-500 font-normal">(只读代码块)</span>
            </span>
          ) : (
            <select
              value={language || 'typescript'}
              onChange={(e) => onChangeLanguage?.(e.target.value)}
              className="bg-transparent text-slate-300 font-semibold uppercase text-[11px] tracking-wider outline-none hover:text-white cursor-pointer"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang} value={lang} className="bg-slate-900 text-slate-100">
                  {lang}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Copy button is ALWAYS active, even in read-only and version history preview */}
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          title="复制代码"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-emerald-400 font-sans">已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span className="font-sans">复制</span>
            </>
          )}
        </button>
      </div>

      {/* Code Body with Line Numbers */}
      <div className="flex overflow-x-auto p-3 text-xs leading-relaxed">
        {/* Line numbers */}
        <div className="select-none text-slate-600 text-right pr-3 mr-3 border-r border-slate-800 font-mono text-[11px] shrink-0">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>

        {/* Code Content */}
        <div className="flex-1 min-w-0">
          {isReadOnly ? (
            <pre className="whitespace-pre overflow-x-auto font-mono text-slate-200">
              <code>{code}</code>
            </pre>
          ) : (
            <textarea
              value={code}
              onChange={(e) => onChangeCode?.(e.target.value)}
              rows={Math.max(3, lines.length)}
              className="w-full bg-transparent font-mono text-slate-200 outline-none resize-none overflow-hidden leading-relaxed"
              spellCheck={false}
            />
          )}
        </div>
      </div>
    </div>
  );
};
