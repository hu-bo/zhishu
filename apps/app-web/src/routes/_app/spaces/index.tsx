import { useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, FolderKanban, LoaderCircle, Plus } from 'lucide-react';
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
  const [icon, setIcon] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

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
      keyRef.current ??= crypto.randomUUID();
      const created = await createKnowledgeWorkspace(
        { name: trimmed, icon, description: description.trim() || undefined },
        { headers: { 'Idempotency-Key': keyRef.current } },
      );
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
      <DialogContent showCloseButton={false}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>创建空间</DialogTitle>
            <DialogDescription>空间是目录与文档的容器，创建后会自动生成根目录。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
  const { workspaces, loading, failed, refreshWorkspaces } = useKnowledgeWorkspace();
  const navigate = useNavigate({ from: '/spaces/' });
  const [createOpen, setCreateOpen] = useState(false);

  const goSpace = (workspaceId: string) =>
    void navigate({ to: '/spaces/$workspaceId', params: { workspaceId } });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">空间</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按团队或主题组织目录与文档；空间结构对租户内可见，权限仍由文档控制。
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={15} aria-hidden="true" />
          新建空间
        </Button>
      </header>

      {loading ? (
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
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link
                to="/spaces/$workspaceId"
                params={{ workspaceId: workspace.id }}
                className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs transition-all duration-150 hover:border-primary/40 hover:shadow-sm"
              >
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-lg"
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
                    <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                      {workspace.description}
                    </span>
                  )}
                  <span className="mt-2 block text-xs text-muted-foreground">
                    {workspace.documentCount} 篇文档
                  </span>
                </span>
              </Link>
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
    </div>
  );
}
