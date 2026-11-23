import { newEnforcer, newModelFromString, type Enforcer } from "casbin";
import { sql, type SQLWrapper } from "drizzle-orm";

export const resourceTypes = ["space", "catalog", "document"] as const;
export const accessRoles = ["admin", "editor", "viewer"] as const;
export const permissionActions = [
  "read",
  "write",
  "comment",
  "share",
  "export",
  "ai",
  "manage",
  "move",
] as const;
export type ResourceType = (typeof resourceTypes)[number];
export type AccessRole = (typeof accessRoles)[number];
export type PermissionAction = (typeof permissionActions)[number];
export type PolicyOverride = { resourceType: ResourceType; role: AccessRole; actions: string[] };

export const actionLabels: Record<PermissionAction, string> = {
  read: "查看",
  write: "编辑",
  comment: "评论",
  share: "分享",
  export: "导出",
  ai: "AI 使用",
  manage: "管理权限与删除",
  move: "移动",
};
export const actionsForResource: Record<ResourceType, readonly PermissionAction[]> = {
  space: ["read", "write", "manage"],
  catalog: ["read", "write", "manage", "move"],
  document: permissionActions,
};

export function defaultActions(kind: ResourceType, role: string): readonly PermissionAction[] {
  if (role === "owner" || role === "admin") return actionsForResource[kind];
  if (role === "viewer") return ["read"];
  if (role === "editor")
    return actionsForResource[kind].filter((a) => ["read", "write", "comment", "ai"].includes(a));
  // Compatibility grants are immutable and never promoted into a broader role.
  if (kind === "space") return [];
  if (role === "write")
    return ["read", "write", "comment"].filter((a): a is PermissionAction =>
      actionsForResource[kind].includes(a as PermissionAction),
    );
  if (role === "comment" || role === "export" || role === "ai" || role === "move")
    return ["read", role];
  if (role === "manage") return actionsForResource[kind];
  if (role === "read" || role === "share") return [role];
  return [];
}

export function effectiveActions(
  kind: ResourceType,
  role: string,
  overrides: readonly PolicyOverride[],
): readonly string[] {
  return (
    overrides.find((p) => p.resourceType === kind && p.role === role)?.actions ??
    defaultActions(kind, role)
  );
}

const model = `
[request_definition]
r = roles, kind, action
[policy_definition]
p = role, kind, action
[policy_effect]
e = some(where (p.eft == allow))
[matchers]
m = hasRole(r.roles, p.role) && r.kind == p.kind && r.action == p.action
`;
const enforcers = new Map<string, Promise<Enforcer>>();
export function policyEnforcer(overrides: readonly PolicyOverride[] = []): Promise<Enforcer> {
  const normalized = [...overrides]
    .map((p) => ({ ...p, actions: [...p.actions].sort() }))
    .sort((a, b) => `${a.resourceType}:${a.role}`.localeCompare(`${b.resourceType}:${b.role}`));
  const key = JSON.stringify(normalized);
  const existing = enforcers.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const enforcer = await newEnforcer(newModelFromString(model));
    enforcer.enableAutoSave(false);
    enforcer.addFunction(
      "hasRole",
      (roles: unknown, role: unknown) => Array.isArray(roles) && roles.includes(role),
    );
    for (const kind of resourceTypes)
      for (const role of ["owner", ...accessRoles, ...permissionActions])
        for (const action of effectiveActions(kind, role, normalized))
          await enforcer.addPolicy(role, kind, action);
    return enforcer;
  })();
  // Cache only immutable policy snapshots, never resource grants or user decisions.
  if (enforcers.size >= 128) enforcers.delete(enforcers.keys().next().value!);
  enforcers.set(key, pending);
  void pending.catch(() => {
    if (enforcers.get(key) === pending) enforcers.delete(key);
  });
  return pending;
}

// SQL projection of the same policy data; filtering remains before pagination/counting.
export function roleActionSql(
  tenantId: SQLWrapper | string,
  workspaceId: SQLWrapper | string,
  kind: ResourceType,
  role: SQLWrapper,
  action: PermissionAction,
) {
  const defaults = ["owner", ...accessRoles, ...permissionActions].filter((r) =>
    defaultActions(kind, r).includes(action),
  );
  const defaultAllowed = defaults.length
    ? sql`${role} in (${sql.join(
        defaults.map((r) => sql`${r}`),
        sql`, `,
      )})`
    : sql`false`;
  return sql<boolean>`coalesce((select ${action} = any(rp.actions) from role_permissions rp where rp.tenant_id = ${tenantId} and rp.workspace_id = ${workspaceId} and rp.resource_type = ${kind} and rp.role = ${role}), ${defaultAllowed}, false)`;
}
