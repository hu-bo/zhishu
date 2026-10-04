/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect } from 'react';
import {
  DocumentBlock,
  BlockType,
  InlineSpan,
} from '../../types/document';
import { EditorCodeBlockView } from './EditorCodeBlockView';
import { EditorImageBlock } from './EditorImageBlock';
import { EditorPdfBlock } from './EditorPdfBlock';
import {
  Plus,
  Trash2,
  GripVertical,
  CheckSquare,
  Square,
  Info,
  AlertTriangle,
  Lightbulb,
  Quote,
  MessageSquarePlus,
} from 'lucide-react';

interface EditorSurfaceProps {
  blocks: DocumentBlock[];
  isReadOnly?: boolean;
  searchQuery?: string;
  currentMatchIndex?: number;
  onUpdateBlock: (id: string, updates: Partial<DocumentBlock>) => void;
  onDeleteBlock: (id: string) => void;
  onInsertBlockAfter: (afterId: string, type: BlockType) => void;
  onAddCommentOnBlock?: (blockId: string, quote?: string) => void;
}

export const EditorSurface: React.FC<EditorSurfaceProps> = ({
  blocks,
  isReadOnly = false,
  searchQuery = '',
  currentMatchIndex = 0,
  onUpdateBlock,
  onDeleteBlock,
  onInsertBlockAfter,
  onAddCommentOnBlock,
}) => {
  // Highlight search text helper (case-insensitive)
  const renderHighlightedText = (text: string) => {
    if (!searchQuery || !searchQuery.trim()) return text;

    const regex = new RegExp(`(${searchQuery.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);

    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark
          key={i}
          className="bg-amber-200 dark:bg-amber-900/60 text-slate-900 dark:text-amber-100 rounded-xs px-0.5"
        >
          {part}
        </mark>
      ) : (
        part
      )
    );
  };

  return (
    <div className="space-y-4 text-slate-800 dark:text-slate-200 font-sans text-base leading-relaxed">
      {blocks.map((block, index) => {
        const isHeading = block.type === 'heading';

        return (
          <div
            key={block.id}
            id={isHeading ? `heading-${block.id}` : `block-${block.id}`}
            data-block-id={block.id}
            className="group relative -mx-4 px-4 py-1.5 rounded-lg transition-colors hover:bg-slate-50/50 dark:hover:bg-slate-800/20"
          >
            {/* Left Block Operations Hover Bar (Desktop) */}
            {!isReadOnly && (
              <div className="absolute -left-7 top-2 hidden sm:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => onInsertBlockAfter(block.id, 'paragraph')}
                  className="p-1 text-slate-400 hover:text-indigo-600 rounded hover:bg-slate-200/60"
                  title="在下方插入新块"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {onAddCommentOnBlock && (
                  <button
                    type="button"
                    onClick={() => onAddCommentOnBlock(block.id, block.text)}
                    className="p-1 text-slate-400 hover:text-amber-600 rounded hover:bg-slate-200/60"
                    title="对此块添加评论"
                  >
                    <MessageSquarePlus className="w-3.5 h-3.5" />
                  </button>
                )}
                {blocks.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onDeleteBlock(block.id)}
                    className="p-1 text-slate-400 hover:text-rose-600 rounded hover:bg-slate-200/60"
                    title="删除此块"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Block Type Renderers */}
            {block.type === 'heading' && (
              <div className="font-semibold tracking-tight text-slate-900 dark:text-white">
                {block.headingLevel === 1 && (
                  isReadOnly ? (
                    <h1 className="text-2xl sm:text-3xl font-bold py-2 border-b border-slate-100 dark:border-slate-800">
                      {renderHighlightedText(block.text || '')}
                    </h1>
                  ) : (
                    <input
                      type="text"
                      value={block.text || ''}
                      onChange={(e) => onUpdateBlock(block.id, { text: e.target.value })}
                      placeholder="1 级标题..."
                      className="w-full text-2xl sm:text-3xl font-bold py-2 bg-transparent outline-none border-b border-slate-100 dark:border-slate-800"
                    />
                  )
                )}

                {block.headingLevel === 2 && (
                  isReadOnly ? (
                    <h2 className="text-xl sm:text-2xl font-semibold mt-4 mb-2">
                      {renderHighlightedText(block.text || '')}
                    </h2>
                  ) : (
                    <input
                      type="text"
                      value={block.text || ''}
                      onChange={(e) => onUpdateBlock(block.id, { text: e.target.value })}
                      placeholder="2 级标题..."
                      className="w-full text-xl sm:text-2xl font-semibold mt-4 mb-2 bg-transparent outline-none"
                    />
                  )
                )}

                {block.headingLevel === 3 && (
                  isReadOnly ? (
                    <h3 className="text-lg font-semibold mt-3 mb-1 text-slate-800 dark:text-slate-100">
                      {renderHighlightedText(block.text || '')}
                    </h3>
                  ) : (
                    <input
                      type="text"
                      value={block.text || ''}
                      onChange={(e) => onUpdateBlock(block.id, { text: e.target.value })}
                      placeholder="3 级标题..."
                      className="w-full text-lg font-semibold mt-3 mb-1 bg-transparent outline-none text-slate-800 dark:text-slate-100"
                    />
                  )
                )}
              </div>
            )}

            {block.type === 'paragraph' && (
              isReadOnly ? (
                <p className="text-base leading-relaxed text-slate-700 dark:text-slate-300">
                  {renderHighlightedText(block.text || '')}
                </p>
              ) : (
                <textarea
                  value={block.text || ''}
                  onChange={(e) => onUpdateBlock(block.id, { text: e.target.value })}
                  placeholder="输入正文内容..."
                  rows={Math.max(1, Math.ceil((block.text?.length || 0) / 45))}
                  className="w-full bg-transparent text-base leading-relaxed text-slate-700 dark:text-slate-300 outline-none resize-none overflow-hidden"
                />
              )
            )}

            {block.type === 'bullet-list' && (
              <div className="space-y-1 my-1">
                {(block.listItems || ['无序列表示例项']).map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 dark:bg-indigo-400 mt-2.5 shrink-0" />
                    {isReadOnly ? (
                      <span className="text-sm leading-relaxed">{renderHighlightedText(item)}</span>
                    ) : (
                      <input
                        type="text"
                        value={item}
                        onChange={(e) => {
                          const updated = [...(block.listItems || [])];
                          updated[i] = e.target.value;
                          onUpdateBlock(block.id, { listItems: updated });
                        }}
                        className="flex-1 bg-transparent text-sm leading-relaxed outline-none"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {block.type === 'ordered-list' && (
              <div className="space-y-1 my-1">
                {(block.listItems || ['有序列表示例项']).map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className="font-mono text-xs font-semibold text-slate-500 mt-0.5 shrink-0 select-none">
                      {i + 1}.
                    </span>
                    {isReadOnly ? (
                      <span className="text-sm leading-relaxed">{renderHighlightedText(item)}</span>
                    ) : (
                      <input
                        type="text"
                        value={item}
                        onChange={(e) => {
                          const updated = [...(block.listItems || [])];
                          updated[i] = e.target.value;
                          onUpdateBlock(block.id, { listItems: updated });
                        }}
                        className="flex-1 bg-transparent text-sm leading-relaxed outline-none"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {block.type === 'task-list' && (
              <div className="space-y-1.5 my-1">
                {(block.taskItems || [{ id: 't-1', text: '完成系统架构走查', completed: false }]).map((task, i) => (
                  <div key={task.id || i} className="flex items-start gap-2.5">
                    <button
                      type="button"
                      disabled={isReadOnly}
                      onClick={() => {
                        const updated = (block.taskItems || []).map((t, idx) =>
                          idx === i ? { ...t, completed: !t.completed } : t
                        );
                        onUpdateBlock(block.id, { taskItems: updated });
                      }}
                      className="mt-1 text-indigo-600 dark:text-indigo-400 focus:outline-none"
                    >
                      {task.completed ? (
                        <CheckSquare className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <Square className="w-4 h-4 text-slate-400 hover:text-indigo-600" />
                      )}
                    </button>
                    {isReadOnly ? (
                      <span className={`text-sm leading-relaxed ${task.completed ? 'line-through text-slate-400' : ''}`}>
                        {renderHighlightedText(task.text)}
                      </span>
                    ) : (
                      <input
                        type="text"
                        value={task.text}
                        onChange={(e) => {
                          const updated = (block.taskItems || []).map((t, idx) =>
                            idx === i ? { ...t, text: e.target.value } : t
                          );
                          onUpdateBlock(block.id, { taskItems: updated });
                        }}
                        className={`flex-1 bg-transparent text-sm leading-relaxed outline-none ${
                          task.completed ? 'line-through text-slate-400' : ''
                        }`}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Code Block with EditorCodeBlockView */}
            {block.type === 'code' && (
              <EditorCodeBlockView
                code={block.codeContent || '// 编写代码或配置规约\nconsole.log("Hello Zhishu");'}
                language={block.codeLanguage || 'typescript'}
                isReadOnly={isReadOnly}
                onChangeCode={(newCode) => onUpdateBlock(block.id, { codeContent: newCode })}
                onChangeLanguage={(newLang) => onUpdateBlock(block.id, { codeLanguage: newLang })}
              />
            )}

            {/* Callout / Quote */}
            {block.type === 'callout' && (
              <div
                className={`p-3.5 my-2 rounded-lg border flex items-start gap-3 text-xs leading-relaxed ${
                  block.calloutVariant === 'warning'
                    ? 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60 text-amber-900 dark:text-amber-200'
                    : block.calloutVariant === 'tip'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-900/60 text-emerald-900 dark:text-emerald-200'
                    : 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-900/60 text-indigo-900 dark:text-indigo-200'
                }`}
              >
                <div className="shrink-0 mt-0.5">
                  {block.calloutVariant === 'warning' ? (
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                  ) : block.calloutVariant === 'tip' ? (
                    <Lightbulb className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Info className="w-4 h-4 text-indigo-600" />
                  )}
                </div>
                {isReadOnly ? (
                  <div className="flex-1">{renderHighlightedText(block.calloutContent || '')}</div>
                ) : (
                  <textarea
                    rows={2}
                    value={block.calloutContent || ''}
                    onChange={(e) => onUpdateBlock(block.id, { calloutContent: e.target.value })}
                    className="flex-1 bg-transparent outline-none resize-none"
                    placeholder="输入提示或引用说明..."
                  />
                )}
              </div>
            )}

            {/* Table Block */}
            {block.type === 'table' && (
              <div className="my-3 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 font-semibold border-b border-slate-200 dark:border-slate-700">
                    <tr>
                      {(block.tableHeaders || ['列 1', '列 2', '列 3']).map((header, colIdx) => (
                        <th key={colIdx} className="p-2.5 font-medium border-r border-slate-200 dark:border-slate-700 last:border-r-0">
                          {isReadOnly ? (
                            header
                          ) : (
                            <input
                              type="text"
                              value={header}
                              onChange={(e) => {
                                const newHeaders = [...(block.tableHeaders || [])];
                                newHeaders[colIdx] = e.target.value;
                                onUpdateBlock(block.id, { tableHeaders: newHeaders });
                              }}
                              className="w-full bg-transparent font-medium outline-none"
                            />
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 bg-white dark:bg-slate-900">
                    {(block.tableRows || [['数据 A', '数据 B', '数据 C']]).map((row, rowIdx) => (
                      <tr key={rowIdx} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        {row.map((cell, colIdx) => (
                          <td key={colIdx} className="p-2.5 border-r border-slate-100 dark:border-slate-800 last:border-r-0">
                            {isReadOnly ? (
                              renderHighlightedText(cell)
                            ) : (
                              <input
                                type="text"
                                value={cell}
                                onChange={(e) => {
                                  const newRows = [...(block.tableRows || [])];
                                  newRows[rowIdx][colIdx] = e.target.value;
                                  onUpdateBlock(block.id, { tableRows: newRows });
                                }}
                                className="w-full bg-transparent outline-none"
                              />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Image Block */}
            {block.type === 'image' && (
              <EditorImageBlock
                assetId={block.assetId}
                imageAlt={block.imageAlt}
                imageWidth={block.imageWidth}
                imageHeight={block.imageHeight}
                signedAuthUrl={block.signedAuthUrl}
                isReadOnly={isReadOnly}
                onUpdateProps={(props) => onUpdateBlock(block.id, props)}
                onDeleteBlock={() => onDeleteBlock(block.id)}
              />
            )}

            {/* PDF Block */}
            {block.type === 'pdf' && (
              <EditorPdfBlock
                assetId={block.assetId}
                pdfFilename={block.pdfFilename}
                pdfFileSize={block.pdfFileSize}
                pdfPageCount={block.pdfPageCount}
                signedAuthUrl={block.signedAuthUrl}
                isReadOnly={isReadOnly}
                onDeleteBlock={() => onDeleteBlock(block.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
