import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from '@/api/generated/invitations';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useKnowledgeWorkspace } from './workspace-context';

export function WorkspaceInvitations({ workspaceId }: { workspaceId: string }) {
  const { identityKey } = useKnowledgeWorkspace();
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const [link, setLink] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['workspace-invitations', identityKey, workspaceId],
    queryFn: ({ signal }) => listWorkspaceInvitations(workspaceId, { signal }),
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: ['workspace-invitations', identityKey, workspaceId] });
  const create = async () => {
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const invitation = await createWorkspaceInvitation(workspaceId, { role });
      setLink(new URL(`/invitations#${invitation.token}`, window.location.origin).toString());
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeWorkspaceInvitation(workspaceId, id);
      setLink('');
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="链接邀请" className="space-y-3 rounded-xl border p-4">
      <h3 className="text-sm font-semibold">邀请加入空间</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        每条链接限一位同租户成员使用，7 天内有效；对方登录后接受邀请即可加入。
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="邀请成员角色"
          value={role}
          onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
          className="h-9 rounded-md border bg-card px-2 text-sm"
        >
          <option value="viewer">只读成员</option>
          <option value="editor">编辑者</option>
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void create()}
        >
          生成邀请链接
        </Button>
      </div>
      {link && (
        <div className="space-y-2">
          <Input aria-label="邀请链接" readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() => setNotice('链接已复制'))
                .catch(() => setError('复制失败，请选择链接后手动复制'));
            }}
          >
            复制链接
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-success">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {query.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          正在加载邀请…
        </p>
      ) : query.isError ? (
        <div role="alert" className="text-xs text-destructive">
          邀请加载失败{' '}
          <Button type="button" size="sm" variant="ghost" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : (
        <ul className="max-h-40 divide-y overflow-y-auto">
          {query.data.map((invite) => {
            const state = invite.revokedAt
              ? '已撤销'
              : invite.acceptedAt
                ? '已接受'
                : new Date(invite.expiresAt).getTime() <= now
                  ? '已过期'
                  : '待接受';
            return (
              <li key={invite.id} className="flex items-center justify-between gap-2 py-2 text-xs">
                <span>
                  {invite.role === 'editor' ? '编辑者' : '只读成员'} · {state} ·{' '}
                  {new Date(invite.createdAt).toLocaleDateString('zh-CN')}
                </span>
                {state === '待接受' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void revoke(invite.id)}
                  >
                    撤销
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
