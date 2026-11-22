import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { workspaceInvitations, resourceAcl } from "../../../database/schema/index.js";
import { workspaceAccess, assertWorkspaceMemberCapacity } from "../authorization/permissions.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import { insertNotifications } from "../notifications/index.js";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");
function present(row: typeof workspaceInvitations.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  };
}
export class InvitationService {
  constructor(private readonly db: Database) {}
  private async manage(db: Pick<Database, "select">, principal: Principal, workspaceId: string) {
    const access = await workspaceAccess(db, principal, workspaceId);
    if (!access.canManage || access.workspace.kind !== "team")
      throw new DomainError("NOT_FOUND", "团队空间不存在或无管理权限");
    return access;
  }
  async list(principal: Principal, workspaceId: string) {
    await this.manage(this.db, principal, workspaceId);
    const rows = await this.db
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.userId, principal.userId),
          eq(workspaceInvitations.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(workspaceInvitations.createdAt))
      .limit(100);
    return rows.map(present);
  }
  async create(principal: Principal, workspaceId: string, role: "editor" | "viewer") {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.userId, principal.identityId);
      await this.manage(tx, principal, workspaceId);
      const token = randomBytes(32).toString("base64url");
      const [row] = await tx
        .insert(workspaceInvitations)
        .values({
          userId: principal.userId,
          workspaceId,
          role,
          tokenHash: digest(token),
          createdBy: principal.identityId,
          expiresAt: new Date(Date.now() + 7 * 86400000),
        })
        .returning();
      if (!row) throw new Error("Invitation insert returned no row");
      return { ...present(row), token };
    });
  }
  async revoke(principal: Principal, workspaceId: string, id: string) {
    await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.userId, principal.identityId);
      await this.manage(tx, principal, workspaceId);
      const rows = await tx
        .update(workspaceInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(workspaceInvitations.userId, principal.userId),
            eq(workspaceInvitations.workspaceId, workspaceId),
            eq(workspaceInvitations.id, id),
          ),
        )
        .returning({ id: workspaceInvitations.id });
      if (!rows.length) throw new DomainError("NOT_FOUND", "邀请不存在");
    });
  }
  async inspect(principal: Principal, token: string) {
    const [row] = await this.db
      .select()
      .from(workspaceInvitations)
      .where(
        and(
          eq(workspaceInvitations.userId, principal.userId),
          eq(workspaceInvitations.tokenHash, digest(token)),
        ),
      )
      .limit(1);
    if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now())
      throw new DomainError("NOT_FOUND", "邀请链接已失效");
    if (row.acceptedBy && row.acceptedBy !== principal.identityId)
      throw new DomainError("CONFLICT", "邀请链接已被使用");
    const { workspace } = await this.manage(
      this.db,
      { ...principal, identityId: row.createdBy },
      row.workspaceId,
    );
    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      role: row.role,
      accepted: row.acceptedBy === principal.identityId,
    };
  }
  async accept(principal: Principal, token: string) {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.userId, principal.identityId);
      const [row] = await tx
        .select()
        .from(workspaceInvitations)
        .where(
          and(
            eq(workspaceInvitations.userId, principal.userId),
            eq(workspaceInvitations.tokenHash, digest(token)),
          ),
        )
        .for("update")
        .limit(1);
      if (!row || row.revokedAt || row.expiresAt.getTime() <= Date.now())
        throw new DomainError("NOT_FOUND", "邀请链接已失效");
      if (row.acceptedBy && row.acceptedBy !== principal.identityId)
        throw new DomainError("CONFLICT", "邀请链接已被使用");
      const { workspace } = await this.manage(
        tx,
        { ...principal, identityId: row.createdBy },
        row.workspaceId,
      );
      const memberFilter = and(
        eq(resourceAcl.userId, principal.userId),
        eq(resourceAcl.workspaceId, row.workspaceId),
        eq(resourceAcl.identityId, principal.identityId),
      );
      const [existing] = await tx.select().from(resourceAcl).where(memberFilter).limit(1);
      if (row.acceptedBy) {
        if (!existing && workspace.ownerIdentityId !== principal.identityId)
          throw new DomainError("CONFLICT", "此邀请已使用，请联系管理员重新邀请");
        return { workspaceId: row.workspaceId };
      }
      if (!existing && workspace.ownerIdentityId !== principal.identityId) {
        await assertWorkspaceMemberCapacity(tx, principal.userId, row.workspaceId);
        await tx.insert(resourceAcl).values({
          userId: principal.userId,
          workspaceId: row.workspaceId,
          identityId: principal.identityId,
          createdBy: row.createdBy,
          role: row.role,
        });
        await insertNotifications(tx, [
          {
            userId: principal.userId,
            recipientId: principal.identityId,
            actorId: row.createdBy,
            type: "permission",
            eventKey: `invitation:${row.id}`,
            workspaceId: row.workspaceId,
            message: "你已加入团队空间",
          },
          {
            userId: principal.userId,
            recipientId: row.createdBy,
            actorId: principal.identityId,
            type: "permission",
            eventKey: `invitation-accepted:${row.id}`,
            workspaceId: row.workspaceId,
            message: "一位成员接受了你的空间邀请",
          },
        ]);
      }
      await tx
        .update(workspaceInvitations)
        .set({ acceptedAt: new Date(), acceptedBy: principal.identityId })
        .where(eq(workspaceInvitations.id, row.id));
      return { workspaceId: row.workspaceId };
    });
  }
}
