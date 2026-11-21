export const WORKSPACE_ROLE_LABELS = {
  owner: '所有者',
  admin: '管理员',
  editor: '编辑者',
  viewer: '只读成员',
} as const;

/** owner 由创建产生、不可通过成员管理分配。 */
export type WorkspaceMemberRole = 'admin' | 'editor' | 'viewer';

export const ASSIGNABLE_WORKSPACE_ROLES = [
  'admin',
  'editor',
  'viewer',
] as const satisfies ReadonlyArray<WorkspaceMemberRole>;

export const toWorkspaceMemberRole = (value: string): WorkspaceMemberRole | null =>
  ASSIGNABLE_WORKSPACE_ROLES.find((role) => role === value) ?? null;

export const WORKSPACE_KIND_LABELS = {
  personal: '个人空间',
  team: '团队空间',
  unclassified: '未分类空间',
} as const;
