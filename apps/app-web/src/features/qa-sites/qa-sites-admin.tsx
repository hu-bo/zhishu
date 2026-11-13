import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  activateQaSite,
  createQaSite,
  getQaSite,
  listQaSites,
  pauseQaSite,
  revokeQaSite,
  setQaSiteSourceDocuments,
  setQaSiteSources,
  updateQaSite,
} from '@/api/generated/qa-sites';
import { listKnowledgeWorkspaces } from '@/api/generated/knowledge';
import { listCatalogChildren } from '@/api/generated/knowledge';
import { errorMessage } from '@/api/api-error';

/** Site administration for workspace owners/admins: sources, approvals, access, lifecycle. */
export function QaSitesAdminPage() {
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ['qa-sites'], queryFn: () => listQaSites() });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspaces = useQuery({
    queryKey: ['knowledge-workspaces'],
    queryFn: () => listKnowledgeWorkspaces(),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['qa-sites'] });
  const run = <T,>(action: Promise<T>) =>
    action.catch((cause: unknown) => setError(errorMessage(cause)));

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">对外问答站点</h1>
          <p className="text-sm text-neutral-500">
            仅管理空间的 owner/admin
            可配置。来源空间需要其管理员委托，文档逐篇批准；新增文档不会自动公开。
          </p>
        </div>
        <button
          className="rounded border px-3 py-1.5 text-sm"
          onClick={() => {
            const workspace = workspaces.data?.[0];
            if (!workspace) return;
            void run(
              createQaSite({
                ownerWorkspaceId: workspace.id,
                slug: `ask-${Math.random().toString(36).slice(2, 8)}`,
                name: '新的问答站点',
              }),
            ).then(refresh);
          }}
        >
          新建站点
        </button>
      </header>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {(sites.data ?? []).map((site) => (
          <li key={site.id}>
            <button
              type="button"
              className={`w-full rounded border p-4 text-left ${selected === site.id ? 'border-neutral-900 dark:border-neutral-100' : ''}`}
              onClick={() => setSelected(site.id)}
            >
              <span className="font-medium">{site.name}</span>
              <code className="ml-2 text-xs">/ask/{site.slug}</code>
              <p className="text-xs text-neutral-500">
                {site.status} · v{site.revision} · {site.accessMode === 'code' ? '访问码' : '公开'}
              </p>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <SiteEditor siteId={selected} onDeleted={refresh} onClose={() => setSelected(null)} />
      ) : null}
      {sites.data?.[0]?.id ? (
        <p className="text-xs text-neutral-500">
          提示：先在空间管理中添加成员并确认你是来源空间管理员，再绑定委托。
          <Link className="ml-2 underline" to="/ask/$slug" params={{ slug: sites.data[0].slug }}>
            打开站点预览
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function SiteEditor({
  siteId,
  onDeleted,
  onClose,
}: {
  siteId: string;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ['qa-site', siteId], queryFn: () => getQaSite(siteId) });
  const [error, setError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const workspaces = useQuery({
    queryKey: ['knowledge-workspaces'],
    queryFn: () => listKnowledgeWorkspaces(),
  });
  const site = detail.data?.site;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['qa-site', siteId] });
    onDeleted();
  };
  const run = <T,>(action: Promise<T>) =>
    action.catch((cause: unknown) => setError(errorMessage(cause)));
  if (!site) return null;
  return (
    <section className="rounded border p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">{site.name}</h2>
        <button type="button" className="text-sm underline" onClick={onClose}>
          收起
        </button>
      </header>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="mb-4 grid gap-2">
        <label className="text-sm">
          站点名称
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            defaultValue={site.name}
            onBlur={(event) =>
              event.target.value !== site.name &&
              void run(
                updateQaSite(siteId, { expectedRevision: site.revision, name: event.target.value }),
              ).then(refresh)
            }
          />
        </label>
        <label className="text-sm">
          欢迎语
          <input
            className="mt-1 w-full rounded border px-2 py-1"
            defaultValue={site.welcome}
            onBlur={(event) =>
              event.target.value !== site.welcome &&
              void run(
                updateQaSite(siteId, {
                  expectedRevision: site.revision,
                  welcome: event.target.value,
                }),
              ).then(refresh)
            }
          />
        </label>
        <label className="text-sm">
          访问方式
          <select
            className="ml-2 rounded border px-2 py-1"
            value={site.accessMode}
            onChange={(event) =>
              void run(
                updateQaSite(siteId, {
                  expectedRevision: site.revision,
                  accessMode: event.target.value === 'code' ? 'code' : 'public',
                  ...(event.target.value === 'code'
                    ? { accessCode: prompt('设置访问码（至少 4 位）：') ?? '' }
                    : {}),
                }),
              ).then(refresh)
            }
          >
            <option value="public">公开</option>
            <option value="code">访问码</option>
          </select>
        </label>
      </div>
      <h3 className="text-sm font-medium">来源空间委托</h3>
      <ul className="my-2 text-sm">
        {(detail.data?.sources ?? []).map((source) => (
          <li key={source.id} className="flex items-center justify-between">
            <span>{source.publicLabel}</span>
            <button type="button" className="underline" onClick={() => setSourceId(source.id)}>
              管理批准文档
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 text-sm">
        {(workspaces.data ?? []).map((workspace) =>
          detail.data?.sources.some((source) => source.workspaceId === workspace.id) ? null : (
            <button
              key={workspace.id}
              type="button"
              className="rounded border px-2 py-1"
              onClick={() =>
                void run(
                  setQaSiteSources(siteId, {
                    expectedRevision: site.revision,
                    sources: [
                      ...(detail.data?.sources ?? []).map((s) => ({
                        workspaceId: s.workspaceId,
                        publicLabel: s.publicLabel,
                      })),
                      { workspaceId: workspace.id, publicLabel: workspace.name },
                    ],
                  }),
                ).then(refresh)
              }
            >
              + 委托 {workspace.name}（需你同时是该空间管理员）
            </button>
          ),
        )}
      </div>
      {sourceId && detail.data ? (
        <DocumentApprovals
          siteId={siteId}
          sourceId={sourceId}
          revision={site.revision}
          onChanged={refresh}
          onError={setError}
        />
      ) : null}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="rounded border px-3 py-1.5 text-sm"
          onClick={() =>
            void run(activateQaSite(siteId, { expectedRevision: site.revision })).then(refresh)
          }
        >
          启用
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1.5 text-sm"
          onClick={() =>
            void run(pauseQaSite(siteId, { expectedRevision: site.revision })).then(refresh)
          }
        >
          暂停
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1.5 text-sm text-red-600"
          onClick={() =>
            void run(revokeQaSite(siteId, { expectedRevision: site.revision })).then(refresh)
          }
        >
          停用（撤销凭据）
        </button>
      </div>
    </section>
  );
}

function DocumentApprovals({
  siteId,
  sourceId,
  revision,
  onChanged,
  onError,
}: {
  siteId: string;
  sourceId: string;
  revision: number;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const detail = useQuery({ queryKey: ['qa-site', siteId], queryFn: () => getQaSite(siteId) });
  const source = detail.data?.sources.find((candidate) => candidate.id === sourceId);
  const docs = useQuery({
    queryKey: ['catalog-root', source?.workspaceId],
    queryFn: () => listCatalogChildren(source!.workspaceId, 'cat_root_' + source!.workspaceId),
    enabled: !!source,
  });
  const approved = new Map((detail.data?.documents ?? []).map((d) => [d.documentId, d]));
  if (!source) return null;
  const act = (items: Parameters<typeof setQaSiteSourceDocuments>[2]['items']) =>
    setQaSiteSourceDocuments(siteId, sourceId, { expectedRevision: revision, items })
      .then(onChanged)
      .catch((cause: unknown) => onError(String((cause as Error)?.message ?? cause)));
  return (
    <div className="mt-3 rounded border p-3 text-sm">
      <p className="mb-2">
        来源「{source.publicLabel}
        」的文档批准（仅列当前可见条目；移动或删除文档会即时解除公开关系）：
      </p>
      <ul className="grid max-h-56 gap-1 overflow-y-auto">
        {(docs.data?.documents ?? []).map((item) => {
          const state = approved.get(item.id);
          return (
            <li key={item.id} className="flex items-center justify-between">
              <span>{item.title}</span>
              <span className="flex gap-1">
                {!state ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => act([{ documentId: item.id, action: 'approve' }])}
                  >
                    批准公开
                  </button>
                ) : state.state === 'active' ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      act([{ documentId: item.id, action: 'suspend', reason: '管理员暂停' }])
                    }
                  >
                    暂停
                  </button>
                ) : (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => act([{ documentId: item.id, action: 'approve' }])}
                  >
                    恢复
                  </button>
                )}
                {state ? (
                  <button
                    type="button"
                    className="underline text-red-600"
                    onClick={() => act([{ documentId: item.id, action: 'withdraw' }])}
                  >
                    移出
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
