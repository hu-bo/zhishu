import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { workspaces } from "../../../database/schema/index.js";
import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { ensureRootCatalog } from "../catalogs/index.js";
import type { Principal } from "../identity/identity.types.js";

type WorkspaceOwner = Pick<Principal, "tenantId" | "identityId">;
type WorkspaceTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function findPersonalWorkspace(db: Pick<Database, "select">, owner: WorkspaceOwner) {
  const [row] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.tenantId, owner.tenantId),
        eq(workspaces.kind, "personal"),
        eq(workspaces.personalOwnerId, owner.identityId),
      ),
    )
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return row?.id;
}

export async function ensurePersonalWorkspace(
  tx: WorkspaceTransaction,
  owner: WorkspaceOwner,
): Promise<string> {
  const existing = await findPersonalWorkspace(tx, owner);
  if (existing) return existing;

  await lockKnowledgeTree(tx, owner.tenantId, owner.identityId);
  const provisioned = await findPersonalWorkspace(tx, owner);
  if (provisioned) return provisioned;

  const id = `ws_${randomUUID()}`;
  await tx.insert(workspaces).values({
    id,
    tenantId: owner.tenantId,
    name: "个人空间",
    kind: "personal",
    personalOwnerId: owner.identityId,
    ownerIdentityId: owner.identityId,
    createdBy: owner.identityId,
  });
  await ensureRootCatalog(tx, owner.tenantId, id, owner.identityId);
  return id;
}
