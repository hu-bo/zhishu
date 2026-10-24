import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  catalogs,
  documents,
  documentAcl,
  documentAuditEvents,
  documentGenerations,
  documentProjectionSnapshots,
  knowledgePresetInstallations,
  workspaces,
  workspaceMembers,
  apiIdempotencyRecords,
  collaborationUpdates,
} from "../../../database/schema/index.js";
import {
  cloneContentWithFreshBlockIds,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
} from "@zhishu/document-contracts";
import type { KnowledgePreset } from "@zhishu/document-contracts/examples";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import { ensureRootCatalog } from "./catalog.repository.js";
import type {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  KnowledgeMoveInput,
  KnowledgeSearchInput,
  SetWorkspaceMemberInput,
} from "./knowledge.schema.js";
import { insertProjectionOutbox } from "./document.repository.js";
import { createCollaborationStateFromContent } from "./document.service.js";
import { requireWorkspaceOrganizer, workspaceAccess, workspaceRole } from "./workspace-access.js";
import { workspaceSchema } from "./knowledge.schema.js";

function readable(principal: Principal) {
  return sql`(${documents.createdBy} = ${principal.identityId} or exists (select 1 from ${documentAcl} a where a.tenant_id = ${principal.tenantId} and a.document_id = ${documents.id} and a.identity_id = ${principal.identityId} and a.action in ('read', 'write', 'comment', 'export', 'ai'))) `;
}

export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  async listWorkspaces(principal: Principal) {
    await this.db
      .insert(workspaces)
      .values({
        tenantId: principal.tenantId,
        id: "ws_default",
        name: "团队知识库",
        kind: "team",
        createdBy: "system",
      })
      .onConflictDoNothing();
    // Every workspace must expose a root catalog; backfill in bulk instead of per row.
    await this.db
      .execute(sql`insert into catalogs (tenant_id, id, workspace_id, parent_id, name, position, created_by)
      select w.tenant_id, 'cat_root_' || w.id, w.id, null, '根目录', 0, w.created_by from workspaces w
      where w.tenant_id = ${principal.tenantId}
        and not exists (select 1 from catalogs c where c.tenant_id = w.tenant_id and c.id = 'cat_root_' || w.id)`);
    const rows = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        kind: workspaces.kind,
        personalOwnerId: workspaces.personalOwnerId,
        icon: workspaces.icon,
        description: workspaces.description,
        createdBy: workspaces.createdBy,
        createdAt: workspaces.createdAt,
        memberCount: sql<number>`case when ${workspaces.kind} = 'personal' then 1 else (select count(*)::int from workspace_members m where m.tenant_id = ${principal.tenantId} and m.workspace_id = workspaces.id) + case when ${workspaces.createdBy} = 'system' then 0 else 1 end end`,
        memberRole: sql<
          "admin" | "editor" | "viewer" | null
        >`(select m.role from workspace_members m where m.tenant_id = ${principal.tenantId} and m.workspace_id = workspaces.id and m.identity_id = ${principal.identityId})`,
        rootCatalogId: sql<string>`'cat_root_' || ${workspaces.id}`,
        // Literal workspaces.id: an interpolated column would render bare and bind to the subquery alias.
        documentCount: sql<number>`(select count(*)::int from ${documents} d where d.tenant_id = ${principal.tenantId} and d.workspace_id = workspaces.id and d.status = 'active' and (d.created_by = ${principal.identityId} or exists (select 1 from ${documentAcl} a where a.tenant_id = ${principal.tenantId} and a.document_id = d.id and a.identity_id = ${principal.identityId} and a.action in ('read', 'write', 'comment', 'export', 'ai'))))`,
      })
      .from(workspaces)
      .where(eq(workspaces.tenantId, principal.tenantId))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(100);
    return rows.map(({ memberRole, createdAt, ...row }) => {
      const role = workspaceRole(row, principal.identityId, memberRole);
      return {
        ...row,
        role,
        createdAt: createdAt.toISOString(),
        canManage: role === "owner" || role === "admin",
        canOrganize: role !== "viewer",
      };
    });
  }

  async createWorkspace(
    principal: Principal,
    input: CreateWorkspaceInput,
    idempotencyKey?: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-quota:${principal.tenantId}`}, 718269))`,
      );
      const keyHash = idempotencyKey
        ? createHash("sha256").update(idempotencyKey).digest("hex")
        : null;
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (keyHash) {
        const [record] = await tx
          .select()
          .from(apiIdempotencyRecords)
          .where(
            and(
              eq(apiIdempotencyRecords.tenantId, principal.tenantId),
              eq(apiIdempotencyRecords.subjectId, principal.identityId),
              eq(apiIdempotencyRecords.operationId, "workspaces.create"),
              eq(apiIdempotencyRecords.keyHash, keyHash),
            ),
          )
          .limit(1);
        if (record) {
          const legacyInput = Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== "kind"),
          );
          const legacyReplay =
            input.kind === "team" &&
            !("kind" in record.responseBody) &&
            record.requestHash ===
              createHash("sha256").update(JSON.stringify(legacyInput)).digest("hex");
          if (record.requestHash !== requestHash && !legacyReplay)
            throw new DomainError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key 已被其它请求使用");
          // Old receipts predate the classification columns. Never infer personal ownership.
          return workspaceSchema.parse({
            kind: "unclassified",
            personalOwnerId: null,
            ...record.responseBody,
          });
        }
      }
      await tx
        .insert(workspaces)
        .values({
          tenantId: principal.tenantId,
          id: "ws_default",
          name: "团队知识库",
          kind: "team",
          createdBy: "system",
        })
        .onConflictDoNothing();
      const [count] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(workspaces)
        .where(eq(workspaces.tenantId, principal.tenantId));
      if ((count?.count ?? 0) >= 100)
        throw new DomainError("RESOURCE_LIMIT", "Workspace limit reached");
      const id = `ws_${randomUUID()}`;
      const [row] = await tx
        .insert(workspaces)
        .values({
          id,
          tenantId: principal.tenantId,
          name: input.name,
          kind: input.kind,
          personalOwnerId: input.kind === "personal" ? principal.identityId : null,
          icon: input.icon ?? null,
          description: input.description,
          createdBy: principal.identityId,
        })
        .returning({
          id: workspaces.id,
          name: workspaces.name,
          kind: workspaces.kind,
          personalOwnerId: workspaces.personalOwnerId,
          icon: workspaces.icon,
          description: workspaces.description,
          createdBy: workspaces.createdBy,
          createdAt: workspaces.createdAt,
        });
      if (!row) throw new Error("Workspace insert returned no row");
      const rootCatalogId = await ensureRootCatalog(
        tx,
        principal.tenantId,
        id,
        principal.identityId,
      );
      const result = {
        ...row,
        createdAt: row.createdAt.toISOString(),
        rootCatalogId,
        documentCount: 0,
        memberCount: 1,
        role: "owner" as const,
        canManage: true,
        canOrganize: true,
      };
      if (keyHash)
        await tx.insert(apiIdempotencyRecords).values({
          tenantId: principal.tenantId,
          subjectId: principal.identityId,
          operationId: "workspaces.create",
          keyHash,
          requestHash,
          responseStatus: 201,
          responseBody: result,
        });
      return result;
    });
  }

  async move(principal: Principal, documentId: string, input: KnowledgeMoveInput) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      const [document] = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.id, documentId),
            eq(documents.status, "active"),
            eq(documents.createdBy, principal.identityId),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) throw new DomainError("NOT_FOUND", "Document not found");
      if (document.metadataRevision !== input.metadataRevision)
        throw new DomainError("CONFLICT", "Document location changed");
      await requireWorkspaceOrganizer(tx, principal, input.workspaceId);
      const [workspace] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(
          and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, input.workspaceId)),
        )
        .limit(1);
      if (!workspace) throw new DomainError("NOT_FOUND", "Workspace not found");
      const [catalog] = await tx
        .select({ id: catalogs.id })
        .from(catalogs)
        .where(
          and(
            eq(catalogs.tenantId, principal.tenantId),
            eq(catalogs.id, input.catalogId),
            eq(catalogs.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      if (!catalog) throw new DomainError("NOT_FOUND", "Catalog is unavailable");
      const siblings = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.catalogId, input.catalogId),
            eq(documents.status, "active"),
            ne(documents.id, documentId),
          ),
        )
        .orderBy(asc(documents.position), asc(documents.id));
      const insertIndex =
        input.beforeId === null
          ? siblings.length
          : siblings.findIndex((row) => row.id === input.beforeId);
      if (insertIndex < 0) throw new DomainError("CONFLICT", "Drop target changed");
      const order = siblings.map((row) => row.id);
      order.splice(insertIndex, 0, documentId);
      // One statement keeps order changes bounded even for large sibling groups.
      await tx.execute(
        sql`update documents d set position = ordered.ordinality - 1 from unnest(${sql.param(order)}::text[]) with ordinality as ordered(id, ordinality) where d.tenant_id = ${principal.tenantId} and d.id = ordered.id`,
      );
      await tx
        .update(documents)
        .set({
          workspaceId: input.workspaceId,
          catalogId: input.catalogId,
          metadataRevision: document.metadataRevision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.tenantId, principal.tenantId), eq(documents.id, documentId)));
      await tx.insert(documentAuditEvents).values({
        tenantId: principal.tenantId,
        actorIdentityId: principal.identityId,
        action: "document.title-updated",
        resourceId: documentId,
        details: {
          operation: "directory-move",
          fromWorkspaceId: document.workspaceId,
          workspaceId: input.workspaceId,
          catalogId: input.catalogId,
        },
      });
      return { metadataRevision: document.metadataRevision + 1 };
    });
  }

  async search(principal: Principal, input: KnowledgeSearchInput) {
    const statusLabels = sql.join(
      DOCUMENT_STATUSES.map((status) => sql`when ${status} then ${DOCUMENT_STATUS_LABELS[status]}`),
      sql` `,
    );
    const text = sql<string>`coalesce((select string_agg(
      case value->>'type'
        when 'text' then value->>'text'
        when 'horizontalRule' then value#>>'{attrs,label}'
        when 'statusTag' then case value#>>'{attrs,status}' ${statusLabels} end
      end, ' ')
      from jsonb_path_query(${documentProjectionSnapshots.content},
        'strict $.** ? (@.type() == "object" && (@.type == "text" || @.type == "horizontalRule" || @.type == "statusTag"))') as value), '')`;
    const pattern = `%${input.q.replace(/[\\%_]/gu, "\\$&")}%`;
    const titleMatch = ilike(documents.title, pattern);
    const rows = await this.db
      .select({
        id: documents.id,
        title: documents.title,
        icon: documents.icon,
        workspaceId: documents.workspaceId,
        workspaceName: workspaces.name,
        text,
        titleMatch: sql<boolean>`${titleMatch}`,
      })
      .from(documents)
      .innerJoin(
        workspaces,
        and(eq(workspaces.tenantId, documents.tenantId), eq(workspaces.id, documents.workspaceId)),
      )
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .leftJoin(
        documentProjectionSnapshots,
        and(
          eq(documentProjectionSnapshots.tenantId, documents.tenantId),
          eq(documentProjectionSnapshots.documentId, documents.id),
          eq(documentProjectionSnapshots.generationId, documentGenerations.id),
        ),
      )
      .where(
        and(
          eq(documents.tenantId, principal.tenantId),
          eq(documents.status, "active"),
          readable(principal),
          ...(input.workspaceId ? [eq(documents.workspaceId, input.workspaceId)] : []),
          or(titleMatch, ilike(text, pattern)),
        ),
      )
      .orderBy(sql`${titleMatch} desc`, sql`${documents.updatedAt} desc`, asc(documents.id))
      .limit(input.limit + 1);
    const resultIds = rows.slice(0, input.limit).map((row) => row.id);
    const paths = new Map<string, string[]>();
    if (resultIds.length) {
      // Catalog structure is tenant-visible; the implicit root label stays out of the path.
      const ancestors = await this.db.execute<{
        result_id: string;
        path: string[];
      }>(sql`with recursive ancestors as (
        select d.id as result_id, c.parent_id as parent_id, case when c.parent_id is null then array[]::text[] else array[c.name] end as path, array[c.id] as visited, 0 as depth
        from documents d join catalogs c on c.tenant_id = d.tenant_id and c.id = d.catalog_id
        where d.tenant_id = ${principal.tenantId} and d.id = any(${sql.param(resultIds)}::text[])
        union all select a.result_id, p.parent_id, case when p.parent_id is null then a.path else array[p.name] || a.path end, a.visited || p.id, a.depth + 1
        from catalogs p join ancestors a on p.id = a.parent_id
        where p.tenant_id = ${principal.tenantId} and not p.id = any(a.visited) and a.depth < 17
      ) select distinct on(result_id) result_id, path from ancestors order by result_id, depth desc`);
      for (const row of ancestors.rows) paths.set(row.result_id, row.path);
    }
    return {
      hasMore: rows.length > input.limit,
      items: rows.slice(0, input.limit).map((row) => {
        const index = row.text.toLocaleLowerCase().indexOf(input.q.toLocaleLowerCase());
        const start = Math.max(0, index - 36);
        const excerpt = `${start ? "…" : ""}${row.text.slice(start, start + 160)}${row.text.length > start + 160 ? "…" : ""}`;
        return {
          id: row.id,
          title: row.title,
          icon: row.icon,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName,
          path: paths.get(row.id) ?? [],
          excerpt,
          match: row.titleMatch ? ("title" as const) : ("content" as const),
        };
      }),
    };
  }

  async initializePresets(
    principal: Principal,
    workspaceId: string,
    presets: readonly KnowledgePreset[],
    maxDocuments: number,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${principal.tenantId}`}, 718267))`,
      );
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      await requireWorkspaceOrganizer(tx, principal, workspaceId);
      const [workspace] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)))
        .limit(1);
      if (!workspace) throw new DomainError("NOT_FOUND", "Workspace not found");
      const installed = await tx
        .select()
        .from(knowledgePresetInstallations)
        .where(
          and(
            eq(knowledgePresetInstallations.tenantId, principal.tenantId),
            eq(knowledgePresetInstallations.identityId, principal.identityId),
            eq(knowledgePresetInstallations.workspaceId, workspaceId),
          ),
        );
      const [count] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.tenantId, principal.tenantId));
      const pending = presets.filter(
        (preset) => !installed.some((row) => row.presetId === preset.id),
      );
      if ((count?.count ?? 0) + pending.length > maxDocuments)
        throw new DomainError("RESOURCE_LIMIT", "Document quota reached");
      const rootCatalog = await ensureRootCatalog(
        tx,
        principal.tenantId,
        workspaceId,
        principal.identityId,
      );
      const [position] = await tx
        .select({ value: sql<number>`coalesce(max(${documents.position}), -1)::int + 1` })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.workspaceId, workspaceId),
            eq(documents.catalogId, rootCatalog),
          ),
        );
      const results: Array<{
        presetId: string;
        documentId: string;
        status: "created" | "existing" | "removed";
      }> = [];
      for (const preset of presets) {
        const existing = installed.find((row) => row.presetId === preset.id);
        if (existing) {
          const [document] = await tx
            .select({ id: documents.id })
            .from(documents)
            .where(
              and(
                eq(documents.tenantId, principal.tenantId),
                eq(documents.id, existing.documentId),
                eq(documents.status, "active"),
                readable(principal),
              ),
            )
            .limit(1);
          results.push({
            presetId: preset.id,
            documentId: existing.documentId,
            status: document ? "existing" : "removed",
          });
          continue;
        }
        const documentId = `doc_${randomUUID()}`;
        const generationId = `gen_${randomUUID()}`;
        const content = cloneContentWithFreshBlockIds(preset.content);
        await tx.insert(documents).values({
          id: documentId,
          tenantId: principal.tenantId,
          workspaceId,
          catalogId: rootCatalog,
          title: preset.title,
          icon: preset.icon,
          createdBy: principal.identityId,
          position: (position?.value ?? 0) + results.length,
        });
        // Preset documents are collaborative from the start: seed the initial Yjs
        // update plus a projection outbox entry so the document opens in the live
        // editor immediately (mirrors repository.create with an initial update).
        const updateBytes = createCollaborationStateFromContent(content);
        const updateHash = createHash("sha256").update(updateBytes).digest("hex");
        await tx.insert(documentGenerations).values({
          id: generationId,
          documentId,
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
          durableSeq: 1,
        });
        await tx.insert(collaborationUpdates).values({
          documentId,
          generationId,
          updateHash,
          sourceUpdateHash: updateHash,
          updateBytes: Buffer.from(updateBytes),
          durableSeq: 1,
          createdBy: principal.identityId,
        });
        await insertProjectionOutbox(tx, {
          tenantId: principal.tenantId,
          documentId,
          generationId,
          durableSeq: 1,
          updateHash,
          contentChanged: true,
          content,
        });
        await tx.insert(knowledgePresetInstallations).values({
          tenantId: principal.tenantId,
          identityId: principal.identityId,
          workspaceId,
          presetId: preset.id,
          documentId,
        });
        await tx.insert(documentAuditEvents).values({
          tenantId: principal.tenantId,
          actorIdentityId: principal.identityId,
          action: "document.created",
          resourceId: documentId,
          generationId,
          details: { presetId: preset.id, initialization: true },
        });
        results.push({ presetId: preset.id, documentId, status: "created" });
      }
      return { items: results };
    });
  }

  async updateWorkspace(principal: Principal, workspaceId: string, input: UpdateWorkspaceInput) {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      const access = await workspaceAccess(tx, principal, workspaceId);
      if (!access.canManage) throw new DomainError("NOT_FOUND", "空间不存在或无管理权限");
      await tx
        .update(workspaces)
        .set(input)
        .where(and(eq(workspaces.tenantId, principal.tenantId), eq(workspaces.id, workspaceId)));
    });
    const updated = (await this.listWorkspaces(principal)).find((row) => row.id === workspaceId);
    if (!updated) throw new DomainError("NOT_FOUND", "空间不存在");
    return updated;
  }

  async listMembers(principal: Principal, workspaceId: string) {
    const { workspace } = await workspaceAccess(this.db, principal, workspaceId);
    const rows = await this.db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.tenantId, principal.tenantId),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      )
      .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.identityId))
      .limit(500);
    const members = (workspace.kind === "personal" ? [] : rows).map((row) => ({
      identityId: row.identityId,
      displayName: row.displayName,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    }));
    return workspace.kind !== "personal" && workspace.createdBy === "system"
      ? members
      : [
          {
            identityId: workspace.createdBy,
            displayName:
              workspace.createdBy === principal.identityId
                ? principal.displayName
                : workspace.createdBy,
            role: "owner" as const,
            createdAt: workspace.createdAt.toISOString(),
          },
          ...members,
        ];
  }

  async setMember(
    principal: Principal,
    workspaceId: string,
    identityId: string,
    input: SetWorkspaceMemberInput,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      const access = await workspaceAccess(tx, principal, workspaceId);
      if (!access.canManage) throw new DomainError("NOT_FOUND", "空间不存在或无管理权限");
      if (access.workspace.kind === "personal")
        throw new DomainError("VALIDATION_ERROR", "个人空间不支持添加成员，请通过文档分享授权");
      if (identityId === access.workspace.createdBy)
        throw new DomainError("VALIDATION_ERROR", "空间所有者不能降级或移除");
      const [existing] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.tenantId, principal.tenantId),
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.identityId, identityId),
          ),
        )
        .limit(1);
      if (access.role !== "owner" && (input.role === "admin" || existing?.role === "admin"))
        throw new DomainError("VALIDATION_ERROR", "只有空间所有者可以管理管理员");
      if (!existing) {
        const [count] = await tx
          .select({ value: sql<number>`count(*)::int` })
          .from(workspaceMembers)
          .where(
            and(
              eq(workspaceMembers.tenantId, principal.tenantId),
              eq(workspaceMembers.workspaceId, workspaceId),
            ),
          );
        if ((count?.value ?? 0) >= 499)
          throw new DomainError("RESOURCE_LIMIT", "空间成员数量已达上限");
      }
      const [member] = await tx
        .insert(workspaceMembers)
        .values({ tenantId: principal.tenantId, workspaceId, identityId, ...input })
        .onConflictDoUpdate({
          target: [
            workspaceMembers.tenantId,
            workspaceMembers.workspaceId,
            workspaceMembers.identityId,
          ],
          set: input,
        })
        .returning();
      if (!member) throw new Error("Member insert returned no row");
      return {
        identityId,
        displayName: member.displayName,
        role: member.role,
        createdAt: member.createdAt.toISOString(),
      };
    });
  }

  async removeMember(principal: Principal, workspaceId: string, identityId: string) {
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${principal.tenantId}`}, 718268))`,
      );
      const access = await workspaceAccess(tx, principal, workspaceId);
      if (!access.canManage) throw new DomainError("NOT_FOUND", "空间不存在或无管理权限");
      if (access.workspace.kind === "personal")
        throw new DomainError("VALIDATION_ERROR", "个人空间不支持成员管理，请通过文档分享管理授权");
      if (identityId === access.workspace.createdBy)
        throw new DomainError("VALIDATION_ERROR", "空间所有者不能降级或移除");
      const [member] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.tenantId, principal.tenantId),
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.identityId, identityId),
          ),
        )
        .limit(1);
      if (member?.role === "admin" && access.role !== "owner")
        throw new DomainError("VALIDATION_ERROR", "只有空间所有者可以管理管理员");
      await tx
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.tenantId, principal.tenantId),
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.identityId, identityId),
          ),
        );
    });
  }
}
