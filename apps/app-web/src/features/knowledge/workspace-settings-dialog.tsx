import { type ReactNode, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Plus, Trash2, Users } from 'lucide-react';
import {
  listWorkspaceMembers,
  removeWorkspaceMember,
  setWorkspaceMember,
  updateKnowledgeWorkspace,
} from '@/api/generated/knowledge';
import type {
  ListKnowledgeWorkspaces200Item,
  ListWorkspaceMembers200Item,
} from '@/api/generated/app-api.schemas';
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
import { cn } from '@/lib/cn';
import { WorkspacePermissionsPanel } from './workspace-permissions';
import { WorkspaceGovernancePanel } from './workspace-governance';
import { MemberMultiSelect } from './member-multi-select';
import type { MemberChoice } from './member-picker';
import { WorkspaceInvitations } from './workspace-invitations';
import { EmojiField } from './catalog-dialogs';
import { useKnowledgeWorkspace } from './workspace-context';
import { invalidateSpaceData } from './space-data';
import {
  ASSIGNABLE_WORKSPACE_ROLES,
  WORKSPACE_KIND_LABELS,
  WORKSPACE_ROLE_LABELS,
  toWorkspaceMemberRole,
  type WorkspaceMemberRole,
} from './workspace-roles';

/** 空间角色下拉；「管理员」仅空间所有者可分配。change 后由调用方立即落库。 */
function RoleSelect({
  ariaLabel,
  value,
  onChange,
  canAssignAdmin,
  disabled = false,
  className,
}: {
  ariaLabel: string;
  value: WorkspaceMemberRole;
  onChange: (role: WorkspaceMemberRole) => void;
  canAssignAdmin: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className={cn('h-9 shrink-0 rounded-md border bg-card px-2 text-sm', className)}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const next = toWorkspaceMemberRole(event.target.value);
        if (next) onChange(next);
      }}
    >
      {ASSIGNABLE_WORKSPACE_ROLES.filter((role) => role !== 'admin' || canAssignAdmin).map(
        (role) => (
          <option key={role} value={role}>
            {WORKSPACE_ROLE_LABELS[role]}
          </option>
        ),
      )}
    </select>
  );
}

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
  const [tab, setTab] = useState<'settings' | 'members' | 'permissions'>(initialTab);
  const [name, setName] = useState(workspace.name);
  const [icon, setIcon] = useState(workspace.icon);
  const [description, setDescription] = useState(workspace.description);
  const [pendingMembers, setPendingMembers] = useState<MemberChoice[]>([]);
  const [addRole, setAddRole] = useState<WorkspaceMemberRole>('viewer');
  const [adding, setAdding] = useState(false);
  const [savingRoleId, setSavingRoleId] = useState<string | null>(null);
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
  const saveSettings = async () => {
    if (busy || !workspace.canManage) return;
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await updateKnowledgeWorkspace(workspace.id, {
        name: name.trim(),
        icon,
        description: description.trim(),
      });
      setFeedback('空间设置已保存。');
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const addMembers = async () => {
    if (adding || pendingMembers.length === 0) return;
    setAdding(true);
    setError(null);
    try {
      // setWorkspaceMember 是幂等 upsert；部分失败时保留已选标签，可直接重试。
      for (const member of pendingMembers) {
        await setWorkspaceMember(workspace.id, member.identityId, {
          displayName: member.displayName,
          role: addRole,
        });
      }
      setPendingMembers([]);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAdding(false);
    }
  };
  const changeRole = async (member: ListWorkspaceMembers200Item, role: WorkspaceMemberRole) => {
    if (savingRoleId || role === member.role) return;
    setSavingRoleId(member.identityId);
    setError(null);
    try {
      await setWorkspaceMember(workspace.id, member.identityId, {
        displayName: member.displayName,
        role,
      });
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingRoleId(null);
    }
  };
  const canEditMember = (member: ListWorkspaceMembers200Item) =>
    workspace.kind !== 'personal' &&
    workspace.canManage &&
    member.role !== 'owner' &&
    (workspace.role === 'owner' || member.role !== 'admin');
  const switchTab = (next: 'settings' | 'members' | 'permissions') => {
    setTab(next);
    setError(null);
    setFeedback(null);
  };
  let body: ReactNode = null;
  if (tab === 'permissions') {
    body = (
      <>
        <WorkspacePermissionsPanel workspaceId={workspace.id} />
        <WorkspaceGovernancePanel workspace={workspace} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </>
    );
  } else if (tab === 'settings') {
    body = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void saveSettings();
        }}
        className="space-y-4"
      >
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
          {workspace.canManage && (
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <LoaderCircle size={14} className="animate-spin" />}
              保存空间设置
            </Button>
          )}
        </DialogFooter>
      </form>
    );
  } else {
    body = (
      <div className="space-y-4">
        <p className="rounded-lg bg-secondary p-3 text-xs leading-5 text-muted-foreground">
          {workspace.kind === 'personal'
            ? '个人空间由所有者管理，不支持添加空间成员。共享和撤销访问请使用文档权限设置。'
            : '管理员可管理空间资料和普通成员；编辑者可创建文档、整理自己创建的目录；只读成员可浏览目录。继承空间权限的文档按成员角色开放，受限文档仍需单独授权。'}
        </p>
        {workspace.canManage && workspace.kind !== 'personal' && (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <MemberMultiSelect
                value={pendingMembers}
                onChange={setPendingMembers}
                excludeIds={(members.data ?? []).map((member) => member.identityId)}
                disabled={adding}
              />
            </div>
            <RoleSelect
              ariaLabel="新成员角色"
              value={addRole}
              onChange={setAddRole}
              canAssignAdmin={workspace.role === 'owner'}
              disabled={adding}
            />
            <Button
              type="button"
              disabled={adding || pendingMembers.length === 0}
              onClick={() => void addMembers()}
            >
              {adding ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
              添加成员
            </Button>
          </div>
        )}
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
          <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto" aria-label="空间成员">
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
                    title={member.email || member.identityId}
                  >
                    {member.email || member.identityId}
                  </p>
                </div>
                {canEditMember(member) ? (
                  <RoleSelect
                    ariaLabel={`设置 ${member.displayName} 的空间角色`}
                    value={toWorkspaceMemberRole(member.role) ?? 'viewer'}
                    onChange={(role) => void changeRole(member, role)}
                    canAssignAdmin={workspace.role === 'owner'}
                    disabled={savingRoleId === member.identityId}
                    className="h-8 text-xs"
                  />
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {WORKSPACE_ROLE_LABELS[member.role]}
                  </span>
                )}
                {canEditMember(member) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除成员 ${member.displayName}`}
                    onClick={() => setPendingRemove(member)}
                  >
                    <Trash2 size={14} />
                  </Button>
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
        {workspace.canManage && workspace.kind === 'team' && (
          <WorkspaceInvitations workspaceId={workspace.id} />
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </div>
    );
  }
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
              onClick={() => switchTab('members')}
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
              onClick={() => switchTab('settings')}
              disabled={busy}
            >
              空间设置
            </Button>
            {workspace.canManage && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={tab === 'permissions'}
                onClick={() => switchTab('permissions')}
              >
                角色权限
              </Button>
            )}
          </div>
          {body}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title="移除空间成员"
        description={`移除「${pendingRemove?.displayName ?? ''}」后，该成员将失去空间角色和文档继承权限；已有单独授权及文档所有权继续有效。`}
        confirmLabel="确认移除"
        destructive
        onConfirm={async () => {
          if (!pendingRemove) return;
          await removeWorkspaceMember(workspace.id, pendingRemove.identityId);
          await refresh();
        }}
      />
    </>
  );
}
