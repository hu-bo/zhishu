import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  documents,
  documentGenerations,
  rolePermissions,
  workspaces,
} from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { DomainError } from "../../shared/domain-error.js";
import { loadPolicyOverrides, spaceActionSql } from "./access.js";
import { requireWorkspaceDocumentManagers } from "../authorization/permissions.js";
import {
  accessRoles,
  actionLabels,
  actionsForResource,
  effectiveActions,
  resourceTypes,
  type AccessRole,
  type PermissionAction,
  type ResourceType,
} from "./policy.js";

export class AuthorizationService {
  constructor(
    private readonly db: Database,
    private readonly revoker: CollaborationSessionRevoker,
  ) {}

  private async requireManager(
    db: Pick<Database, "select">,
    principal: Principal,
    workspaceId: string,
    ownerOnly = false,
  ) {
    const [space] = await db
      .select({ ownerIdentityId: workspaces.ownerIdentityId })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.tenantId, principal.tenantId),
          eq(workspaces.id, workspaceId),
          spaceActionSql(principal, "manage"),
        ),
      )
      .limit(1);
    if (!space || (ownerOnly && space.ownerIdentityId !== principal.identityId))
      throw new DomainError(
        "NOT_FOUND",
        ownerOnly ? "仅空间所有者可配置角色权限" : "空间不存在或无管理权限",
      );
  }

  async list(principal: Principal, workspaceId: string) {
    await this.requireManager(this.db, principal, workspaceId);
    const overrides = await loadPolicyOverrides(this.db, principal.tenantId, workspaceId);
    const [space] = await this.db
      .select({ ownerIdentityId: workspaces.ownerIdentityId })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)))
      .limit(1);
    return {
      canConfigure: space?.ownerIdentityId === principal.identityId,
      actions: resourceTypes.map((resourceType) => ({
        resourceType,
        items: actionsForResource[resourceType].map((action) => ({
          action,
          label: actionLabels[action],
        })),
      })),
      policies: resourceTypes.flatMap((resourceType) =>
        accessRoles.map((role) => ({
          resourceType,
          role,
          actions: [...effectiveActions(resourceType, role, overrides)] as PermissionAction[],
          overridden: overrides.some((p) => p.resourceType === resourceType && p.role === role),
        })),
      ),
    };
  }

  async set(
    principal: Principal,
    workspaceId: string,
    kind: ResourceType,
    role: AccessRole,
    actions: PermissionAction[],
  ) {
    if (actions.some((a) => !actionsForResource[kind].includes(a)))
      throw new DomainError("VALIDATION_ERROR", "权限点不适用于此资源类型");
    if (actions.length && !actions.includes("read"))
      throw new DomainError("VALIDATION_ERROR", "授予操作权限时必须保留查看权限");
    await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      await this.requireManager(tx, principal, workspaceId, true);
      await tx
        .insert(rolePermissions)
        .values({
          tenantId: principal.tenantId,
          workspaceId,
          resourceType: kind,
          role,
          actions: [...new Set(actions)].sort(),
          createdBy: principal.identityId,
          updatedBy: principal.identityId,
        })
        .onConflictDoUpdate({
          target: [
            rolePermissions.tenantId,
            rolePermissions.workspaceId,
            rolePermissions.resourceType,
            rolePermissions.role,
          ],
          set: {
            actions: [...new Set(actions)].sort(),
            updatedBy: principal.identityId,
            updatedAt: new Date(),
          },
        });
      await requireWorkspaceDocumentManagers(tx, principal.tenantId, workspaceId);
    });
    // Persisted policy is immediately authoritative; revoke existing room sessions as well.
    const sessions = await this.db
      .select({ id: documents.id, generationId: documentGenerations.id })
      .from(documents)
      .innerJoin(
        documentGenerations,
        and(
          eq(documents.id, documentGenerations.documentId),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(
        and(eq(documents.tenantId, principal.tenantId), eq(documents.workspaceId, workspaceId)),
      );
    for (const s of sessions) this.revoker.revokeDocumentSessions(s.id, s.generationId);
  }
}
