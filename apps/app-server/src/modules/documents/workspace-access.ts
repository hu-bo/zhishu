import { and, eq } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { workspaceMembers, workspaces } from "../../../database/schema/index.js";
import { DomainError } from "../../shared/domain-error.js";
import type { Principal } from "../identity/identity.types.js";

type Executor = Pick<Database, "select">;

export function workspaceRole(
  workspace: Pick<typeof workspaces.$inferSelect, "kind" | "createdBy" | "personalOwnerId">,
  identityId: string,
  memberRole?: "admin" | "editor" | "viewer" | null,
): "owner" | "admin" | "editor" | "viewer" {
  if (workspace.kind === "personal")
    return workspace.personalOwnerId === identityId ? "owner" : "viewer";
  return workspace.createdBy === identityId
    ? "owner"
    : (memberRole ?? (workspace.createdBy === "system" ? "editor" : "viewer"));
}

// Space roles govern organization. Document content keeps its explicit ACL boundary.
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
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.tenantId, principal.tenantId),
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.identityId, principal.identityId),
      ),
    )
    .limit(1);
  const role = workspaceRole(workspace, principal.identityId, member?.role);
  return {
    workspace,
    role,
    canManage: role === "owner" || role === "admin",
    canOrganize: role !== "viewer",
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
