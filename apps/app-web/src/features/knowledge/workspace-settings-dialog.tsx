import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Pencil, Trash2, Users } from 'lucide-react';
import {
  listWorkspaceMembers,
  removeWorkspaceMember,
  setWorkspaceMember,
  updateKnowledgeWorkspace,
} from '@/api/generated/app-api';
import type {
  ListKnowledgeWorkspaces200Item,
  ListWorkspaceMembers200Item,
} from '@/api/generated/models';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EmojiField } from './catalog-dialogs';
import { useKnowledgeWorkspace } from './workspace-context';
import { invalidateSpaceData } from './space-data';

import { WORKSPACE_KIND_LABELS, WORKSPACE_ROLE_LABELS } from './workspace-roles';
type MemberRole = 'admin' | 'editor' | 'viewer';

export function WorkspaceSettingsDialog({
  workspace,
  initialTab = 'members',
  onClose,
}: {
  workspace: ListKnowledgeWorkspaces200Item;
  initialTab?: 'settings' | 'members';
  onClose: () => void;
}) {
  const { identityKey } = useKnowledgeWorkspace();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState(initialTab);
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon);
  const [description, setDescription] = useState(workspace.description);
  const [identityId, setIdentityId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<MemberRole>('editor');
  const [editingMember, setEditingMember] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<ListWorkspaceMembers200Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const members = useQuery({
    queryKey: ['workspace-members', identityKey, workspace.id],
    queryFn: ({ signal }) => listWorkspaceMembers(workspace.id, { signal }),
  });
  const refresh = async () => {
    invalidateSpaceData(queryClient, identityKey);
    await queryClient.invalidateQueries({
      queryKey: ['workspace-members', identityKey, workspace.id],
    });
  };
  const resetMember = () => {
    setIdentityId('');
    setDisplayName('');
    setRole('editor');
    setEditingMember(false);
  };
  const submit = async () => {
    if (busy || !workspace.canManage) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      if (tab === 'settings') {
        await updateKnowledgeWorkspace(workspace.id, {
          name: name.trim(),
          icon,
          description: description.trim(),
        });
        setFeedback('空间设置已保存。');
      } else {
        await setWorkspaceMember(workspace.id, identityId.trim(), {
          displayName: displayName.trim(),
          role,
        });
        resetMember();
        setFeedback('成员信息已保存。');
      }
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const canEditMember = (member: ListWorkspaceMembers200Item) =>
    workspace.kind !== 'personal' &&
    workspace.canManage &&
    member.role !== 'owner' &&
    (workspace.role === 'owner' || member.role !== 'admin');
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{workspace.name}</DialogTitle>
            <DialogDescription>
              {WORKSPACE_KIND_LABELS[workspace.kind] ?? WORKSPACE_KIND_LABELS.unclassified}
              ，当前角色：
              {WORKSPACE_ROLE_LABELS[workspace.role]}。
            </DialogDescription>
          </DialogHeader>
          <div className="zhishu-segmented" aria-label="空间管理页面">
            <Button
              size="sm"
              variant="ghost"
              className={
                tab === 'members' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'
              }
              aria-pressed={tab === 'members'}
              onClick={() => {
                setTab('members');
                setError(null);
                setFeedback(null);
              }}
              disabled={busy}
            >
              <Users size={14} />
              成员管理
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={
                tab === 'settings' ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground'
              }
              aria-pressed={tab === 'settings'}
              onClick={() => {
                setTab('settings');
                setError(null);
                setFeedback(null);
              }}
              disabled={busy}
            >
              空间设置
            </Button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            {tab === 'settings' ? (
              <fieldset disabled={!workspace.canManage || busy} className="space-y-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  {workspace.kind !== 'personal' && workspace.kind !== 'team'
                    ? '这是尚未分类的旧空间，AI 正文写入暂不可用。'
                    : `空间类型：${WORKSPACE_KIND_LABELS[workspace.kind]}。类型与个人空间所有者不能通过设置更改。`}
                </p>
                <div className="space-y-1.5">
                  <label htmlFor="edit-workspace-name" className="text-sm">
                    空间名称
                  </label>
                  <Input
                    id="edit-workspace-name"
                    required
                    maxLength={80}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <EmojiField label="空间图标" value={icon} onChange={setIcon} />
                <div className="space-y-1.5">
                  <label htmlFor="edit-workspace-description" className="text-sm">
                    空间描述
                  </label>
                  <Textarea
                    id="edit-workspace-description"
                    maxLength={200}
                    rows={3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
              </fieldset>
            ) : (
              <>
                <p className="rounded-lg bg-secondary p-3 text-xs leading-5 text-muted-foreground">
                  {workspace.kind === 'personal'
                    ? '个人空间由所有者管理，不支持添加空间成员。共享和撤销访问请使用文档权限设置。'
                    : '管理员可管理空间资料和普通成员；编辑者可创建文档、整理自己创建的目录；只读成员可浏览目录。正文访问由每篇文档的分享与权限设置控制。'}
                </p>
                {members.isPending ? (
                  <p role="status" className="flex items-center gap-2 text-sm">
                    <LoaderCircle size={16} className="animate-spin" />
                    正在加载成员…
                  </p>
                ) : members.isError ? (
                  <div role="alert">
                    <p className="text-sm text-destructive">成员加载失败</p>
                    <Button size="sm" variant="outline" onClick={() => void members.refetch()}>
                      重新加载
                    </Button>
                  </div>
                ) : (
                  <ul
                    className="max-h-64 divide-y divide-border/60 overflow-y-auto"
                    aria-label="空间成员"
                  >
                    {members.data.map((member) => (
                      <li key={member.identityId} className="flex items-center gap-3 py-3">
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-primary"
                        >
                          {member.displayName.slice(0, 1)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{member.displayName}</p>
                          <p
                            className="truncate text-xs text-muted-foreground"
                            title={member.identityId}
                          >
                            {member.identityId}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {WORKSPACE_ROLE_LABELS[member.role]}
                        </span>
                        {canEditMember(member) && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`编辑成员 ${member.displayName}`}
                              disabled={busy}
                              onClick={() => {
                                setIdentityId(member.identityId);
                                setDisplayName(member.displayName);
                                setRole(member.role as MemberRole);
                                setEditingMember(true);
                                setFeedback(null);
                              }}
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`移除成员 ${member.displayName}`}
                              disabled={busy}
                              onClick={() => setPendingRemove(member)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </>
                        )}
                      </li>
                    ))}
                    {members.data.length === 0 && (
                      <li className="py-5 text-center text-sm text-muted-foreground">
                        还没有显式添加的成员。
                      </li>
                    )}
                  </ul>
                )}
                {workspace.canManage && workspace.kind !== 'personal' && (
                  <fieldset disabled={busy} className="space-y-3 border-t pt-4">
                    <legend className="pt-4 text-sm font-medium">
                      {editingMember ? '编辑成员' : '添加成员'}
                    </legend>
                    <div className="space-y-1.5">
                      <label htmlFor="member-identity" className="text-xs text-muted-foreground">
                        成员主体 ID
                      </label>
                      <Input
                        id="member-identity"
                        required
                        maxLength={200}
                        disabled={editingMember}
                        placeholder="输入身份服务中的主体 ID"
                        value={identityId}
                        onChange={(event) => setIdentityId(event.target.value)}
                      />
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                      <div className="space-y-1.5">
                        <label
                          htmlFor="member-display-name"
                          className="text-xs text-muted-foreground"
                        >
                          成员名称
                        </label>
                        <Input
                          id="member-display-name"
                          required
                          maxLength={80}
                          value={displayName}
                          onChange={(event) => setDisplayName(event.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="member-role" className="text-xs text-muted-foreground">
                          角色
                        </label>
                        <select
                          id="member-role"
                          className="h-9 w-full rounded-md border bg-card px-2 text-sm"
                          value={role}
                          onChange={(event) => setRole(event.target.value as MemberRole)}
                        >
                          {workspace.role === 'owner' && <option value="admin">管理员</option>}
                          <option value="editor">编辑者</option>
                          <option value="viewer">只读成员</option>
                        </select>
                      </div>
                    </div>
                    {editingMember && (
                      <Button type="button" size="sm" variant="ghost" onClick={resetMember}>
                        取消编辑，添加新成员
                      </Button>
                    )}
                  </fieldset>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {feedback && (
              <p role="status" className="text-sm text-success">
                {feedback}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                关闭
              </Button>
              {workspace.canManage && (tab === 'settings' || workspace.kind !== 'personal') && (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (tab === 'members' && (!identityId.trim() || !displayName.trim())) ||
                    (tab === 'settings' && !name.trim())
                  }
                >
                  {busy && <LoaderCircle size={14} className="animate-spin" />}
                  {tab === 'settings' ? '保存空间设置' : editingMember ? '保存成员' : '添加成员'}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="移除空间成员"
        description={`移除「${pendingRemove?.displayName ?? ''}」后，该成员失去空间组织角色；已有文档授权仍可在文档权限中管理。`}
        confirmLabel="确认移除"
        destructive
        onConfirm={async () => {
          if (!pendingRemove) return;
          await removeWorkspaceMember(workspace.id, pendingRemove.identityId);
          if (identityId === pendingRemove.identityId) resetMember();
          await refresh();
        }}
      />
    </>
  );
}
