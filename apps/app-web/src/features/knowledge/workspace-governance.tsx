import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAuthorizationState,
  getWorkspaceAuthorizationAudit,
  recoverDocumentGovernance,
  setWorkspaceSecurity,
  transferWorkspaceOwnership,
} from '@/api/generated/authorization';
import type { ListKnowledgeWorkspaces200Item } from '@/api/generated/app-api.schemas';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { MemberPicker, type MemberChoice } from './member-picker';
import { useKnowledgeWorkspace } from './workspace-context';
import { invalidateSpaceData } from './space-data';

function auditLabel(operation: string) {
  if (operation === 'document.governance-recovery') return '恢复文档管理权';
  if (operation === 'identity_profiles.lifecycle') return '账号状态变化';
  if (operation.startsWith('document_generations.')) return '正文版本切换';
  const resource = operation.startsWith('resource_acl.')
    ? '成员授权'
    : operation.startsWith('role_permissions.')
      ? '角色权限策略'
      : operation.startsWith('document_shares.')
        ? '分享链接'
        : operation.startsWith('documents.')
          ? '文档访问范围'
          : operation.startsWith('catalogs.')
            ? '目录位置与继承'
            : '空间所有权或缓存策略';
  const action = operation.endsWith('.insert')
    ? '新增'
    : operation.endsWith('.delete')
      ? '移除'
      : '更新';
  return `${action}${resource}`;
}

export function WorkspaceGovernancePanel({
  workspace,
}: {
  workspace: ListKnowledgeWorkspaces200Item;
}) {
  const { identityKey } = useKnowledgeWorkspace();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [member, setMember] = useState<MemberChoice | null>(null);
  const [confirmTransfer, setConfirmTransfer] = useState(false);
  const [documentId, setDocumentId] = useState('');
  const [reason, setReason] = useState('');
  const [auditOpen, setAuditOpen] = useState(false);
  const state = useQuery({
    queryKey: ['workspace-security', identityKey, workspace.id],
    queryFn: ({ signal }) => getAuthorizationState({ signal }),
  });
  const security = state.data?.find((scope) => scope.workspaceId === workspace.id);
  const audit = useQuery({
    queryKey: ['workspace-authorization-audit', identityKey, workspace.id],
    queryFn: ({ signal }) => getWorkspaceAuthorizationAudit(workspace.id, undefined, { signal }),
    enabled: auditOpen,
  });
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      invalidateSpaceData(queryClient, identityKey);
      await queryClient.invalidateQueries({
        queryKey: ['workspace-security', identityKey, workspace.id],
      });
      await queryClient.invalidateQueries({
        queryKey: ['workspace-authorization-audit', identityKey, workspace.id],
      });
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-5 border-t pt-5" aria-label="空间安全与治理">
      <h3 className="text-sm font-semibold">安全与治理</h3>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {workspace.role === 'owner' && (
        <>
          <div className="space-y-2">
            <p className="text-sm font-medium">本机正文缓存</p>
            <p className="text-xs text-muted-foreground">
              关闭后正文仅在线访问；已有未确认草稿会保留供恢复或导出，不自动丢弃。
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !security}
              onClick={() =>
                security &&
                void run(
                  () =>
                    setWorkspaceSecurity(workspace.id, {
                      revision: security.revision,
                      offlineCacheAllowed: !security.offlineCacheAllowed,
                    }),
                  '缓存策略已更新。',
                )
              }
            >
              {security?.offlineCacheAllowed ? '关闭本机正文缓存' : '允许本机正文缓存'}
            </Button>
          </div>
          {workspace.kind === 'team' && (
            <details className="space-y-3 rounded-xl border p-3">
              <summary className="cursor-pointer text-sm">转移空间所有权</summary>
              <p className="text-xs text-muted-foreground">
                选择已加入空间的成员。转移后你成为管理员，受限文档的单独授权保持原样。
              </p>
              <MemberPicker value={member} onChange={setMember} disabled={busy} />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !member || !security}
                onClick={() => setConfirmTransfer(true)}
              >
                确认转移…
              </Button>
            </details>
          )}
          <details className="space-y-3 rounded-xl border p-3">
            <summary className="cursor-pointer text-sm">恢复受限文档管理</summary>
            <p className="text-xs text-muted-foreground">
              输入本空间文档 ID 和恢复原因。本操作会显式授予你文档管理权并记录审计。
            </p>
            <Input
              aria-label="需恢复的文档 ID"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              placeholder="doc_…"
            />
            <Input
              aria-label="治理恢复原因"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请填写至少 8 个字的恢复原因"
              maxLength={500}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy || !/^doc_[A-Za-z0-9_-]+$/.test(documentId) || reason.trim().length < 8
              }
              onClick={() =>
                void run(
                  () => recoverDocumentGovernance(documentId, { reason: reason.trim() }),
                  '已恢复文档管理权。',
                )
              }
            >
              记录原因并恢复
            </Button>
          </details>
        </>
      )}
      <details
        open={auditOpen}
        onToggle={(event) => setAuditOpen(event.currentTarget.open)}
        className="rounded-xl border p-3"
      >
        <summary className="cursor-pointer text-sm">授权审计</summary>
        <div className="mt-3 space-y-2 text-xs">
          {audit.isPending ? (
            <p role="status">正在加载…</p>
          ) : audit.isError ? (
            <Button size="sm" variant="outline" onClick={() => void audit.refetch()}>
              加载失败，重试
            </Button>
          ) : audit.data?.items.length ? (
            audit.data.items.map((item) => (
              <p key={item.id} className="break-all border-b py-2">
                {new Date(item.createdAt).toLocaleString('zh-CN')} · {item.actorId || '系统'} ·{' '}
                {auditLabel(item.operation)} {item.documentId || ''}
                {typeof item.after?.reason === 'string' && (
                  <span className="mt-1 block text-muted-foreground">
                    原因：{item.after.reason}
                  </span>
                )}
              </p>
            ))
          ) : (
            <p>暂无授权变更记录。</p>
          )}
          {audit.data?.hasMore && <p>显示最近 50 条，完整审计保存在服务端。</p>}
        </div>
      </details>
      <ConfirmDialog
        open={confirmTransfer}
        onOpenChange={setConfirmTransfer}
        title="转移空间所有权"
        description={`将空间所有权交给 ${member?.displayName ?? ''}，你将成为管理员。`}
        confirmLabel="转移所有权"
        onConfirm={() =>
          member && security
            ? run(
                () =>
                  transferWorkspaceOwnership(workspace.id, {
                    identityId: member.identityId,
                    revision: security.revision,
                  }),
                '空间所有权已转移。',
              )
            : Promise.resolve(false)
        }
        error={error}
      />
    </section>
  );
}
