import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocument, setDocumentAccessMode } from '@/api/generated/documents';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';
import { invalidateSpaceData } from '@/features/knowledge/space-data';

export function DocumentAccessMode({ documentId }: { documentId: string }) {
  const client = useQueryClient();
  const { workspaces, identityKey } = useKnowledgeWorkspace();
  const document = useQuery({
    queryKey: ['document', documentId],
    queryFn: ({ signal }) => getDocument(documentId, { signal }),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'personal' | 'workspace-inherited' | 'restricted' | null>(null);
  const workspace = workspaces.find((w) => w.id === document.data?.workspaceId);
  const save = async () => {
    if (!document.data || !mode) return;
    setBusy(true);
    setError(null);
    try {
      await setDocumentAccessMode(documentId, {
        accessMode: mode,
        metadataRevision: document.data.metadataRevision,
      });
      await client.invalidateQueries({ queryKey: ['document', documentId] });
      invalidateSpaceData(client, identityKey);
      await client.invalidateQueries({ queryKey: ['notifications', identityKey] });
      setMode(null);
    } catch (cause) {
      setError(errorMessage(cause));
      await document.refetch();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-xl border p-4" aria-label="文档访问范围">
      <h3 className="text-sm font-semibold">访问范围</h3>
      {document.isPending ? (
        <p role="status" className="text-xs">
          正在读取权限…
        </p>
      ) : document.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(document.error)}
        </p>
      ) : (
        <>
          <select
            aria-label="文档访问范围"
            className="h-9 w-full rounded-md border bg-card px-3 text-sm"
            value={mode ?? document.data.accessMode}
            disabled={busy}
            onChange={(event) => setMode(event.target.value as NonNullable<typeof mode>)}
          >
            <option value="restricted">受限 · 仅单独授权的成员</option>
            {workspace?.kind === 'team' && (
              <option value="workspace-inherited">继承空间 · 按成员角色访问</option>
            )}
            {workspace?.kind === 'personal' && (
              <option value="personal">个人文档 · 可单独分享</option>
            )}
          </select>
          <p className="text-xs leading-5 text-muted-foreground">
            {(mode ?? document.data.accessMode) === 'workspace-inherited'
              ? '按空间与祖先目录的当前角色策略访问。成员退出后失去该继承来源，独立授权仍按各自来源规则生效。'
              : '仅按文档的显式授权访问，不继承空间或目录权限。空间所有者可填写原因并通过审计流程恢复管理。'}
          </p>
          {mode && mode !== document.data.accessMode && (
            <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
              {busy ? '正在更新…' : '更新访问范围'}
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
