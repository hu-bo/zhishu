import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  apiIdempotencyRecords,
  catalogs,
  documentAcl,
  documentAuditEvents,
  documents,
  workspaces,
} from "../../../database/schema/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { CreateCatalogInput, MoveCatalogInput, UpdateCatalogInput } from "./catalog.schema.js";

type DbExecutor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

/** Catalog trees are shallower than the legacy document tree cap; 16 edges below root is plenty. */
const MAX_CATALOG_DEPTH = 16;
const MAX_CATALOGS_PER_WORKSPACE = 500;
const MAX_CHILDREN_PER_NODE = 1000;

export function rootCatalogId(workspaceId: string): string {
  return `cat_root_${workspaceId}`;
}

/** Idempotent root provisioning; safe to call on every workspace materialization path. */
export async function ensureRootCatalog(
  db: DbExecutor,
  tenantId: string,
  workspaceId: string,
  createdBy = "system",
): Promise<string> {
  const id = rootCatalogId(workspaceId);
  await db
    .insert(catalogs)
    .values({
      tenantId,
      id,
      workspaceId,
      parentId: null,
      name: "根目录",
      position: 0,
      createdBy,
    })
    .onConflictDoNothing();
  return id;
}

function readable(principal: Principal) {
  return sql`(${documents.createdBy} = ${principal.identityId} or exists (select 1 from ${documentAcl} a where a.tenant_id = ${principal.tenantId} and a.document_id = ${documents.id} and a.identity_id = ${principal.identityId} and a.action in ('read', 'write', 'comment', 'export', 'ai'))) `;
}
function writable(principal: Principal) {
  return sql<boolean>`(${documents.createdBy} = ${principal.identityId} or exists (select 1 from ${documentAcl} a where a.tenant_id = ${principal.tenantId} and a.document_id = ${documents.id} and a.identity_id = ${principal.identityId} and a.action = 'write'))`;
}

export type CatalogRow = {
  id: string;
  name: string;
  icon: string | null;
  parentId: string | null;
  workspaceId: string;
  position: number;
  canManage: boolean;
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

async function loadCreateReplay(
  tx: DbExecutor,
  input: { tenantId: string; subjectId: string; key: string; requestHash: string },
): Promise<CatalogRow | null> {
  const keyHash = createHash("sha256").update(input.key).digest("hex");
  const [record] = await tx
    .select()
    .from(apiIdempotencyRecords)
    .where(
      and(
        eq(apiIdempotencyRecords.tenantId, input.tenantId),
        eq(apiIdempotencyRecords.subjectId, input.subjectId),
        eq(apiIdempotencyRecords.operationId, "catalogs.create"),
        eq(apiIdempotencyRecords.keyHash, keyHash),
      ),
    )
    .limit(1);
  if (!record) return null;
  if (record.requestHash !== input.requestHash)
    throw new DomainError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已被其它请求使用");
  return record.responseBody as unknown as CatalogRow;
}

export class CatalogRepository {
  constructor(private readonly db: Database) {}

  private async requireOwnedCatalog(tx: DbExecutor, principal: Principal, catalogId: string) {
    const [catalog] = await tx
      .select()
      .from(catalogs)
      .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
      .for("update")
      .limit(1);
    if (!catalog) throw new DomainError("NOT_FOUND", "目录不存在");
    if (catalog.createdBy !== principal.identityId)
      throw new DomainError("NOT_FOUND", "目录不存在");
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
      })
      .from(catalogs)
      .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
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
        canManage: sql<boolean>`${catalogs.createdBy} = ${principal.identityId}`,
        // NOTE: reference the outer table by its literal name — inside a select builder,
        // interpolated ${catalogs.id} renders as bare "id" and would resolve to the subquery alias.
        hasChildren: sql<boolean>`(exists (select 1 from ${catalogs} c2 where c2.tenant_id = ${principal.tenantId} and c2.parent_id = catalogs.id) or exists (select 1 from ${documents} d2 where d2.tenant_id = ${principal.tenantId} and d2.catalog_id = catalogs.id and d2.status = 'active' and (d2.created_by = ${principal.identityId} or exists (select 1 from ${documentAcl} a2 where a2.tenant_id = ${principal.tenantId} and a2.document_id = d2.id and a2.identity_id = ${principal.identityId} and a2.action in ('read', 'write', 'comment', 'export', 'ai')))))`,
      })
      .from(catalogs)
      .where(
        and(
          eq(catalogs.tenantId, principal.tenantId),
          eq(catalogs.workspaceId, workspaceId),
          eq(catalogs.parentId, catalogId),
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
        canManage: sql<boolean>`${documents.createdBy} = ${principal.identityId}`,
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
        canManage: catalog.parentId !== null && catalog.createdBy === principal.identityId,
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
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ workspaceId, ...input }))
      .digest("hex");
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      if (idempotencyKey) {
        const replay = await loadCreateReplay(tx, {
          tenantId: principal.tenantId,
          subjectId: principal.identityId,
          key: idempotencyKey,
          requestHash,
        });
        if (replay) return replay;
      }
      const [workspace] = await tx
        .select({ id: workspaces.id, createdBy: workspaces.createdBy })
        .from(workspaces)
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)))
        .limit(1);
      if (!workspace) throw new DomainError("NOT_FOUND", "Workspace not found");
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
        canManage: true,
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
      if (idempotencyKey) {
        await tx.insert(apiIdempotencyRecords).values({
          tenantId: principal.tenantId,
          subjectId: principal.identityId,
          operationId: "catalogs.create",
          keyHash: createHash("sha256").update(idempotencyKey).digest("hex"),
          requestHash,
          responseStatus: 201,
          responseBody: row as unknown as Record<string, unknown>,
        });
      }
      return row;
    });
  }

  async update(
    principal: Principal,
    catalogId: string,
    input: UpdateCatalogInput,
  ): Promise<CatalogRow> {
    return this.db.transaction(async (tx) => {
      const catalog = await this.requireOwnedCatalog(tx, principal, catalogId);
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
        canManage: true,
      };
    });
  }

  async move(
    principal: Principal,
    catalogId: string,
    input: MoveCatalogInput,
  ): Promise<CatalogRow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      const catalog = await this.requireOwnedCatalog(tx, principal, catalogId);
      if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可移动");
      if (input.parentId === catalogId) throw new DomainError("VALIDATION_ERROR", "不能移动到自身");
      const [target] = await tx
        .select()
        .from(catalogs)
        .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, input.parentId)))
        .limit(1);
      if (!target) throw new DomainError("NOT_FOUND", "目标目录不存在");
      const subtree = await collectSubtree(tx, principal.tenantId, catalogId);
      const subtreeIds = subtree.map((row) => row.id);
      if (subtreeIds.includes(input.parentId))
        throw new DomainError("VALIDATION_ERROR", "不能移动到自身的子目录中");
      const subtreeDepth = Math.max(0, ...subtree.map((row) => row.depth));
      const targetDepth = await ancestorDepth(tx, principal.tenantId, input.parentId);
      if (targetDepth + 1 + subtreeDepth > MAX_CATALOG_DEPTH)
        throw new DomainError("VALIDATION_ERROR", "目录层级过深");
      const crossWorkspace = target.workspaceId !== catalog.workspaceId;
      if (crossWorkspace) {
        if (subtree.some((row) => row.created_by !== principal.identityId))
          throw new DomainError("CONFLICT", "跨空间移动需要拥有子树内全部目录");
        const [foreignDocuments] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(documents)
          .where(
            and(
              eq(documents.tenantId, principal.tenantId),
              sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
              ne(documents.createdBy, principal.identityId),
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
        await tx
          .update(documents)
          .set({ workspaceId: target.workspaceId, updatedAt: new Date() })
          .where(
            and(
              eq(documents.tenantId, principal.tenantId),
              sql`${documents.catalogId} = any(${sql.param(subtreeIds)}::text[])`,
            ),
          );
      }
      return {
        id: updated.id,
        name: updated.name,
        icon: updated.icon,
        parentId: updated.parentId,
        workspaceId: updated.workspaceId,
        position: updated.position,
        canManage: true,
      };
    });
  }

  async deletionImpact(principal: Principal, catalogId: string) {
    const [catalog] = await this.db
      .select()
      .from(catalogs)
      .where(and(eq(catalogs.tenantId, principal.tenantId), eq(catalogs.id, catalogId)))
      .limit(1);
    if (!catalog) throw new DomainError("NOT_FOUND", "目录不存在");
    if (catalog.createdBy !== principal.identityId)
      throw new DomainError("NOT_FOUND", "目录不存在");
    if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可删除");
    const subtree = await collectSubtree(this.db, principal.tenantId, catalogId);
    const subtreeIds = subtree.map((row) => row.id);
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
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      const catalog = await this.requireOwnedCatalog(tx, principal, catalogId);
      if (catalog.parentId === null) throw new DomainError("VALIDATION_ERROR", "根目录不可删除");
      const subtree = await collectSubtree(tx, principal.tenantId, catalogId);
      const subtreeIds = subtree.map((row) => row.id);
      const rootId = await ensureRootCatalog(tx, principal.tenantId, catalog.workspaceId);
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
    });
  }

  async locate(principal: Principal, documentId: string) {
    const [document] = await this.db
      .select({
        id: documents.id,
        workspaceId: documents.workspaceId,
        catalogId: documents.catalogId,
        workspaceName: workspaces.name,
        workspaceIcon: workspaces.icon,
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
    const ancestors = await this.db.execute<{ path: Array<{ id: string; name: string }> }>(
      sql`with recursive ancestors as (
        select id as cur_id, parent_id, jsonb_build_array(jsonb_build_object('id', id, 'name', name)) as path, 0 as depth
        from catalogs where tenant_id = ${principal.tenantId} and id = ${document.catalogId}
        union all
        select p.id, p.parent_id, jsonb_build_object('id', p.id, 'name', p.name) || a.path, a.depth + 1
        from catalogs p join ancestors a on p.id = a.parent_id and p.tenant_id = ${principal.tenantId}
        where a.depth < ${MAX_CATALOG_DEPTH + 1}
      ) select path from ancestors order by depth desc limit 1`,
    );
    return {
      documentId: document.id,
      workspaceId: document.workspaceId,
      workspaceName: document.workspaceName,
      workspaceIcon: document.workspaceIcon,
      catalogId: document.catalogId,
      catalogPath: ancestors.rows[0]?.path ?? [],
    };
  }
}
