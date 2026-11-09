import { policyEnforcer, accessRoles } from "./policy.js";
import { loadPolicyOverrides } from "./access.js";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { identityProfiles, resourceAcl, workspaces } from "../../../database/schema/index.js";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "../identity/identity.types.js";

type Executor = Pick<Database, "select">;

export function workspaceRole(
  workspace: Pick<
    typeof workspaces.$inferSelect,
    "kind" | "createdBy" | "ownerIdentityId" | "personalOwnerId"
  >,
  identityId: string,
  memberRole?: "admin" | "editor" | "viewer" | null,
): "owner" | "admin" | "editor" | "viewer" {
  if (workspace.kind === "personal")
    return workspace.personalOwnerId === identityId ? "owner" : "viewer";
  return workspace.ownerIdentityId === identityId ? "owner" : (memberRole ?? "viewer");
}

// Only an actual member or owner participates in workspace inheritance.
export async function workspaceAccess(
  db: Executor,
  principal: Pick<Principal, "tenantId" | "identityId">,
  workspaceId: string,
) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)))
    .limit(1);
  if (!workspace) throw new DomainError("NOT_FOUND", "空间不存在或无权访问");
  const [profile] = await db
    .select({ active: identityProfiles.active })
    .from(identityProfiles)
    .where(
      and(
        eq(identityProfiles.tenantId, principal.tenantId),
        eq(identityProfiles.identityId, principal.identityId),
      ),
    )
    .limit(1);
  const active = profile?.active !== false;
  const [member] = await db
    .select({ role: resourceAcl.role })
    .from(resourceAcl)
    .where(
      and(
        eq(resourceAcl.tenantId, principal.tenantId),
        eq(resourceAcl.workspaceId, workspaceId),
        eq(resourceAcl.identityId, principal.identityId),
      ),
    )
    .limit(1);
  const role = workspaceRole(
    workspace,
    principal.identityId,
    accessRoles.find((role) => role === member?.role),
  );
  const isMember =
    active &&
    (workspace.kind === "personal"
      ? workspace.personalOwnerId === principal.identityId
      : workspace.ownerIdentityId === principal.identityId || member !== undefined);
  const engine = await policyEnforcer(
    await loadPolicyOverrides(db, principal.tenantId, workspaceId),
  );
  return {
    workspace,
    role,
    isMember,
    canManage: isMember && (await engine.enforce([role], "space", "manage")),
    canOrganize: isMember && (await engine.enforce([role], "space", "write")),
    canRead: isMember && (await engine.enforce([role], "space", "read")),
  };
}

export async function requireWorkspaceOrganizer(
  db: Executor,
  principal: Pick<Principal, "tenantId" | "identityId">,
  workspaceId: string,
) {
  const access = await workspaceAccess(db, principal, workspaceId);
  if (!access.canOrganize) throw new DomainError("NOT_FOUND", "空间不可编辑，请联系空间管理员");
  return access;
}
