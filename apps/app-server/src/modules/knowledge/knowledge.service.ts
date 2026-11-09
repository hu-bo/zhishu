import type { SessionInvalidator } from "../authorization/permissions.js";
import { lockKnowledgeTree } from "../../shared/knowledge-transaction.js";
import { catalogActionSql } from "../authorization/access.js";

import { documentRecipients, insertNotifications } from "../notifications/index.js";
import { documentActionSql, requireDocumentManager } from "../authorization/permissions.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import {
  catalogs,
  documents,
  documentAuditEvents,
  documentShares,
  documentGenerations,
  documentProjectionSnapshots,
  knowledgePresetInstallations,
  workspaces,
  resourceAcl,
  collaborationUpdates,
} from "../../../database/schema/index.js";
import {
  cloneContentWithFreshBlockIds,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
} from "@zhishu/document-contracts";
import { createKnowledgePresets } from "@zhishu/document-contracts/examples";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import {
  ensureRootCatalog,
  catalogPathSql,
  workspaceNameSql,
  previewTransfer,
  type TransferRequest,
} from "../catalogs/index.js";
import type { KnowledgeMoveInput, KnowledgeSearchInput } from "./knowledge.schema.js";
import { insertProjectionOutbox, createCollaborationStateFromContent } from "../documents/index.js";
import { requireWorkspaceOrganizer } from "../authorization/permissions.js";

function readable(principal: Principal) {
  return documentActionSql(principal, "read");
}
export class KnowledgeService {
  constructor(
    private readonly db: Database,
    private readonly maxDocuments: number,
    private readonly sessions: SessionInvalidator,
  ) {}
  previewTransfer(principal: Principal, input: TransferRequest) {
    return previewTransfer(this.db, principal, input);
  }
  async move(principal: Principal, documentId: string, input: KnowledgeMoveInput) {
    const result = await this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const [document] = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, principal.tenantId),
            eq(documents.id, documentId),
            eq(documents.status, "active"),
            documentActionSql(principal, "move"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) throw new DomainError("NOT_FOUND", "Document not found");
      if (document.metadataRevision !== input.metadataRevision)
        throw new DomainError("CONFLICT", "Document location changed");
      const oldRecipients = await documentRecipients(tx, principal.tenantId, documentId);
      await requireWorkspaceOrganizer(tx, principal, input.workspaceId);
      const [workspace] = await tx
        .select({ id: workspaces.id, kind: workspaces.kind })
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
            catalogActionSql(principal, "write"),
          ),
        )
        .limit(1);
      if (!catalog) throw new DomainError("NOT_FOUND", "Catalog is unavailable");
      if (document.workspaceId !== input.workspaceId) {
        const preview = await previewTransfer(tx, principal, {
          kind: "document",
          resourceId: documentId,
          targetCatalogId: input.catalogId,
        });
        if (preview.token !== input.authorizationPreview)
          throw new DomainError("CONFLICT", "请确认最新的跨空间权限影响预览后再移动");
        await tx
          .update(documentShares)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(documentShares.tenantId, principal.tenantId),
              eq(documentShares.documentId, documentId),
            ),
          );
      }
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
          accessMode:
            document.accessMode === "workspace-inherited" && workspace.kind !== "team"
              ? "restricted"
              : document.accessMode === "personal" && workspace.kind !== "personal"
                ? "restricted"
                : document.accessMode,
          catalogId: input.catalogId,
          metadataRevision: document.metadataRevision + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(documents.tenantId, principal.tenantId), eq(documents.id, documentId)));
      await requireDocumentManager(tx, principal.tenantId, documentId);
      if (document.workspaceId !== input.workspaceId) {
        const recipients = new Set([
          ...oldRecipients,
          ...(await documentRecipients(tx, principal.tenantId, documentId)),
        ]);
        const eventKey = `document-moved:${randomUUID()}`;
        await insertNotifications(
          tx,
          [...recipients].map((recipientId) => ({
            tenantId: principal.tenantId,
            actorId: principal.identityId,
            recipientId,
            type: "permission",
            eventKey,
            documentId,
            workspaceId: input.workspaceId,
            message: "一篇文档已移动到其他空间，访问范围可能变化",
          })),
        );
      }
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
    await this.sessions.document(principal.tenantId, documentId);
    return result;
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
        when 'mention' then '@' || (value#>>'{attrs,label}')
        when 'statusTag' then case value#>>'{attrs,status}' ${statusLabels} end
      end, ' ')
      from jsonb_path_query(${documentProjectionSnapshots.content},
        'strict $.** ? (@.type() == "object" && (@.type == "text" || @.type == "horizontalRule" || @.type == "statusTag" || @.type == "mention"))') as value), '')`;
    const pattern = `%${input.q.replace(/[\\%_]/gu, "\\$&")}%`;
    const titleMatch = ilike(documents.title, pattern);
    const rows = await this.db
      .select({
        id: documents.id,
        title: documents.title,
        icon: documents.icon,
        workspaceId: documents.workspaceId,
        workspaceName: workspaceNameSql(principal),
        catalogPath: catalogPathSql(
          principal,
          { catalogId: documents.catalogId, workspaceId: documents.workspaceId },
          false,
        ),
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
          path: row.catalogPath.map((segment) => segment.name),
          excerpt,
          match: row.titleMatch ? ("title" as const) : ("content" as const),
        };
      }),
    };
  }
  async initializePresets(principal: Principal, workspaceId: string) {
    const presets = createKnowledgePresets();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${principal.tenantId}`}, 718267))`,
      );
      await lockKnowledgeTree(tx, principal.tenantId, principal.identityId);
      const access = await requireWorkspaceOrganizer(tx, principal, workspaceId);
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
      if ((count?.count ?? 0) + pending.length > this.maxDocuments)
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
          accessMode:
            access.workspace.kind === "team"
              ? "workspace-inherited"
              : access.workspace.kind === "personal"
                ? "personal"
                : "restricted",
          catalogId: rootCatalog,
          title: preset.title,
          icon: preset.icon,
          createdBy: principal.identityId,
          position: (position?.value ?? 0) + results.length,
        });
        if (access.workspace.kind !== "team")
          await tx.insert(resourceAcl).values({
            tenantId: principal.tenantId,
            documentId,
            identityId: principal.identityId,
            role: "admin",
            createdBy: principal.identityId,
          });
        await requireDocumentManager(tx, principal.tenantId, documentId);
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
}
