/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  MessageSquare,
  X,
  Send,
  CheckCircle,
  AlertTriangle,
  AtSign,
  CornerDownRight,
} from 'lucide-react';
import { CommentThread, CurrentUser } from '../../types/document';
import { storageService, MOCK_USERS } from '../../services/storage';

interface CommentsPanelProps {
  documentId: string;
  isOpen: boolean;
  onClose?: () => void;
  isDrawer?: boolean;
  currentUser: CurrentUser;
}

export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  documentId,
  isOpen,
  onClose,
  isDrawer = false,
  currentUser,
}) => {
  const [threads, setThreads] = useState<CommentThread[]>(() =>
    storageService.getComments(documentId)
  );
  const [newCommentInput, setNewCommentInput] = useState('');
  const [replyInput, setReplyInput] = useState<Record<string, string>>({});
  const [mentionSuggestionsOpen, setMentionSuggestionsOpen] = useState(false);

  if (!isOpen) return null;

  const refreshThreads = () => {
    setThreads(storageService.getComments(documentId));
  };

  const handleCreateThread = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCommentInput.trim()) return;

    // Detect @mentions
    const mentions = Object.values(MOCK_USERS)
      .filter((u) => newCommentInput.includes(`@${u.name.split(' ')[0]}`))
      .map((u) => u.id);

    storageService.addCommentThread(documentId, {
      blockId: null,
      content: newCommentInput.trim(),
      mentions,
    });

    setNewCommentInput('');
    refreshThreads();
  };

  const handleReply = (threadId: string) => {
    const text = replyInput[threadId];
    if (!text || !text.trim()) return;

    storageService.replyComment(threadId, text.trim());
    setReplyInput((prev) => ({ ...prev, [threadId]: '' }));
    refreshThreads();
  };

  const handleToggleStatus = (threadId: string) => {
    storageService.toggleThreadStatus(threadId);
    refreshThreads();
  };

  return (
    <div
      className={`${
        isDrawer
          ? 'fixed inset-y-0 right-0 z-40 w-80 bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800'
          : 'w-80 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 shrink-0 sticky top-14 h-[calc(100vh-56px)] overflow-y-auto no-print'
      } flex flex-col`}
    >
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            文档讨论与批注 (Comments)
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Threads List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {threads.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            暂无批注讨论。可随时在正文或下方发表全局批注。
          </div>
        ) : (
          threads.map((thread) => {
            const isResolved = thread.status === 'resolved';

            return (
              <div
                key={thread.id}
                className={`p-3 rounded-lg border transition-all text-xs space-y-2.5 ${
                  isResolved
                    ? 'bg-slate-50/60 dark:bg-slate-800/40 border-slate-200 dark:border-slate-800 opacity-75'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 shadow-xs'
                }`}
              >
                {/* Quoted Text if any */}
                {thread.quotedText && (
                  <div className="border-l-2 border-indigo-400 pl-2 text-[11px] text-slate-500 italic bg-slate-50 dark:bg-slate-800/40 py-1 rounded-r">
                    "{thread.quotedText}"
                  </div>
                )}

                {/* Target Invalidation Alert if block was deleted */}
                {thread.isTargetInvalidated && (
                  <div className="flex items-center gap-1.5 p-1.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 rounded text-[10px] text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>原批注锚点正文已被删除，讨论上下文已解挂</span>
                  </div>
                )}

                {/* Thread Comments */}
                <div className="space-y-2 divide-y divide-slate-100 dark:divide-slate-800/60">
                  {thread.comments.map((c, idx) => (
                    <div key={c.id} className={idx > 0 ? 'pt-2' : ''}>
                      <div className="flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <img
                            src={c.author.avatar}
                            alt={c.author.name}
                            className="w-5 h-5 rounded-full object-cover"
                          />
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            {c.author.name}
                          </span>
                        </div>
                        <span className="text-[10px] text-slate-400">
                          {new Date(c.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="mt-1 text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap pl-6">
                        {c.content}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Resolve button & Reply input */}
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <button
                    onClick={() => handleToggleStatus(thread.id)}
                    className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400"
                  >
                    <CheckCircle className={`w-3.5 h-3.5 ${isResolved ? 'text-emerald-500' : ''}`} />
                    <span>{isResolved ? '重新开启此讨论' : '标记已解决'}</span>
                  </button>
                </div>

                {!isResolved && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="text"
                      placeholder="回复批注..."
                      value={replyInput[thread.id] || ''}
                      onChange={(e) =>
                        setReplyInput((prev) => ({ ...prev, [thread.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleReply(thread.id);
                      }}
                      className="flex-1 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <button
                      onClick={() => handleReply(thread.id)}
                      className="p-1.5 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-800 rounded-md"
                      title="发送回复"
                    >
                      <CornerDownRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Create New Comment Bar */}
      <div className="p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90">
        <form onSubmit={handleCreateThread} className="space-y-2">
          <div className="relative">
            <textarea
              rows={2}
              value={newCommentInput}
              onChange={(e) => setNewCommentInput(e.target.value)}
              placeholder="添加批注评论... 支持 @成员 提及"
              className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-2 text-xs outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
            />
          </div>

          <div className="flex items-center justify-between">
            {/* Mention quick buttons */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-slate-400">快捷提及:</span>
              {Object.values(MOCK_USERS).map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() =>
                    setNewCommentInput((prev) => `${prev} @${user.name.split(' ')[0]} `)
                  }
                  className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  @{user.name.split(' ')[0]}
                </button>
              ))}
            </div>

            <button
              type="submit"
              disabled={!newCommentInput.trim()}
              className="flex items-center gap-1 px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-medium rounded-md shadow-xs transition-colors"
            >
              <Send className="w-3 h-3" />
              <span>发表</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
