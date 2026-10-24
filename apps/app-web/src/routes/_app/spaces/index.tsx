import { useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowRight,
  FolderKanban,
  LoaderCircle,
  Plus,
  Settings,
  Users,
} from 'lucide-react';
import type { ListKnowledgeWorkspaces200Item } from '@/api/generated/models';
import { WorkspaceSettingsDialog } from '@/features/knowledge/workspace-settings-dialog';
import { WORKSPACE_KIND_LABELS, WORKSPACE_ROLE_LABELS } from '@/features/knowledge/workspace-roles';
import { createKnowledgeWorkspace } from '@/api/generated/app-api';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmojiField } from '@/features/knowledge/catalog-dialogs';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';

export const Route = createFileRoute('/_app/spaces/')({
  component: SpacesIndexPage,
});

function CreateWorkspaceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (workspaceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { identityKey } = useKnowledgeWorkspace();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'personal' | 'team'>('team');
  const [icon, setIcon] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<{ input: string; key: string } | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写空间名称。');
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const input = { name: trimmed, kind, icon, description: description.trim() || undefined };
      const fingerprint = JSON.stringify(input);
      if (keyRef.current?.input !== fingerprint)
        keyRef.current = { input: fingerprint, key: crypto.randomUUID() };
      const created = await createKnowledgeWorkspace(input, {
        headers: { 'Idempotency-Key': keyRef.current.key },
      });
      await queryClient.invalidateQueries({ queryKey: ['knowledge-workspaces', identityKey] });
      onClose();
      onCreated(created.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>创建空间</DialogTitle>
            <DialogDescription>选择空间用途，创建后保留该类型。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <fieldset disabled={busy} className="space-y-2">
              <legend className="text-xs font-medium text-muted-foreground">空间类型</legend>
              <div className="grid grid-cols-2 gap-3">
                {(['personal', 'team'] as const).map((value) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border bg-card p-3 text-sm has-checked:border-primary has-checked:bg-secondary"
                  >
                    <input
                      type="radio"
                      name="workspace-kind"
                      value={value}
                      checked={kind === value}
                      onChange={() => setKind(value)}
                      className="accent-primary"
                    />
                    {WORKSPACE_KIND_LABELS[value]}
                  </label>
                ))}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {kind === 'personal'
                  ? '由你本人管理；共享内容通过文档权限设置。'
                  : '可添加成员，共同整理目录与知识。'}
              </p>
            </fieldset>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="workspace-name">
                空间名称
              </label>
              <Input
                id="workspace-name"
                autoFocus
                maxLength={80}
                placeholder="例如：产品团队知识库"
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <EmojiField label="图标（可选）" value={icon} onChange={setIcon} />
            <div className="space-y-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="workspace-description"
              >
                描述（可选，200 字以内）
              </label>
              <Textarea
                id="workspace-description"
                maxLength={200}
                rows={2}
                placeholder="这个空间用来放什么内容？"
                value={description}
                disabled={busy}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden="true" />}
              创建空间
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SpacesIndexPage() {
  const { workspaces, enabled, loading, failed, refreshWorkspaces } = useKnowledgeWorkspace();
  const navigate = useNavigate({ from: '/spaces/' });
  const [createOpen, setCreateOpen] = useState(false);
  const [managing, setManaging] = useState<{
    workspace: ListKnowledgeWorkspaces200Item;
    tab: 'settings' | 'members';
  } | null>(null);

  const goSpace = (workspaceId: string) =>
    void navigate({ to: '/spaces/$workspaceId', params: { workspaceId } });

  return (
    <div className="zhishu-page space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
            把零散的想法，连成完整的知识
          </p>
          <h1 className="zhishu-page-heading">知识空间</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">按主题整理，和团队一起积累。</p>
        </div>
        <Button disabled={!enabled} onClick={() => setCreateOpen(true)}>
          <Plus size={15} aria-hidden="true" />
          新建空间
        </Button>
      </header>

      {!enabled ? (
        <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          登录后可创建空间、整理目录并管理成员。
        </p>
      ) : loading ? (
        <div
          role="status"
          className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle className="animate-spin" size={16} aria-hidden="true" />
          正在加载空间…
        </div>
      ) : failed ? (
        <div role="alert" className="rounded-xl border bg-card px-6 py-12 text-center">
          <AlertCircle
            className="mx-auto mb-3 text-muted-foreground"
            size={28}
            aria-hidden="true"
          />
          <p className="text-sm font-medium">空间列表加载失败</p>
          <Button className="mt-4" size="sm" variant="outline" onClick={refreshWorkspaces}>
            重新加载
          </Button>
        </div>
      ) : workspaces.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/80 px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <FolderKanban size={22} aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium text-foreground">还没有空间</p>
            <p className="mt-1 text-xs text-muted-foreground">
              创建第一个空间，把文档按目录组织起来。
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            创建空间
          </Button>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="zhishu-card group min-w-0 overflow-hidden">
              <Link
                to="/spaces/$workspaceId"
                params={{ workspaceId: workspace.id }}
                className="flex min-h-40 items-start gap-4 p-5 outline-none"
              >
                <span
                  aria-hidden="true"
                  className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-background text-2xl"
                >
                  {workspace.icon || <FolderKanban size={18} className="text-muted-foreground" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-foreground transition-colors duration-150 group-hover:text-primary">
                      {workspace.name}
                    </span>
                    <ArrowRight
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                    />
                  </span>
                  {workspace.description && (
                    <span className="mt-2 line-clamp-2 text-[13px] leading-6 text-muted-foreground">
                      {workspace.description}
                    </span>
                  )}
                  <span className="mt-4 block text-xs text-muted-foreground">
                    {workspace.documentCount} 篇文档 <span className="mx-1 text-border">/</span>{' '}
                    {workspace.memberCount} 位成员
                  </span>
                </span>
              </Link>
              <div className="flex items-center justify-end gap-1 border-t border-border/60 px-3 py-2">
                <span className="mr-auto pl-2 text-[11px] text-muted-foreground">
                  {WORKSPACE_KIND_LABELS[workspace.kind] ?? WORKSPACE_KIND_LABELS.unclassified} ·{' '}
                  {WORKSPACE_ROLE_LABELS[workspace.role]}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setManaging({ workspace, tab: 'members' })}
                >
                  <Users size={14} />
                  成员
                </Button>
                {workspace.canManage && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setManaging({ workspace, tab: 'settings' })}
                  >
                    <Settings size={14} />
                    空间设置
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {createOpen && (
        <CreateWorkspaceDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(workspaceId) => goSpace(workspaceId)}
        />
      )}
      {managing && (
        <WorkspaceSettingsDialog
          key={managing.workspace.id}
          workspace={
            workspaces.find((item) => item.id === managing.workspace.id) ?? managing.workspace
          }
          initialTab={managing.tab}
          onClose={() => setManaging(null)}
        />
      )}
    </div>
  );
}
