import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { catalogSchema } from "./catalog.schema.js";
import {
  idempotencyScope,
  loadIdempotencyReplay,
  storeIdempotencyReceipt,
} from "../../shared/idempotency.js";
import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { ensureRootCatalog } from "./root-catalog.js";
import { catalogActionSql, spaceActionSql } from "../authorization/access.js";
import { documentRecipients, insertNotifications } from "../notifications/index.js";
import {
  documentActionSql,
  requireWorkspaceDocumentManagers,
} from "../authorization/permissions.js";
import { catalogPathSql, workspaceNameSql } from "./navigation.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  catalogs,
  documentAuditEvents,
  documents,
  workspaces,
} from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { CreateCatalogInput, MoveCatalogInput, UpdateCatalogInput } from "./catalog.schema.js";
import { requireWorkspaceOrganizer, workspaceAccess } from "../authorization/permissions.js";
import { previewTransfer } from "./transfer-policy.js";

type DbExecutor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

/** Catalog trees are shallower than the legacy document tree cap; 16 edges below root is plenty. */
const MAX_CATALOG_DEPTH = 16;
const MAX_CATALOGS_PER_WORKSPACE = 500;
const MAX_CHILDREN_PER_NODE = 1000;

function readable(principal: Principal) {
  return documentActionSql(principal, "read");
}
function writable(principal: Principal) {
  return documentActionSql(principal, "write");
}

export type CatalogRow = {
  id: string;
  name: string;
  icon: string | null;
  parentId: string | null;
  workspaceId: string;
  position: number;
  canManage: boolean;
  canWrite: boolean;
  canMove: boolean;
};

type SubtreeRow = { id: string; created_by: string; depth: number };

async function renumberCatalogSiblings(
  db: DbExecutor,
  tenantId: string,
  orderedIds: readonly string[],
): Promise<void> {
  if (!orderedIds.length) return;
  await db.execute(
    sql`update catalogs c set position = ordered.ordinality - 1 from unnest(${sql.param([...orderedIds])}::text[]) with ordinality as ordered(id, ordinality) where c.tenant_id = ${tenantId} and c.id = ordered.id`,
  );
}

async function collectSubtree(
  db: DbExecutor,
  tenantId: string,
  catalogId: string,
): Promise<SubtreeRow[]> {
  const result = await db.execute<SubtreeRow>(sql`with recursive subtree as (
    select id, created_by, 0 as depth, array[id] as visited from catalogs where tenant_id = ${tenantId} and id = ${catalogId}
    union all select c.id, c.created_by, s.depth + 1, s.visited || c.id from catalogs c join subtree s on c.parent_id = s.id where c.tenant_id = ${tenantId} and not c.id = any(s.visited) and s.depth < ${MAX_CATALOG_DEPTH + 1}
  ) select id, created_by, depth from subtree`);
  return result.rows;
}

async function ancestorDepth(db: DbExecutor, tenantId: string, catalogId: string): Promise<number> {
  const result = await db.execute<{ depth: number }>(sql`with recursive parents as (
    select id, parent_id, 0 as depth, array[id] as visited from catalogs where tenant_id = ${tenantId} and id = ${catalogId}
    union all select c.id, c.parent_id, p.depth + 1, p.visited || c.id from catalogs c join parents p on c.id = p.parent_id where c.tenant_id = ${tenantId} and not c.id = any(p.visited) and p.depth < ${MAX_CATALOG_DEPTH + 1}
  ) select max(depth)::int as depth from parents`);
  return result.rows[0]?.depth ?? 0;
}

export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly revoker: CollaborationSessionRevoker,
  ) {}

  private async capabilities(
    db: Pick<Database, "select">,
    principal: Principal,
    catalogId: string,
  ) {
    const [row] = await db
      .select({
        canManage: catalogActionSql(principal, "manage"),
        canWrite: catalogActionSql(principal, "write"),
        canMove: catalogActionSql(principal, "move"),
      })
      .from(catalogs)
      .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
      .limit(1);
    return row ?? { canManage: false, canWrite: false, canMove: false };
  }

  private async requireCatalogAction(
    tx: DbExecutor,
    principal: Principal,
    catalogId: string,
    action: "write" | "manage" | "move" = "manage",
  ) {
    const [catalog] = await tx
      .select()
      .from(catalogs)
      .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
      .for("update")
      .limit(1);
    if (!catalog) throw new DomainError("NOT_FOUND", "目录不存在");
    const [allowed] = await tx
      .select({ id: catalogs.id })
      .from(catalogs)
      .where(
        and(
          eq(catalogs.tenantId, principal.tenantId),
          eq(catalogs.id, catalogId),
          catalogActionSql(principal, action),
        ),
      )
      .limit(1);
    if (!allowed) throw new DomainError("NOT_FOUND", "目录不存在或无管理权限");
    return catalog;
  }

  async listChildren(principal: Principal, workspaceId: string, catalogId: string) {
    const [catalog] = await this.db
      .select({
        id: catalogs.id,
        workspaceId: catalogs.workspaceId,
        name: catalogs.name,
        icon: catalogs.icon,
        parentId: catalogs.parentId,
        createdBy: catalogs.createdBy,
        canManage: catalogActionSql(principal, "manage"),
        canWrite: catalogActionSql(principal, "write"),
        canMove: catalogActionSql(principal, "move"),
      })
      .from(catalogs)
      .where(
        and(
          eq(catalogs.tenantId, principal.tenantId),
          eq(catalogs.id, catalogId),
          catalogActionSql(principal, "read"),
        ),
      )
      .limit(1);
    if (!catalog || catalog.workspaceId !== workspaceId)
      throw new DomainError("NOT_FOUND", "目录不存在");
    const [workspace] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)))
      .limit(1);
    if (!workspace) throw new DomainError("NOT_FOUND", "Workspace not found");
    const childCatalogs = await this.db
      .select({
        id: catalogs.id,
        name: catalogs.name,
        icon: catalogs.icon,
        position: catalogs.position,
        canManage: catalogActionSql(principal, "manage"),
        canWrite: catalogActionSql(principal, "write"),
        canMove: catalogActionSql(principal, "move"),
        // NOTE: reference the outer table by its literal name — inside a select builder,
        // interpolated ${catalogs.id} renders as bare "id" and would resolve to the subquery alias.
        hasChildren: sql<boolean>`(exists (select 1 from ${catalogs} c2 where c2.tenant_id = ${principal.tenantId} and c2.parent_id = catalogs.id and ${catalogActionSql(principal, "read", { id: sql`c2.id`, tenantId: sql`c2.tenant_id`, workspaceId: sql`c2.workspace_id` })}) or exists (select 1 from ${documents} d2 where d2.tenant_id = ${principal.tenantId} and d2.catalog_id = catalogs.id and d2.status = 'active' and ${documentActionSql(principal, "read", { id: sql`d2.id`, tenantId: sql`d2.tenant_id`, workspaceId: sql`d2.workspace_id`, createdBy: sql`d2.created_by`, accessMode: sql`d2.access_mode` })}))`,
      })
      .from(catalogs)
      .where(
        and(
          eq(catalogs.tenantId, principal.tenantId),
          eq(catalogs.workspaceId, workspaceId),
          eq(catalogs.parentId, catalogId),
          catalogActionSql(principal, "read"),
        ),
      )
      .orderBy(asc(catalogs.position), asc(catalogs.id))
      .limit(MAX_CHILDREN_PER_NODE);
    const childDocuments = await this.db
      .select({
        id: documents.id,
        title: documents.title,
        icon: documents.icon,
        position: documents.position,
        updatedAt: documents.updatedAt,
        createdBy: documents.createdBy,
        metadataRevision: documents.metadataRevision,
        canWrite: writable(principal),
        canManage: documentActionSql(principal, "manage"),
        canMove: documentActionSql(principal, "move"),
      })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.workspaceId, workspaceId),
          eq(documents.catalogId, catalogId),
          eq(documents.status, "active"),
          readable(principal),
        ),
      )
      .orderBy(asc(documents.position), asc(documents.id))
      .limit(MAX_CHILDREN_PER_NODE);
    return {
      catalog: {
        id: catalog.id,
        name: catalog.name,
        icon: catalog.icon,
        parentId: catalog.parentId,
        isRoot: catalog.parentId === null,
        canManage: catalog.parentId !== null && catalog.canManage,
        canWrite: catalog.canWrite,
        canMove: catalog.parentId !== null && catalog.canMove,
      },
      catalogs: childCatalogs,
      documents: childDocuments.map((row) => ({
        ...row,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async create(
    principal: Principal,
    workspaceId: string,
    input: CreateCatalogInput,
    idempotencyKey?: string,
  ): Promise<CatalogRow> {
    const receipt = idempotencyScope(principal, "catalogs.create", idempotencyKey, {
      workspaceId,
      ...input,
    });
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const replay = await loadIdempotencyReplay(tx, receipt, catalogSchema);
      if (replay) return replay;
      const [workspace] = await tx
        .select({ id: workspaces.id, createdBy: workspaces.createdBy })
        .from(workspaces)
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)))
        .limit(1);
      if (!workspace) throw new DomainError("NOT_FOUND", "Workspace not found");
      await requireWorkspaceOrganizer(tx, principal, workspaceId);
      const [count] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(catalogs)
        .where(
          and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.workspaceId, workspaceId)),
        );
      if ((count?.count ?? 0) >= MAX_CATALOGS_PER_WORKSPACE)
        throw new DomainError("RESOURCE_LIMIT", "空间目录数量已达上限");
      const parentId =
        input.parentId ?? (await ensureRootCatalog(tx, principal.tenantId, workspaceId));
      if (input.parentId) {
        const [parent] = await tx
          .select({ id: catalogs.id })
          .from(catalogs)
          .where(
            and(
              eq(catalogs.tenantId, principal.tenantId),
              eq(catalogs.id, input.parentId),
              eq(catalogs.workspaceId, workspaceId),
              catalogActionSql(principal, "write"),
            ),
          )
          .limit(1);
        if (!parent) throw new DomainError("NOT_FOUND", "父目录不存在");
        if ((await ancestorDepth(tx, principal.tenantId, input.parentId)) + 1 > MAX_CATALOG_DEPTH)
          throw new DomainError("VALIDATION_ERROR", "目录层级过深");
      }
      const siblings = await tx
        .select({ id: catalogs.id })
        .from(catalogs)
        .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.parentId, parentId)))
        .orderBy(asc(catalogs.position), asc(catalogs.id));
      const insertIndex =
        input.beforeId === null
          ? siblings.length
          : siblings.findIndex((row) => row.id === input.beforeId);
      if (insertIndex < 0) throw new DomainError("CONFLICT", "目标位置已变化");
      const id = `cat_${randomUUID()}`;
      const row: CatalogRow = {
        id,
        name: input.name,
        icon: input.icon ?? null,
        parentId,
        workspaceId,
        position: insertIndex,
        canManage: false,
        canWrite: false,
        canMove: false,
      };
      await tx.insert(catalogs).values({
        tenantId: principal.tenantId,
        id,
        workspaceId,
        parentId,
        name: input.name,
        icon: row.icon,
        position: insertIndex,
        createdBy: principal.identityId,
      });
      const order = siblings.map((sibling) => sibling.id);
      order.splice(insertIndex, 0, id);
      await renumberCatalogSiblings(tx, principal.tenantId, order);
      Object.assign(row, await this.capabilities(tx, principal, id));
      await storeIdempotencyReceipt(tx, receipt, row, 201);
      return row;
    });
  }

  async update(
    principal: Principal,
    catalogId: string,
    input: UpdateCatalogInput,
  ): Promise<CatalogRow> {
    return this.db.transaction(async (tx) => {
      const catalog = await this.requireCatalogAction(tx, principal, catalogId, "write");
      if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可修改");
      const [updated] = await tx
        .update(catalogs)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
        .returning();
      if (!updated) throw new DomainError("NOT_FOUND", "目录不存在");
      return {
        id: updated.id,
        name: updated.name,
        icon: updated.icon,
        parentId: updated.parentId,
        workspaceId: updated.workspaceId,
        position: updated.position,
        ...(await this.capabilities(tx, principal, updated.id)),
      };
    });
  }

  async move(
    principal: Principal,
    catalogId: string,
    input: MoveCatalogInput,
  ): Promise<CatalogRow> {
    const sessions = await this.subtreeSessions(principal, catalogId);
    const result = await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const catalog = await this.requireCatalogAction(tx, principal, catalogId, "move");
      if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可移动");
      if (input.parentId === catalogId) throw new DomainError("VALIDATION_ERROR", "不能移动到自身");
      const [target] = await tx
        .select()
        .from(catalogs)
        .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, input.parentId)))
        .limit(1);
      if (!target) throw new DomainError("NOT_FOUND", "目标目录不存在");
      const [targetWritable] = await tx
        .select({ id: catalogs.id })
        .from(catalogs)
        .where(
          and(
            eq(catalogs.tenantId, principal.tenantId),
            eq(catalogs.id, target.id),
            catalogActionSql(principal, "write"),
          ),
        )
        .limit(1);
      if (!targetWritable) throw new DomainError("NOT_FOUND", "目标目录不可编辑");
      const subtree = await collectSubtree(tx, principal.tenantId, catalogId);
      const subtreeIds = subtree.map((row) => row.id);
      if (subtreeIds.includes(input.parentId))
        throw new DomainError("VALIDATION_ERROR", "不能移动到自身的子目录中");
      const subtreeDepth = Math.max(0, ...subtree.map((row) => row.depth));
      const targetDepth = await ancestorDepth(tx, principal.tenantId, input.parentId);
      if (targetDepth + 1 + subtreeDepth > MAX_CATALOG_DEPTH)
        throw new DomainError("VALIDATION_ERROR", "目录层级过深");
      const destination = await workspaceAccess(tx, principal, target.workspaceId);
      const crossWorkspace = target.workspaceId !== catalog.workspaceId;
      if (crossWorkspace) {
        const preview = await previewTransfer(tx, principal, {
          kind: "catalog",
          resourceId: catalogId,
          targetCatalogId: input.parentId,
        });
        if (preview.token !== input.authorizationPreview)
          throw new DomainError("CONFLICT", "请确认最新的跨空间权限影响预览后再移动");
        await tx.execute(
          sql`with recursive subtree as (select id from catalogs where tenant_id=${principal.tenantId} and id=${catalogId} union all select c.id from catalogs c join subtree s on c.parent_id=s.id where c.tenant_id=${principal.tenantId}) update document_shares set revoked_at=statement_timestamp() where tenant_id=${principal.tenantId} and document_id in(select d.id from documents d where d.tenant_id=${principal.tenantId} and d.catalog_id in(select id from subtree))`,
        );
        const [blocked] = await tx
          .select({ id: catalogs.id })
          .from(catalogs)
          .where(
            and(
              eq(catalogs.tenantId, principal.tenantId),
              sql`${catalogs.id} = any(${sql.param(subtreeIds)}::text[])`,
              sql`not ${catalogActionSql(principal, "move")}`,
            ),
          )
          .limit(1);
        if (blocked) throw new DomainError("CONFLICT", "子目录缺少移动权限");
        const [foreignDocuments] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(documents)
          .where(
            and(
              eq(documents.tenantId, principal.tenantId),
              sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
              sql`not ${documentActionSql(principal, "manage")}`,
            ),
          );
        if ((foreignDocuments?.count ?? 0) > 0)
          throw new DomainError("CONFLICT", "跨空间移动需要拥有子树内全部文档");
      }
      const siblings = await tx
        .select({ id: catalogs.id })
        .from(catalogs)
        .where(
          and(
            eq(catalogs.tenantId, principal.tenantId),
            eq(catalogs.parentId, input.parentId),
            ne(catalogs.id, catalogId),
          ),
        )
        .orderBy(asc(catalogs.position), asc(catalogs.id));
      const insertIndex =
        input.beforeId === null
          ? siblings.length
          : siblings.findIndex((row) => row.id === input.beforeId);
      if (insertIndex < 0) throw new DomainError("CONFLICT", "目标位置已变化");
      const order = siblings.map((row) => row.id);
      order.splice(insertIndex, 0, catalogId);
      await renumberCatalogSiblings(tx, principal.tenantId, order);
      const [updated] = await tx
        .update(catalogs)
        .set({
          parentId: input.parentId,
          workspaceId: target.workspaceId,
          position: insertIndex,
          updatedAt: new Date(),
        })
        .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
        .returning();
      if (!updated) throw new DomainError("NOT_FOUND", "目录不存在");
      if (crossWorkspace) {
        await tx
          .update(catalogs)
          .set({ workspaceId: target.workspaceId })
          .where(
            and(
              eq(catalogs.tenantId, principal.tenantId),
              sql`${catalogs.id} = any(${sql.param(subtreeIds)}::text[])`,
              ne(catalogs.id, catalogId),
            ),
          );
        const movingDocuments = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.tenantId, principal.tenantId),
              sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
            ),
          );
        const oldRecipients = new Map<string, string[]>();
        for (const d of movingDocuments)
          oldRecipients.set(d.id, await documentRecipients(tx, principal.tenantId, d.id));
        await tx
          .update(documents)
          .set({
            workspaceId: target.workspaceId,
            accessMode: sql`case when ${documents.accessMode} = 'workspace-inherited' and ${destination.workspace.kind} <> 'team' then 'restricted' when ${documents.accessMode} = 'personal' and ${destination.workspace.kind} <> 'personal' then 'restricted' else ${documents.accessMode} end`,
            metadataRevision: sql`${documents.metadataRevision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(documents.tenantId, principal.tenantId),
              sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
            ),
          );
        for (const d of movingDocuments) {
          const recipients = new Set([
            ...(oldRecipients.get(d.id) ?? []),
            ...(await documentRecipients(tx, principal.tenantId, d.id)),
          ]);
          const eventKey = `catalog-move:${randomUUID()}`;
          await insertNotifications(
            tx,
            [...recipients].map((recipientId) => ({
              tenantId: principal.tenantId,
              actorId: principal.identityId,
              recipientId,
              type: "permission",
              eventKey,
              documentId: d.id,
              workspaceId: target.workspaceId,
              message: "一篇文档随目录移动到其他空间，访问范围可能变化",
            })),
          );
        }
      }
      await requireWorkspaceDocumentManagers(tx, principal.tenantId, updated.workspaceId);
      return {
        id: updated.id,
        name: updated.name,
        icon: updated.icon,
        parentId: updated.parentId,
        workspaceId: updated.workspaceId,
        position: updated.position,
        ...(await this.capabilities(tx, principal, updated.id)),
      };
    });
    for (const session of sessions)
      this.revoker.revokeDocumentSessions(session.document_id, session.generation_id);
    return result;
  }

  async deletionImpact(principal: Principal, catalogId: string) {
    const [catalog] = await this.db
      .select()
      .from(catalogs)
      .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
      .limit(1);
    if (!catalog) throw new DomainError("NOT_FOUND", "目录不存在");
    const [allowed] = await this.db
      .select({ id: catalogs.id })
      .from(catalogs)
      .where(
        and(
          eq(catalogs.tenantId, principal.tenantId),
          eq(catalogs.id, catalogId),
          catalogActionSql(principal, "manage"),
        ),
      )
      .limit(1);
    if (!allowed) throw new DomainError("NOT_FOUND", "目录不存在或无管理权限");
    if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可删除");
    const subtree = await collectSubtree(this.db, principal.tenantId, catalogId);
    const subtreeIds = subtree.map((row) => row.id);
    const [blockedDocument] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
          sql`not (${documentActionSql(principal, "read")} and ${documentActionSql(principal, "manage")})`,
        ),
      )
      .limit(1);
    if (blockedDocument) throw new DomainError("CONFLICT", "部分内容不可管理，无法获取删除预览");
    const [documentCount] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
          ne(documents.status, "trashed"),
        ),
      );
    return {
      catalogCount: subtreeIds.length - 1,
      documentCount: documentCount?.count ?? 0,
    };
  }

  async delete(principal: Principal, catalogId: string): Promise<void> {
    const sessions = await this.subtreeSessions(principal, catalogId);
    await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const catalog = await this.requireCatalogAction(tx, principal, catalogId);
      if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可删除");
      const subtree = await collectSubtree(tx, principal.tenantId, catalogId);
      const subtreeIds = subtree.map((row) => row.id);
      const rootId = await ensureRootCatalog(tx, principal.tenantId, catalog.workspaceId);
      const [blocked] = await tx
        .select({ id: catalogs.id })
        .from(catalogs)
        .where(
          and(
            eq(catalogs.tenantId, principal.tenantId),
            sql`${catalogs.id} = any(${sql.param(subtreeIds)}::text[])`,
            sql`not ${catalogActionSql(principal, "manage")}`,
          ),
        )
        .limit(1);
      if (blocked) throw new DomainError("CONFLICT", "子目录缺少管理权限");
      const [foreignDocument] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
            sql`not ${documentActionSql(principal, "manage")}`,
          ),
        )
        .limit(1);
      if (foreignDocument)
        throw new DomainError("CONFLICT", "目录中包含其他成员的文档，请先移出后再删除");
      const affectedDocuments = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
            ne(documents.status, "trashed"),
          ),
        );
      const now = new Date();
      if (affectedDocuments.length) {
        const documentIds = affectedDocuments.map((row) => row.id);
        for (const documentId of documentIds) {
          const recipients = await documentRecipients(tx, principal.tenantId, documentId);
          await insertNotifications(
            tx,
            recipients.map((recipientId) => ({
              tenantId: principal.tenantId,
              actorId: principal.identityId,
              recipientId,
              type: "deleted",
              eventKey: `catalog-delete:${randomUUID()}`,
              documentId,
              workspaceId: catalog.workspaceId,
              message: "一篇与你有关的文档随目录移入回收站",
            })),
          );
        }
        // Re-home to the workspace root so the catalog FK survives deletion; docs land in trash.
        await tx
          .update(documents)
          .set({
            status: "trashed",
            catalogId: rootId,
            deletedAt: now,
            updatedAt: now,
            metadataRevision: sql`${documents.metadataRevision} + 1`,
          })
          .where(
            and(
              eq(documents.tenantId, principal.tenantId),
              sql`${documents.id} = any(${sql.param(documentIds)}::text[])`,
            ),
          );
        await tx.insert(documentAuditEvents).values(
          documentIds.map((documentId) => ({
            tenantId: principal.tenantId,
            actorIdentityId: principal.identityId,
            action: "document.trashed",
            resourceId: documentId,
            details: { operation: "catalog-delete", catalogId },
          })),
        );
      }
      // Delete deepest levels first so the self-referencing FK never sees a dangling parent.
      const maxDepth = Math.max(0, ...subtree.map((row) => row.depth));
      for (let depth = maxDepth; depth >= 0; depth -= 1) {
        const levelIds = subtree.filter((row) => row.depth === depth).map((row) => row.id);
        if (levelIds.length)
          await tx
            .delete(catalogs)
            .where(
              and(
                eq(catalogs.tenantId, principal.tenantId),
                sql`${catalogs.id} = any(${sql.param(levelIds)}::text[])`,
              ),
            );
      }
      await requireWorkspaceDocumentManagers(tx, principal.tenantId, catalog.workspaceId);
    });
    for (const session of sessions)
      this.revoker.revokeDocumentSessions(session.document_id, session.generation_id);
  }

  async locate(principal: Principal, documentId: string) {
    const [document] = await this.db
      .select({
        id: documents.id,
        workspaceId: documents.workspaceId,
        catalogId: sql<string | null>`case when exists (select 1 from catalogs located_catalog
          where located_catalog.tenant_id = ${principal.tenantId} and located_catalog.id = ${documents.catalogId}
            and ${catalogActionSql(principal, "read", { id: sql`located_catalog.id`, tenantId: sql`located_catalog.tenant_id`, workspaceId: sql`located_catalog.workspace_id` })}) then ${documents.catalogId} else null end`,
        workspaceName: workspaceNameSql(principal),
        workspaceIcon: sql<
          string | null
        >`case when ${spaceActionSql(principal, "read")} then ${workspaces.icon} else null end`,
        catalogPath: catalogPathSql(principal, {
          catalogId: documents.catalogId,
          workspaceId: documents.workspaceId,
        }),
      })
      .from(documents)
      .innerJoin(
        workspaces,
        and(eq(workspaces.tenantId, documents.tenantId), eq(workspaces.id, documents.workspaceId)),
      )
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.id, documentId),
          eq(documents.status, "active"),
          readable(principal),
        ),
      )
      .limit(1);
    if (!document) throw new DomainError("NOT_FOUND", "文档不存在或不可访问");
    return {
      documentId: document.id,
      workspaceId: document.workspaceId,
      workspaceName: document.workspaceName,
      workspaceIcon: document.workspaceIcon,
      catalogId: document.catalogId,
      catalogPath: document.catalogPath,
    };
  }
  private async subtreeSessions(principal: Principal, catalogId: string) {
    const rows = await this.db.execute<{
      document_id: string;
      generation_id: string;
    }>(sql`with recursive subtree as (
      select c.id from catalogs c where c.tenant_id = ${principal.tenantId} and c.id = ${catalogId}
      union all select c.id from catalogs c join subtree s on c.parent_id = s.id where c.tenant_id = ${principal.tenantId}
    ) select d.id as document_id, g.id as generation_id from documents d join subtree s on d.catalog_id = s.id join document_generations g on g.document_id = d.id and g.status = 'active' where d.tenant_id = ${principal.tenantId}`);
    return rows.rows;
  }
}
