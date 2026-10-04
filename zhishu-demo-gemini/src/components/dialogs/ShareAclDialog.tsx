/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Shield, UserPlus, Trash2, CheckCircle2, User, Users } from 'lucide-react';
import { ACLPrincipal } from '../../types/document';
import { storageService } from '../../services/storage';

interface ShareAclDialogProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string;
  documentTitle: string;
  canManage: boolean;
}

export const ShareAclDialog: React.FC<ShareAclDialogProps> = ({
  isOpen,
  onClose,
  documentId,
  documentTitle,
  canManage,
}) => {
  const [aclList, setAclList] = useState<ACLPrincipal[]>(() =>
    storageService.getACL(documentId)
  );
  const [newPrincipalId, setNewPrincipalId] = useState('');
  const [newPrincipalName, setNewPrincipalName] = useState('');
  const [newRole, setNewRole] = useState<'editor' | 'viewer'>('editor');
  const [principalType, setPrincipalType] = useState<'user' | 'group'>('user');
  const [feedbackMsg, setFeedbackMsg] = useState('');

  if (!isOpen) return null;

  const handleGrant = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPrincipalId.trim()) return;

    const capabilities = {
      canEdit: newRole === 'editor',
      canComment: true,
      canManage: false,
      canShare: false,
    };

    const newPrincipal: ACLPrincipal = {
      id: newPrincipalId.trim(),
      name: newPrincipalName.trim() || newPrincipalId.trim(),
      type: principalType,
      role: newRole,
      avatar:
        principalType === 'user'
          ? `https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=120&q=80`
          : undefined,
      effectiveCapabilities: capabilities,
    };

    const updated = [...aclList.filter((p) => p.id !== newPrincipal.id), newPrincipal];
    setAclList(updated);
    storageService.updateACL(documentId, updated);
    setNewPrincipalId('');
    setNewPrincipalName('');
    setFeedbackMsg(`已成功为主体 [${newPrincipal.name}] 授予 ${newRole === 'editor' ? '协作者' : '只读人员'} 权限`);
    setTimeout(() => setFeedbackMsg(''), 3000);
  };

  const handleRoleChange = (principalId: string, role: 'editor' | 'viewer') => {
    const updated = aclList.map((p) => {
      if (p.id === principalId) {
        return {
          ...p,
          role,
          effectiveCapabilities: {
            ...p.effectiveCapabilities,
            canEdit: role === 'editor',
          },
        };
      }
      return p;
    });
    setAclList(updated);
    storageService.updateACL(documentId, updated);
  };

  const handleRevoke = (principalId: string) => {
    const updated = aclList.filter((p) => p.id !== principalId);
    setAclList(updated);
    storageService.updateACL(documentId, updated);
    setFeedbackMsg('已撤销该主体的访问授权');
    setTimeout(() => setFeedbackMsg(''), 3000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white truncate">
              访问控制列表 (ACL) 与主体授权
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-md"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              当前文档：<strong className="text-slate-800 dark:text-slate-200">{documentTitle}</strong>
            </div>
            {!canManage && (
              <div className="mt-1.5 p-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 rounded-md text-[11px] text-amber-700 dark:text-amber-300">
                当前用户角色非文档所有者 (Owner)，仅拥有查看有效权限列表能力，管理操作已被禁用。
              </div>
            )}
          </div>

          {feedbackMsg && (
            <div className="flex items-center gap-1.5 p-2 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 text-xs rounded-lg border border-emerald-200 dark:border-emerald-800/60">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{feedbackMsg}</span>
            </div>
          )}

          {/* Add Principal Form (Only if canManage) */}
          {canManage && (
            <form onSubmit={handleGrant} className="bg-slate-50 dark:bg-slate-800/50 p-3 rounded-lg border border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="text-xs font-medium text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                <UserPlus className="w-3.5 h-3.5 text-indigo-600" />
                <span>授予新主体访问权限</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="主体 ID (如 usr_alex, grp_dev)"
                  value={newPrincipalId}
                  onChange={(e) => setNewPrincipalId(e.target.value)}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500"
                  required
                />
                <input
                  type="text"
                  placeholder="展示名称 (选填)"
                  value={newPrincipalName}
                  onChange={(e) => setNewPrincipalName(e.target.value)}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-200 outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2">
                  <select
                    value={principalType}
                    onChange={(e) => setPrincipalType(e.target.value as any)}
                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 text-xs text-slate-700 dark:text-slate-300"
                  >
                    <option value="user">单人用户 (User)</option>
                    <option value="group">团队用户组 (Group)</option>
                  </select>

                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as any)}
                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 text-xs text-slate-700 dark:text-slate-300"
                  >
                    <option value="editor">协作者 (Editor)</option>
                    <option value="viewer">只读 (Viewer)</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="px-3 py-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md transition-colors shadow-xs"
                >
                  添加授权
                </button>
              </div>
            </form>
          )}

          {/* Current Principals List */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
              当前授权主体列表 ({aclList.length})：
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-900">
              {aclList.map((principal) => {
                const isOwner = principal.role === 'owner';
                return (
                  <div key={principal.id} className="p-3 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {principal.avatar ? (
                        <img
                          src={principal.avatar}
                          alt={principal.name}
                          className="w-7 h-7 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 shrink-0">
                          {principal.type === 'group' ? <Users className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
                        </div>
                      )}

                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                            {principal.name}
                          </span>
                          <span className="text-[10px] text-slate-600 dark:text-slate-300 font-mono">
                            ({principal.id})
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-600 dark:text-slate-300 flex items-center gap-1">
                          <span>能力：{principal.effectiveCapabilities.canEdit ? '读写编辑' : '只读查看'}</span>
                          <span>·</span>
                          <span>{principal.effectiveCapabilities.canManage ? '管理员' : '受限成员'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isOwner ? (
                        <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 px-2 py-1">
                          所有者
                        </span>
                      ) : (
                        <>
                          <select
                            disabled={!canManage}
                            value={principal.role}
                            onChange={(e) => handleRoleChange(principal.id, e.target.value as any)}
                            className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1 text-xs text-slate-700 dark:text-slate-300 outline-none disabled:opacity-60"
                          >
                            <option value="editor">协作者</option>
                            <option value="viewer">只读</option>
                          </select>

                          {canManage && (
                            <button
                              onClick={() => handleRevoke(principal.id)}
                              title="撤销授权"
                              className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 rounded-md transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-100 dark:border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
};
