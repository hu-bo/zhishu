import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { acceptWorkspaceInvitation, inspectWorkspaceInvitation } from '@/api/generated/invitations';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { useKnowledgeWorkspace } from '@/features/knowledge/workspace-context';

export const Route = createFileRoute('/_app/invitations')({ component: InvitationPage });
function InvitationPage() {
  const { enabled, identityKey, refreshWorkspaces } = useKnowledgeWorkspace();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [token] = useState(() => window.location.hash.slice(1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token);
  const query = useQuery({
    queryKey: ['invitation-preview', identityKey, token],
    queryFn: () => inspectWorkspaceInvitation({ token }),
    enabled: enabled && valid,
    retry: false,
  });
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await acceptWorkspaceInvitation({ token });
      refreshWorkspaces();
      await client.invalidateQueries({ queryKey: ['notifications', identityKey] });
      await navigate({
        to: '/spaces/$workspaceId',
        params: { workspaceId: result.workspaceId },
        replace: true,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-lg space-y-5 rounded-2xl border bg-card p-6 sm:mt-12">
      <h1 className="text-xl font-semibold">加入团队空间</h1>
      {!valid ? (
        <p role="alert" className="text-sm text-destructive">
          邀请链接不完整，请向空间管理员获取新链接。
        </p>
      ) : !enabled ? (
        <p className="text-sm text-muted-foreground">请先登录，然后接受此邀请。</p>
      ) : query.isPending ? (
        <p role="status">正在检查邀请…</p>
      ) : query.isError ? (
        <div role="alert">
          <p className="text-sm text-destructive">{errorMessage(query.error)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <p>你受邀加入「{query.data.workspaceName}」</p>
          <p className="text-sm text-muted-foreground">
            邀请角色为{query.data.role === 'editor' ? '编辑者' : '只读成员'}。
            已有成员会保留当前角色；加入后可访问此空间中继承权限的文档。
          </p>
          <Button disabled={busy} onClick={() => void accept()}>
            {busy ? '正在加入…' : query.data.accepted ? '进入空间' : '接受邀请'}
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Link to="/spaces" className="block text-sm text-muted-foreground">
        返回知识空间
      </Link>
    </div>
  );
}
