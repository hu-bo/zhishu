import type { ListKnowledgeWorkspaces200Item } from '../../api/generated/app-api.schemas';

const WORKSPACE_KIND_LABEL = {
  personal: '个人',
  team: '团队',
  unclassified: '未分类',
} as const satisfies Record<ListKnowledgeWorkspaces200Item['kind'], string>;

export function workspaceKindLabel(kind: ListKnowledgeWorkspaces200Item['kind']): string {
  return WORKSPACE_KIND_LABEL[kind];
}

const WORKSPACE_VISIBILITY = {
  personal: '个人空间 · 仅你可见',
  team: '团队空间 · 全体成员可见',
  unclassified: '可见规则以服务端为准',
} as const satisfies Record<ListKnowledgeWorkspaces200Item['kind'], string>;

export function workspaceVisibility(kind: ListKnowledgeWorkspaces200Item['kind']): string {
  return WORKSPACE_VISIBILITY[kind];
}
