/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Bell,
  X,
  CheckCheck,
  ExternalLink,
  MessageSquare,
  Clock,
  AtSign,
} from 'lucide-react';
import { MentionNotification, CurrentUser } from '../../types/document';
import { storageService } from '../../services/storage';

interface NotificationCenterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: CurrentUser;
  onSelectDocument: (docId: string) => void;
  onNotificationsChanged: () => void;
}

export const NotificationCenterDialog: React.FC<NotificationCenterDialogProps> = ({
  isOpen,
  onClose,
  currentUser,
  onSelectDocument,
  onNotificationsChanged,
}) => {
  if (!isOpen) return null;

  const notifications = storageService.getNotifications(currentUser.id);
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const handleMarkAsRead = (id: string, docId: string) => {
    storageService.markNotificationAsRead(id);
    onNotificationsChanged();
    onSelectDocument(docId);
    onClose();
  };

  const handleMarkAllAsRead = () => {
    storageService.markAllNotificationsAsRead(currentUser.id);
    onNotificationsChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end p-4 sm:p-6 bg-slate-900/30 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl overflow-hidden mt-12 animate-in slide-in-from-top-3 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Bell className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900" />
              )}
            </div>
            <h3 className="text-xs font-semibold text-slate-900 dark:text-white">
              @我的通知与批注提及 ({notifications.length})
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllAsRead}
                className="flex items-center gap-1 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>全部已读</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Notifications List */}
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {notifications.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-400 space-y-2">
              <AtSign className="w-8 h-8 text-slate-300 dark:text-slate-700 mx-auto" />
              <div>暂无提及您的通知消息</div>
              <p className="text-[11px] text-slate-400">当协作者在正文批注中输入 @您的名字 时，通知将在此展示。</p>
            </div>
          ) : (
            notifications.map((item) => {
              return (
                <div
                  key={item.id}
                  onClick={() => handleMarkAsRead(item.id, item.documentId)}
                  className={`p-3.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer transition-colors flex items-start gap-3 ${
                    !item.isRead ? 'bg-indigo-50/30 dark:bg-indigo-950/20' : ''
                  }`}
                >
                  <img
                    src={item.author.avatar}
                    alt={item.author.name}
                    className="w-8 h-8 rounded-full object-cover shrink-0 ring-1 ring-slate-200 dark:ring-slate-700 mt-0.5"
                  />

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="font-semibold text-slate-900 dark:text-white truncate">
                          {item.author.name}
                        </span>
                        <span className="text-[11px] text-slate-400">在文档中提及了您</span>
                      </div>
                      {!item.isRead && (
                        <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                      )}
                    </div>

                    <div className="text-[11px] text-indigo-600 dark:text-indigo-400 font-medium truncate">
                      📄 {item.documentTitle}
                    </div>

                    {item.quotedText && (
                      <div className="border-l-2 border-indigo-400 pl-2 text-[11px] text-slate-500 italic bg-slate-100/50 dark:bg-slate-800/40 py-0.5 rounded-r">
                        "{item.quotedText}"
                      </div>
                    )}

                    <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                      {item.commentContent}
                    </p>

                    <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                      <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
                      <span className="text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-0.5">
                        进入查看 <ExternalLink className="w-2.5 h-2.5" />
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
