import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getWorkspacePermissions,
  setWorkspaceRolePermissions,
} from '@/api/generated/authorization';
import type { GetWorkspacePermissions200PoliciesItem } from '@/api/generated/app-api.schemas';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';

const kindLabels = { space: '空间', catalog: '目录', document: '文档' };
const roleLabels = { admin: '管理', editor: '编辑', viewer: '只读' };
type Policy = GetWorkspacePermissions200PoliciesItem;

function PolicyRow({
  policy,
  items,
  disabled,
  onSave,
}: {
  policy: Policy;
  items: { action: Policy['actions'][number]; label: string }[];
  disabled: boolean;
  onSave: (actions: Policy['actions']) => Promise<void>;
}) {
  const [actions, setActions] = useState(policy.actions);
  const [sourceActions, setSourceActions] = useState(policy.actions);
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  if (sourceActions !== policy.actions) {
    setSourceActions(policy.actions);
    setActions(policy.actions);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = [...actions].sort().join() !== [...policy.actions].sort().join();
  return (
    <fieldset
      ref={fieldsetRef}
      disabled={disabled || busy}
      className="space-y-3 rounded-lg border p-3"
    >
      <legend className="px-1 text-sm font-medium">{roleLabels[policy.role]}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {items.map(({ action, label }) => (
          <label key={action} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={actions.includes(action)}
              onChange={(e) =>
                setActions((current) =>
                  e.target.checked ? [...current, action] : current.filter((a) => a !== action),
                )
              }
            />
            {label}
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!disabled && (
        <Button
          size="sm"
          type="button"
          disabled={!dirty || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave(actions);
            } catch (cause) {
              setError(errorMessage(cause));
            } finally {
              setBusy(false);
              requestAnimationFrame(() => fieldsetRef.current?.querySelector('input')?.focus());
            }
          }}
        >
          {busy ? '保存中…' : '保存权限'}
        </Button>
      )}
    </fieldset>
  );
}

export function WorkspacePermissionsPanel({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['workspace-permissions', workspaceId],
    queryFn: ({ signal }) => getWorkspacePermissions(workspaceId, { signal }),
  });
  if (query.isPending)
    return (
      <p role="status" className="py-4 text-sm">
        正在读取权限…
      </p>
    );
  if (query.isError)
    return (
      <div role="alert">
        <p>{errorMessage(query.error)}</p>
        <Button type="button" onClick={() => void query.refetch()}>
          重试
        </Button>
      </div>
    );
  const data = query.data;
  return (
    <section aria-label="角色权限配置" className="space-y-5">
      <p className="text-xs leading-5 text-muted-foreground">
        配置本空间内各角色可执行的操作。仅空间所有者可修改；所有者始终保留全部权限。单独授予的历史操作权限独立生效。
      </p>
      {data.actions.map(({ resourceType, items }) => (
        <section key={resourceType} className="space-y-2">
          <h3 className="text-sm font-semibold">{kindLabels[resourceType]}</h3>
          {data.policies
            .filter((p) => p.resourceType === resourceType)
            .map((policy) => (
              <PolicyRow
                key={`${resourceType}:${policy.role}`}
                policy={policy}
                items={items}
                disabled={!data.canConfigure}
                onSave={async (actions) => {
                  await setWorkspaceRolePermissions(workspaceId, resourceType, policy.role, {
                    actions,
                  });
                  await queryClient.invalidateQueries();
                }}
              />
            ))}
        </section>
      ))}
    </section>
  );
}
