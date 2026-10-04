/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Copy, Check, Key, Shield, UserCheck } from 'lucide-react';
import { CurrentUser } from '../../types/document';
import { MOCK_USERS } from '../../services/storage';

interface DevTokenModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: CurrentUser;
  onSwitchUser: (role: 'owner' | 'editor' | 'viewer') => void;
}

export const DevTokenModal: React.FC<DevTokenModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onSwitchUser,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(currentUser.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              开发调试令牌与身份接入
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            开发模式下可通过模拟登录取得短期 Bearer Token。Token 仅保存在当前页面会话内存中，模拟真实网关鉴权与多角色能力校验。
          </p>

          {/* Role selector */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
              当前切换模拟角色：
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['owner', 'editor', 'viewer'] as const).map((role) => {
                const user = MOCK_USERS[role];
                const isSelected = currentUser.role === role;
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => onSwitchUser(role)}
                    className={`flex flex-col items-center p-3 rounded-lg border text-center transition-all ${
                      isSelected
                        ? 'border-indigo-600 bg-indigo-50/70 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-300 shadow-xs'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-slate-50/50 dark:bg-slate-800/40 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <img
                      src={user.avatar}
                      alt={user.name}
                      className="w-8 h-8 rounded-full mb-1.5 object-cover"
                    />
                    <span className="text-xs font-semibold">{user.name.split(' ')[0]}</span>
                    <span className="text-[10px] text-slate-600 dark:text-slate-300 mt-0.5">
                      {role === 'owner' ? '所有者' : role === 'editor' ? '协作者' : '只读人员'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Token Box */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
              <span>短期 Bearer Token：</span>
              <span className="text-[11px] text-emerald-600 dark:text-emerald-400">有效 (会话级隔离)</span>
            </div>
            <div className="relative">
              <input
                type="text"
                readOnly
                value={currentUser.token}
                className="w-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-300 pr-10 focus:outline-none"
              />
              <button
                onClick={handleCopy}
                className="absolute right-2 top-2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded"
                title="复制令牌"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Capabilities breakdown */}
          <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3 border border-slate-100 dark:border-slate-800 space-y-1.5 text-xs text-slate-600 dark:text-slate-300">
            <div className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-indigo-500" />
              <span>当前有效权限能力 (Effective Capabilities)：</span>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[11px]">
              <div>• 文档正文编辑 (canEdit): <strong className={currentUser.role !== 'viewer' ? 'text-emerald-600' : 'text-slate-400'}>{currentUser.role !== 'viewer' ? '允许' : '受限只读'}</strong></div>
              <div>• 成员与ACL管理 (canManage): <strong className={currentUser.role === 'owner' ? 'text-emerald-600' : 'text-slate-400'}>{currentUser.role === 'owner' ? '允许' : '仅所有者'}</strong></div>
              <div>• 版本恢复与分支: <strong className={currentUser.role !== 'viewer' ? 'text-emerald-600' : 'text-slate-400'}>{currentUser.role !== 'viewer' ? '允许' : '只读'}</strong></div>
              <div>• 回收站永久删除: <strong className={currentUser.role === 'owner' ? 'text-emerald-600' : 'text-slate-400'}>{currentUser.role === 'owner' ? '允许' : '拒绝'}</strong></div>
            </div>
          </div>
        </div>

        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            完成并继续
          </button>
        </div>
      </div>
    </div>
  );
};
