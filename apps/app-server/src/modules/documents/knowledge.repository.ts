import { randomUUID } from "node:crypto";
import { and, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  catalogs,
  documents,
  documentAcl,
  documentAuditEvents,
  documentGenerations,
  documentJsonSnapshots,
  documentProjectionSnapshots,
  knowledgePresetInstallations,
  workspaces,
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
  KnowledgeMoveInput,
  KnowledgeSearchInput,
} from "./knowledge.schema.js";
import { hashStandardDocumentContent, summarizeDocumentContent } from "./document.repository.js";

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
        createdBy: "system",
      })
      .onConflictDoNothing();
    // Every workspace must expose a root catalog; backfill in bulk instead of per row.
    await this.db
      .execute(sql`insert into catalogs (tenant_id, id, workspace_id, parent_id, name, position, created_by)
      select w.tenant_id, 'cat_root_' || w.id, w.id, null, '根目录', 0, w.created_by from workspaces w
      where w.tenant_id = ${principal.tenantId}
        and not exists (select 1 from catalogs c where c.tenant_id = w.tenant_id and c.id = 'cat_root_' || w.id)`);
    return this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        icon: workspaces.icon,
        description: workspaces.description,
        createdBy: workspaces.createdBy,
        rootCatalogId: sql<string>`'cat_root_' || ${workspaces.id}`,
        // Literal workspaces.id: an interpolated column would render bare and bind to the subquery alias.
        documentCount: sql<number>`(select count(*)::int from ${documents} d where d.tenant_id = ${principal.tenantId} and d.workspace_id = workspaces.id and d.status = 'active' and (d.created_by = ${principal.identityId} or exists (select 1 from ${documentAcl} a where a.tenant_id = ${principal.tenantId} and a.document_id = d.id and a.identity_id = ${principal.identityId} and a.action in ('read', 'write', 'comment', 'export', 'ai'))))`,
      })
      .from(workspaces)
      .where(eq(workspaces.tenantId, principal.tenantId))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(100);
  }

  async createWorkspace(principal: Principal, input: CreateWorkspaceInput) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-quota:${principal.tenantId}`}, 718269))`,
      );
      await tx
        .insert(workspaces)
        .values({
          tenantId: principal.tenantId,
          id: "ws_default",
          name: "团队知识库",
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
          icon: input.icon ?? null,
          description: input.description,
          createdBy: principal.identityId,
        })
        .returning({
          id: workspaces.id,
          name: workspaces.name,
          icon: workspaces.icon,
          description: workspaces.description,
          createdBy: workspaces.createdBy,
        });
      if (!row) throw new Error("Workspace insert returned no row");
      const rootCatalogId = await ensureRootCatalog(
        tx,
        principal.tenantId,
        id,
        principal.identityId,
      );
      return { ...row, rootCatalogId, documentCount: 0 };
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
      from jsonb_path_query(case when ${documents.mode} = 'standard' then ${documentJsonSnapshots.content} else ${documentProjectionSnapshots.content} end,
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
        documentJsonSnapshots,
        and(
          eq(documentJsonSnapshots.tenantId, documents.tenantId),
          eq(documentJsonSnapshots.documentId, documents.id),
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
          mode: "standard",
          createdBy: principal.identityId,
          position: (position?.value ?? 0) + results.length,
        });
        await tx
          .insert(documentGenerations)
          .values({ id: generationId, documentId, schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION });
        const summary = summarizeDocumentContent(content);
        await tx.insert(documentJsonSnapshots).values({
          tenantId: principal.tenantId,
          documentId,
          content,
          contentHash: hashStandardDocumentContent(content),
          ...summary,
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
}
