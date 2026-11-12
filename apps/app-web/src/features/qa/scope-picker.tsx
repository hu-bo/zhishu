import { useState } from 'react';
import type { ScopeSelection } from '@zhishu/ai-contracts';
import type { ListKnowledgeWorkspaces200Item } from '../../api/generated/app-api.schemas';

/** Deterministic scope control: 全部资料 / 指定空间（≤8）/ 当前文档. */
export function ScopePicker({
  workspaces,
  value,
  onChange,
  compact,
  documentLabel,
}: {
  workspaces: readonly ListKnowledgeWorkspaces200Item[];
  value: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  compact?: boolean;
  documentLabel?: { documentId: string; title: string };
}) {
  const [open, setOpen] = useState(false);
  const label =
    value.kind === 'all'
      ? '全部有权限资料'
      : value.kind === 'workspaces'
        ? `${value.workspaceIds.length} 个空间`
        : documentLabel
          ? `文档：${documentLabel.title}`
          : `${value.documentIds.length} 篇文档`;
  return (
    <div className={`scope-picker${compact ? ' scope-compact' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        范围：{label}
      </button>
      {open && (
        <div className="scope-panel" role="dialog" aria-label="选择资料范围">
          <fieldset>
            <legend>检索范围</legend>
            <label>
              <input
                type="radio"
                checked={value.kind === 'all'}
                onChange={() => onChange({ kind: 'all' })}
              />
              全部有权限资料
            </label>
            {documentLabel && (
              <label>
                <input
                  type="radio"
                  checked={value.kind === 'documents'}
                  onChange={() =>
                    onChange({ kind: 'documents', documentIds: [documentLabel.documentId] })
                  }
                />
                仅当前文档
              </label>
            )}
            <span>指定空间（最多 8 个）</span>
            <div className="scope-workspaces">
              {workspaces.map((workspace) => {
                const selected =
                  value.kind === 'workspaces' && value.workspaceIds.includes(workspace.id);
                return (
                  <label key={workspace.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? [
                              ...(value.kind === 'workspaces' ? value.workspaceIds : []),
                              workspace.id,
                            ]
                          : (value.kind === 'workspaces' ? value.workspaceIds : []).filter(
                              (id) => id !== workspace.id,
                            );
                        onChange(
                          next.length
                            ? { kind: 'workspaces', workspaceIds: next.slice(0, 8) }
                            : { kind: 'all' },
                        );
                      }}
                    />
                    {workspace.name}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <button type="button" onClick={() => setOpen(false)}>
            完成
          </button>
        </div>
      )}
    </div>
  );
}
