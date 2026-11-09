import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, LoaderCircle, Search } from 'lucide-react';
import { listDocuments } from '@/api/generated/documents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { WORKSPACE_KIND_LABELS } from '@/features/knowledge/workspace-roles';

export function AiDocumentPicker({
  kind,
  selected,
  onSelect,
  onClose,
  initialWorkspaceId,
}: {
  kind: 'target' | 'sources';
  selected: string[];
  onSelect: (documentIds: string[]) => void;
  onClose: () => void;
  initialWorkspaceId?: string;
}) {
  const { workspaces, identityKey } = useKnowledgeWorkspace();
  const available =
    kind === 'target'
      ? workspaces.filter((w) => w.kind === 'personal' && w.role === 'owner')
      : workspaces;
  const [workspaceId, setWorkspaceId] = useState(
    available.some((w) => w.id === initialWorkspaceId)
      ? initialWorkspaceId!
      : (available[0]?.id ?? ''),
  );
  const [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [chosen, setChosen] = useState<string[]>(kind === 'sources' ? selected : []);
  const query = useQuery({
    queryKey: ['ai-picker', identityKey, workspaceId, search, offset],
    queryFn: ({ signal }) =>
      listDocuments(
        {
          workspaceId,
          q: search || undefined,
          view: 'all',
          sort: 'updated',
          direction: 'desc',
          limit: 30,
          offset,
        },
        { signal },
      ),
    enabled: !!workspaceId,
  });
  const toggle = (documentId: string) => {
    if (kind === 'target') {
      onSelect([documentId]);
      onClose();
      return;
    }
    setChosen((current) =>
      current.includes(documentId)
        ? current.filter((id) => id !== documentId)
        : current.length < 4
          ? [...current, documentId]
          : current,
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{kind === 'target' ? '选择个人文档' : '选择创作资料'}</DialogTitle>
          <DialogDescription>
            {kind === 'target'
              ? 'AI 正文写入只支持本人的个人空间。'
              : '最多选择 4 篇有权限的资料；使用时将再次检查授权。'}
          </DialogDescription>
        </DialogHeader>
        {!available.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            还没有个人空间，请先新建个人草稿。
          </p>
        ) : (
          <>
            <label className="space-y-2 text-xs text-muted-foreground">
              {kind === 'target' ? '个人空间' : '资料空间'}
              <select
                aria-label={kind === 'target' ? '个人空间' : '资料空间'}
                value={workspaceId}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  setOffset(0);
                }}
                className="mt-2 h-10 w-full rounded-lg border bg-card px-3 text-sm text-foreground"
              >
                {available.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} · {WORKSPACE_KIND_LABELS[w.kind]}
                  </option>
                ))}
              </select>
            </label>
            <div className="relative">
              <Search size={15} className="absolute top-3 left-3 text-muted-foreground" />
              <Input
                aria-label="搜索资料文档"
                placeholder="搜索文档标题…"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setOffset(0);
                }}
                className="pl-9"
              />
            </div>
            {query.isPending ? (
              <p role="status" className="flex items-center gap-2 py-8 text-sm">
                <LoaderCircle size={16} className="animate-spin" />
                正在加载文档…
              </p>
            ) : query.isError ? (
              <div role="alert" className="space-y-3">
                <p className="text-sm">文档加载失败</p>
                <Button variant="outline" onClick={() => void query.refetch()}>
                  重试
                </Button>
              </div>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {query.data?.items.map((d) => {
                  const checked = chosen.includes(d.id);
                  return (
                    <li key={d.id}>
                      <button
                        type="button"
                        onClick={() => toggle(d.id)}
                        aria-pressed={kind === 'sources' ? checked : undefined}
                        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <FileText size={16} className="shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{d.title}</span>
                        {(checked || (kind === 'target' && selected.includes(d.id))) && (
                          <Check size={16} className="text-primary" />
                        )}
                      </button>
                    </li>
                  );
                })}
                {query.data?.items.length === 0 && (
                  <li className="py-8 text-center text-sm text-muted-foreground">没有找到文档</li>
                )}
              </ul>
            )}
            <div className="flex justify-between">
              <Button
                size="sm"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => setOffset((current) => Math.max(0, current - 30))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!query.data?.hasMore}
                onClick={() => setOffset((current) => current + 30)}
              >
                下一页
              </Button>
            </div>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          {kind === 'sources' && (
            <Button
              onClick={() => {
                onSelect(chosen);
                onClose();
              }}
            >
              {chosen.length ? `使用 ${chosen.length} 篇资料` : '不使用资料'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
