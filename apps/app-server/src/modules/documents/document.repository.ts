import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { DomainError } from "../../shared/domain-error.js";
import {
  assetReferences,
  assets,
  collaborationUpdates,
  documentAuditEvents,
  documentAcl,
  documentFavorites,
  documentGenerations,
  documentOutbox,
  documentProjectionSnapshots,
  documentRecents,
  documentVersions,
  documents,
} from "../../../database/schema/index.js";
import type { DocumentPermissionAction } from "./document.permissions.js";
import type { DocumentContent } from "@zhishu/document-contracts";

const PROJECTION_LEASE_MS = 30_000;
const PROJECTION_MAX_ATTEMPTS = 8;
const PROJECTION_RETRY_BASE_MS = 1_000;
const PROJECTION_RETRY_MAX_MS = 5 * 60_000;

type ProjectionSummary = { blockCount: number; textLength: number; assetCount: number };
const emptyDocumentContent: DocumentContent = { type: "doc", content: [] };
export type ClaimedProjectionJob = {
  id: string;
  leaseToken: string;
  tenantId: string;
  documentId: string;
  generationId: string;
  durableSeq: number;
  content: DocumentContent;
  contentHash: string;
  summary: ProjectionSummary;
};

function summarizeDocumentContent(content: DocumentContent): ProjectionSummary {
  let blockCount = 0;
  let textLength = 0;
  let assetCount = 0;
  const pending: unknown[] = [...content.content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as {
      type?: unknown;
      text?: unknown;
      attrs?: { blockId?: unknown };
      content?: unknown;
    };
    if (typeof node.attrs?.blockId === "string") blockCount += 1;
    if (node.type === "image") assetCount += 1;
    if (node.type === "text" && typeof node.text === "string") textLength += [...node.text].length;
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return { blockCount, textLength, assetCount };
}

function hashDocumentContent(content: DocumentContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

type DocumentAuditAction =
  | "document.created"
  | "document.copied"
  | "document.title-updated"
  | "document.archived"
  | "document.trashed"
  | "document.restored"
  | "document.permanently-deleted"
  | "document.version-created"
  | "document.version-restored"
  | "document.acl-updated"
  | "document.acl-removed"
  | "document.schema-migrated"
  | "document.block-ids-repaired";

type DocumentAuditExecutor = Pick<Database, "insert">;

async function insertDocumentAudit(
  executor: DocumentAuditExecutor,
  input: {
    tenantId: string;
    actorIdentityId: string;
    action: DocumentAuditAction;
    resourceId: string;
    generationId?: string;
    requestId?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.insert(documentAuditEvents).values({
    tenantId: input.tenantId,
    actorIdentityId: input.actorIdentityId,
    action: input.action,
    resourceType: "document",
    resourceId: input.resourceId,
    generationId: input.generationId ?? null,
    requestId: input.requestId ?? null,
    details: input.details ?? {},
  });
}

type ProjectionOutboxExecutor = Pick<Database, "insert" | "update">;

async function insertProjectionOutbox(
  executor: ProjectionOutboxExecutor,
  input: {
    tenantId: string;
    documentId: string;
    generationId: string;
    durableSeq: number;
    updateHash: string;
    contentChanged: boolean;
    content: DocumentContent;
  },
): Promise<void> {
  await executor.insert(documentOutbox).values({
    tenantId: input.tenantId,
    documentId: input.documentId,
    generationId: input.generationId,
    durableSeq: input.durableSeq,
    updateHash: input.updateHash,
    contentChanged: input.contentChanged,
    summary: summarizeDocumentContent(input.content),
    snapshotContent: input.content,
    contentHash: hashDocumentContent(input.content),
  });
  await executor
    .update(documentOutbox)
    .set({
      status: "done",
      processedAt: sql`CURRENT_TIMESTAMP`,
      leaseUntil: null,
      leaseToken: null,
      snapshotContent: null,
    })
    .where(
      and(
        eq(documentOutbox.generationId, input.generationId),
        sql`${documentOutbox.durableSeq} < ${input.durableSeq}`,
        or(eq(documentOutbox.status, "pending"), eq(documentOutbox.status, "processing")),
      ),
    );
}

async function insertEmptyProjectionSnapshot(
  executor: Pick<Database, "insert">,
  input: { tenantId: string; documentId: string; generationId: string },
): Promise<void> {
  await executor.insert(documentProjectionSnapshots).values({
    ...input,
    durableSeq: 0,
    snapshotRevision: 1,
    content: emptyDocumentContent,
    contentHash: hashDocumentContent(emptyDocumentContent),
    ...summarizeDocumentContent(emptyDocumentContent),
  });
}

const AUTOMATIC_VERSION_INTERVAL_MS = 30 * 60 * 1000;
const MAX_AUTOMATIC_VERSIONS_PER_DOCUMENT = 50;

function parseDocumentVersionKind(kind: string): DocumentVersion["kind"] {
  if (kind === "named" || kind === "automatic") return kind;
  throw new Error("Unsupported document version kind");
}

export type ActiveDocument = {
  id: string;
  tenantId: string;
  title: string;
  createdBy: string;
  schemaVersion: number;
  extensions: Array<{ name: string; version: string; required: boolean }>;
  generationId: string;
  durableSeq: number;
  createdAt: Date;
  updatedAt: Date;
  metadataRevision: number;
};

export type DocumentListView = "all" | "mine" | "recent" | "favorites" | "archived" | "trash";
export type DocumentLifecycleResult =
  | { status: "not-found" }
  | { status: "not-owner" }
  | { status: "conflict"; currentStatus: string }
  | { status: "updated"; generationId: string };

export type DocumentListItem = ActiveDocument & { isFavorite: boolean; deletedAt: Date | null };
export type DocumentVersion = {
  id: string;
  documentId: string;
  generationId: string;
  name: string;
  kind: "named" | "automatic";
  durableSeq: number;
  createdBy: string;
  createdAt: Date;
};

export type VersionMutationResult =
  | { status: "not-found" }
  | { status: "conflict" }
  | { status: "created"; version: DocumentVersion }
  | { status: "restored"; previousGenerationId: string; document: ActiveDocument };

export type GenerationSwitchResult =
  | { status: "not-found" | "conflict" }
  | {
      status: "migrated" | "repaired";
      previousGenerationId: string;
      document: ActiveDocument;
    };

export type PersistedUpdate = {
  updateHash: string;
  updateBytes: Uint8Array;
  durableSeq: number;
};

export type AclChangeResult =
  | { status: "not-found" }
  | { status: "not-owner" }
  | { status: "updated"; generationId: string; actions: DocumentPermissionAction[] };

export function hasDocumentAction(
  granted: ReadonlySet<string>,
  required: DocumentPermissionAction,
): boolean {
  if (granted.has(required)) return true;
  if (required === "read")
    return ["write", "comment", "export", "ai"].some((action) => granted.has(action));
  if (required === "comment") return granted.has("write");
  if (required === "ai") return granted.has("write");
  return false;
}

export class DocumentRepository {
  constructor(private readonly db: Database) {}

  async listActiveForIntegrityScan(): Promise<
    Array<{ id: string; tenantId: string; createdBy: string }>
  > {
    return this.db
      .select({ id: documents.id, tenantId: documents.tenantId, createdBy: documents.createdBy })
      .from(documents)
      .where(eq(documents.status, "active"))
      .orderBy(asc(documents.id));
  }

  async create(
    tenantId: string,
    ownerId: string,
    title: string,
    template?: { schemaVersion: number; extensions: ActiveDocument["extensions"] },
    requestId?: string,
    maxDocumentsPerTenant = 10_000,
  ): Promise<ActiveDocument> {
    const documentId = `doc_${randomUUID()}`;
    const generationId = `gen_${randomUUID()}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${tenantId}`}, 718267))`,
      );
      const [tenantDocumentCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.tenantId, tenantId));
      if ((tenantDocumentCount?.count ?? 0) >= maxDocumentsPerTenant) {
        throw new DomainError("RESOURCE_LIMIT", "The tenant document limit has been reached", {
          limit: maxDocumentsPerTenant,
        });
      }

      const [document] = await tx
        .insert(documents)
        .values({ id: documentId, tenantId, title, createdBy: ownerId })
        .returning();
      if (!document) throw new Error("Document insert returned no row");

      const [generation] = await tx
        .insert(documentGenerations)
        .values({
          id: generationId,
          documentId,
          schemaVersion: template?.schemaVersion ?? 1,
          extensions: template?.extensions ?? [],
        })
        .returning();
      if (!generation) throw new Error("Generation insert returned no row");

      await insertDocumentAudit(tx, {
        tenantId,
        actorIdentityId: ownerId,
        action: "document.created",
        resourceId: document.id,
        generationId: generation.id,
        requestId,
      });
      await insertEmptyProjectionSnapshot(tx, {
        tenantId,
        documentId: document.id,
        generationId: generation.id,
      });

      return {
        id: document.id,
        tenantId: document.tenantId,
        title: document.title,
        createdBy: document.createdBy,
        schemaVersion: generation.schemaVersion,
        extensions: generation.extensions,
        generationId: generation.id,
        durableSeq: generation.durableSeq,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        metadataRevision: document.metadataRevision,
      };
    });
  }

  async copyTemplate(input: {
    tenantId: string;
    identityId: string;
    templateId: string;
    expectedGenerationId: string;
    expectedDurableSeq: number;
    title: string;
    schemaVersion: number;
    extensions: ActiveDocument["extensions"];
    initialUpdate?: { updateHash: string; updateBytes: Uint8Array; content: DocumentContent };
    requestId?: string;
    maxDocumentsPerTenant: number;
  }): Promise<
    | { status: "not-found" }
    | { status: "conflict" }
    | { status: "quota-exceeded" }
    | { status: "copied"; document: ActiveDocument }
  > {
    return this.db.transaction(async (tx) => {
      const [template] = await tx
        .select({ id: documents.id, tenantId: documents.tenantId, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.templateId),
            eq(documents.tenantId, input.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!template) return { status: "not-found" };

      if (template.createdBy !== input.identityId) {
        const grants = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.templateId),
              eq(documentAcl.identityId, input.identityId),
            ),
          );
        if (!hasDocumentAction(new Set(grants.map((grant) => grant.action)), "read")) {
          return { status: "not-found" };
        }
      }

      const [generation] = await tx
        .select({
          id: documentGenerations.id,
          schemaVersion: documentGenerations.schemaVersion,
          durableSeq: documentGenerations.durableSeq,
        })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.id, input.expectedGenerationId),
            eq(documentGenerations.documentId, input.templateId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!generation) return { status: "not-found" };
      if (
        generation.durableSeq !== input.expectedDurableSeq ||
        generation.schemaVersion !== input.schemaVersion
      ) {
        return { status: "conflict" };
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${input.tenantId}`}, 718267))`,
      );
      const [tenantDocumentCount] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.tenantId, input.tenantId));
      if ((tenantDocumentCount?.count ?? 0) >= input.maxDocumentsPerTenant) {
        return { status: "quota-exceeded" };
      }

      const documentId = `doc_${randomUUID()}`;
      const generationId = `gen_${randomUUID()}`;
      const initialDurableSeq = input.initialUpdate ? 1 : 0;
      const [document] = await tx
        .insert(documents)
        .values({
          id: documentId,
          tenantId: input.tenantId,
          title: input.title,
          createdBy: input.identityId,
        })
        .returning();
      if (!document) throw new Error("Copied document insert returned no row");

      const [copiedGeneration] = await tx
        .insert(documentGenerations)
        .values({
          id: generationId,
          documentId,
          schemaVersion: input.schemaVersion,
          extensions: input.extensions,
          durableSeq: initialDurableSeq,
        })
        .returning();
      if (!copiedGeneration) throw new Error("Copied generation insert returned no row");

      if (input.initialUpdate) {
        await tx.insert(collaborationUpdates).values({
          documentId,
          generationId,
          updateHash: input.initialUpdate.updateHash,
          sourceUpdateHash: input.initialUpdate.updateHash,
          updateBytes: Buffer.from(input.initialUpdate.updateBytes),
          durableSeq: initialDurableSeq,
          createdBy: input.identityId,
        });
        await insertProjectionOutbox(tx, {
          tenantId: input.tenantId,
          documentId,
          generationId,
          durableSeq: initialDurableSeq,
          updateHash: input.initialUpdate.updateHash,
          contentChanged: true,
          content: input.initialUpdate.content,
        });
      } else {
        await insertEmptyProjectionSnapshot(tx, {
          tenantId: input.tenantId,
          documentId,
          generationId,
        });
      }

      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action: "document.copied",
        resourceId: documentId,
        generationId,
        requestId: input.requestId,
        details: { sourceDocumentId: input.templateId, sourceDurableSeq: generation.durableSeq },
      });

      return {
        status: "copied",
        document: {
          id: document.id,
          tenantId: document.tenantId,
          title: document.title,
          createdBy: document.createdBy,
          schemaVersion: copiedGeneration.schemaVersion,
          extensions: copiedGeneration.extensions,
          generationId: copiedGeneration.id,
          durableSeq: copiedGeneration.durableSeq,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          metadataRevision: document.metadataRevision,
        },
      };
    });
  }

  async list(input: {
    tenantId: string;
    identityId: string;
    view: DocumentListView;
    query?: string;
    sort: "recent" | "updated" | "created" | "title";
    direction: "asc" | "desc";
    limit: number;
    offset: number;
  }): Promise<{ items: DocumentListItem[]; hasMore: boolean }> {
    const owner = eq(documents.createdBy, input.identityId);
    const readable = sql`(
      ${owner} OR EXISTS (
        SELECT 1 FROM document_acl da
        WHERE da.tenant_id = ${input.tenantId}
          AND da.document_id = ${documents.id}
          AND da.identity_id = ${input.identityId}
          AND da.action IN ('read', 'write', 'comment', 'export', 'ai')
      )
    )`;
    const status =
      input.view === "trash" ? "trashed" : input.view === "archived" ? "archived" : "active";
    const filters = [eq(documents.tenantId, input.tenantId), eq(documents.status, status)];
    if (input.view === "mine" || input.view === "archived" || input.view === "trash") {
      filters.push(owner);
    } else {
      filters.push(readable);
    }
    if (input.view === "recent") filters.push(sql`${documentRecents.identityId} IS NOT NULL`);
    if (input.view === "favorites") filters.push(sql`${documentFavorites.identityId} IS NOT NULL`);
    if (input.query) filters.push(ilike(documents.title, `%${input.query}%`));

    const sortColumn =
      input.sort === "title"
        ? documents.title
        : input.sort === "created"
          ? documents.createdAt
          : input.sort === "recent" && input.view === "recent"
            ? documentRecents.lastOpenedAt
            : documents.updatedAt;
    const primaryOrder = input.direction === "asc" ? asc(sortColumn) : desc(sortColumn);
    const rows = await this.db
      .select({
        id: documents.id,
        tenantId: documents.tenantId,
        title: documents.title,
        createdBy: documents.createdBy,
        schemaVersion: documentGenerations.schemaVersion,
        extensions: documentGenerations.extensions,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        deletedAt: documents.deletedAt,
        metadataRevision: documents.metadataRevision,
        isFavorite: sql<boolean>`${documentFavorites.identityId} IS NOT NULL`,
      })
      .from(documents)
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .leftJoin(
        documentFavorites,
        and(
          eq(documentFavorites.tenantId, input.tenantId),
          eq(documentFavorites.documentId, documents.id),
          eq(documentFavorites.identityId, input.identityId),
        ),
      )
      .leftJoin(
        documentRecents,
        and(
          eq(documentRecents.tenantId, input.tenantId),
          eq(documentRecents.documentId, documents.id),
          eq(documentRecents.identityId, input.identityId),
        ),
      )
      .where(and(...filters))
      .orderBy(primaryOrder, asc(documents.id))
      .limit(input.limit + 1)
      .offset(input.offset);
    const hasMore = rows.length > input.limit;
    return {
      hasMore,
      items: rows.slice(0, input.limit).map((row) => ({ ...row, isFavorite: row.isFavorite })),
    };
  }

  async markRecent(document: ActiveDocument, identityId: string): Promise<void> {
    await this.db
      .insert(documentRecents)
      .values({ tenantId: document.tenantId, documentId: document.id, identityId })
      .onConflictDoUpdate({
        target: [documentRecents.tenantId, documentRecents.documentId, documentRecents.identityId],
        set: { lastOpenedAt: sql`now()` },
      });
  }

  async setFavorite(
    tenantId: string,
    documentId: string,
    identityId: string,
    favorite: boolean,
  ): Promise<boolean> {
    const document = await this.findActiveForAction(documentId, tenantId, identityId, "read");
    if (!document) return false;
    if (favorite) {
      await this.db
        .insert(documentFavorites)
        .values({ tenantId, documentId, identityId })
        .onConflictDoNothing();
    } else {
      await this.db
        .delete(documentFavorites)
        .where(
          and(
            eq(documentFavorites.tenantId, tenantId),
            eq(documentFavorites.documentId, documentId),
            eq(documentFavorites.identityId, identityId),
          ),
        );
    }
    return true;
  }

  async updateTitle(input: {
    tenantId: string;
    documentId: string;
    identityId: string;
    expectedRevision: number;
    title: string;
    requestId?: string;
  }): Promise<{ status: "not-found" | "conflict" | "updated" }> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ createdBy: documents.createdBy, metadataRevision: documents.metadataRevision })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.tenantId, input.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };
      if (document.metadataRevision !== input.expectedRevision) return { status: "conflict" };
      if (document.createdBy !== input.identityId) {
        const [writeGrant] = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.documentId),
              eq(documentAcl.identityId, input.identityId),
              eq(documentAcl.action, "write"),
            ),
          )
          .limit(1);
        if (!writeGrant) return { status: "not-found" };
      }
      await tx
        .update(documents)
        .set({
          title: input.title,
          metadataRevision: input.expectedRevision + 1,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, input.documentId));
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action: "document.title-updated",
        resourceId: input.documentId,
        requestId: input.requestId,
        details: { metadataRevision: input.expectedRevision + 1 },
      });
      return { status: "updated" };
    });
  }

  async setLifecycle(input: {
    tenantId: string;
    documentId: string;
    ownerId: string;
    operation: "archive" | "trash" | "restore" | "purge";
    requestId?: string;
  }): Promise<DocumentLifecycleResult> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ createdBy: documents.createdBy, status: documents.status })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };
      if (document.createdBy !== input.ownerId) return { status: "not-owner" };
      const allowed = {
        archive: ["active"],
        trash: ["active", "archived"],
        restore: ["archived", "trashed"],
        purge: ["trashed"],
      }[input.operation];
      if (!allowed.includes(document.status))
        return { status: "conflict", currentStatus: document.status };
      const [generation] = await tx
        .select({ id: documentGenerations.id })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .limit(1);
      if (!generation) return { status: "not-found" };
      if (input.operation === "purge") {
        await tx.delete(documents).where(eq(documents.id, input.documentId));
      } else {
        const status =
          input.operation === "archive"
            ? "archived"
            : input.operation === "trash"
              ? "trashed"
              : "active";
        await tx
          .update(documents)
          .set({
            status,
            archivedAt: status === "archived" ? new Date() : null,
            deletedAt: status === "trashed" ? new Date() : null,
            updatedAt: new Date(),
            metadataRevision: sql`${documents.metadataRevision} + 1`,
          })
          .where(eq(documents.id, input.documentId));
      }
      const lifecycleActions: Record<typeof input.operation, DocumentAuditAction> = {
        archive: "document.archived",
        trash: "document.trashed",
        restore: "document.restored",
        purge: "document.permanently-deleted",
      };
      const action = lifecycleActions[input.operation];
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.ownerId,
        action,
        resourceId: input.documentId,
        generationId: generation.id,
        requestId: input.requestId,
        details: { previousStatus: document.status },
      });
      return { status: "updated", generationId: generation.id };
    });
  }

  async createVersion(input: {
    tenantId: string;
    documentId: string;
    identityId: string;
    name: string;
    expectedGenerationId: string;
    expectedDurableSeq: number;
    requestId?: string;
  }): Promise<VersionMutationResult> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.tenantId, input.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };
      if (document.createdBy !== input.identityId) {
        const [writeGrant] = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.documentId),
              eq(documentAcl.identityId, input.identityId),
              eq(documentAcl.action, "write"),
            ),
          )
          .limit(1);
        if (!writeGrant) return { status: "not-found" };
      }
      const [generation] = await tx
        .select({ id: documentGenerations.id, durableSeq: documentGenerations.durableSeq })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !generation ||
        generation.id !== input.expectedGenerationId ||
        generation.durableSeq !== input.expectedDurableSeq
      ) {
        return { status: "conflict" };
      }
      const [version] = await tx
        .insert(documentVersions)
        .values({
          id: `ver_${randomUUID()}`,
          tenantId: input.tenantId,
          documentId: input.documentId,
          generationId: generation.id,
          name: input.name,
          kind: "named",
          durableSeq: generation.durableSeq,
          createdBy: input.identityId,
        })
        .onConflictDoNothing()
        .returning();
      if (!version) return { status: "conflict" };
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action: "document.version-created",
        resourceId: input.documentId,
        generationId: generation.id,
        requestId: input.requestId,
        details: { versionId: version.id, durableSeq: version.durableSeq },
      });
      return {
        status: "created",
        version: { ...version, kind: parseDocumentVersionKind(version.kind) },
      };
    });
  }

  async listVersions(tenantId: string, documentId: string): Promise<DocumentVersion[]> {
    const versions = await this.db
      .select({
        id: documentVersions.id,
        documentId: documentVersions.documentId,
        generationId: documentVersions.generationId,
        name: documentVersions.name,
        kind: documentVersions.kind,
        durableSeq: documentVersions.durableSeq,
        createdBy: documentVersions.createdBy,
        createdAt: documentVersions.createdAt,
      })
      .from(documentVersions)
      .where(
        and(eq(documentVersions.tenantId, tenantId), eq(documentVersions.documentId, documentId)),
      )
      .orderBy(desc(documentVersions.createdAt), desc(documentVersions.id));
    return versions.map((version) => ({
      ...version,
      kind: parseDocumentVersionKind(version.kind),
    }));
  }

  async findVersion(
    tenantId: string,
    documentId: string,
    versionId: string,
  ): Promise<DocumentVersion | null> {
    const [version] = await this.db
      .select({
        id: documentVersions.id,
        documentId: documentVersions.documentId,
        generationId: documentVersions.generationId,
        name: documentVersions.name,
        kind: documentVersions.kind,
        durableSeq: documentVersions.durableSeq,
        createdBy: documentVersions.createdBy,
        createdAt: documentVersions.createdAt,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.tenantId, tenantId),
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.id, versionId),
        ),
      )
      .limit(1);
    return version ? { ...version, kind: parseDocumentVersionKind(version.kind) } : null;
  }

  async findGenerationSchemaVersion(
    documentId: string,
    generationId: string,
  ): Promise<number | null> {
    const [generation] = await this.db
      .select({ schemaVersion: documentGenerations.schemaVersion })
      .from(documentGenerations)
      .where(
        and(
          eq(documentGenerations.documentId, documentId),
          eq(documentGenerations.id, generationId),
        ),
      )
      .limit(1);
    return generation?.schemaVersion ?? null;
  }

  async restoreVersion(input: {
    tenantId: string;
    documentId: string;
    versionId: string;
    identityId: string;
    expectedGenerationId: string;
    expectedDurableSeq: number;
    requestId?: string;
    content: DocumentContent;
  }): Promise<VersionMutationResult> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          title: documents.title,
          createdBy: documents.createdBy,
          status: documents.status,
          metadataRevision: documents.metadataRevision,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
        .for("update")
        .limit(1);
      if (!document || document.status !== "active") return { status: "not-found" };
      if (document.createdBy !== input.identityId) {
        const [writeGrant] = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.documentId),
              eq(documentAcl.identityId, input.identityId),
              eq(documentAcl.action, "write"),
            ),
          )
          .limit(1);
        if (!writeGrant) return { status: "not-found" };
      }
      const [currentGeneration] = await tx
        .select({ id: documentGenerations.id, durableSeq: documentGenerations.durableSeq })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !currentGeneration ||
        currentGeneration.id !== input.expectedGenerationId ||
        currentGeneration.durableSeq !== input.expectedDurableSeq
      ) {
        return { status: "conflict" };
      }
      const [version] = await tx
        .select({
          id: documentVersions.id,
          generationId: documentVersions.generationId,
          durableSeq: documentVersions.durableSeq,
        })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.tenantId, input.tenantId),
            eq(documentVersions.documentId, input.documentId),
            eq(documentVersions.id, input.versionId),
          ),
        )
        .limit(1);
      if (!version) return { status: "not-found" };
      const [sourceGeneration] = await tx
        .select({
          schemaVersion: documentGenerations.schemaVersion,
          extensions: documentGenerations.extensions,
          durableSeq: documentGenerations.durableSeq,
        })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.id, version.generationId),
          ),
        )
        .limit(1);
      if (!sourceGeneration || version.durableSeq > sourceGeneration.durableSeq)
        return { status: "conflict" };

      const nextGenerationId = `gen_${randomUUID()}`;
      await tx
        .update(documentGenerations)
        .set({ status: "retired" })
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.id, currentGeneration.id),
          ),
        );
      await tx.insert(documentGenerations).values({
        id: nextGenerationId,
        documentId: input.documentId,
        schemaVersion: sourceGeneration.schemaVersion,
        extensions: sourceGeneration.extensions,
        durableSeq: version.durableSeq,
      });
      await tx.execute(sql`
        INSERT INTO collaboration_updates
          (document_id, generation_id, update_hash, source_update_hash, update_bytes, durable_seq, created_by, created_at)
        SELECT document_id, ${nextGenerationId}, update_hash, source_update_hash, update_bytes, durable_seq, created_by, created_at
        FROM collaboration_updates
        WHERE document_id = ${input.documentId}
          AND generation_id = ${version.generationId}
          AND durable_seq <= ${version.durableSeq}
      `);
      if (version.durableSeq === 0) {
        await insertEmptyProjectionSnapshot(tx, {
          tenantId: input.tenantId,
          documentId: input.documentId,
          generationId: nextGenerationId,
        });
      } else {
        const [latestUpdate] = await tx
          .select({ updateHash: collaborationUpdates.updateHash })
          .from(collaborationUpdates)
          .where(
            and(
              eq(collaborationUpdates.documentId, input.documentId),
              eq(collaborationUpdates.generationId, nextGenerationId),
              eq(collaborationUpdates.durableSeq, version.durableSeq),
            ),
          )
          .limit(1);
        if (!latestUpdate) throw new Error("Restored update prefix is incomplete");
        await insertProjectionOutbox(tx, {
          tenantId: input.tenantId,
          documentId: input.documentId,
          generationId: nextGenerationId,
          durableSeq: version.durableSeq,
          updateHash: latestUpdate.updateHash,
          contentChanged: true,
          content: input.content,
        });
      }
      await tx.execute(sql`
        INSERT INTO asset_references
          (tenant_id, document_id, generation_id, durable_seq, asset_id, block_id)
        SELECT tenant_id, document_id, ${nextGenerationId}, durable_seq, asset_id, block_id
        FROM asset_references
        WHERE tenant_id = ${input.tenantId}
          AND document_id = ${input.documentId}
          AND generation_id = ${version.generationId}
          AND durable_seq = ${version.durableSeq}
      `);
      const updatedAt = new Date();
      await tx
        .update(documents)
        .set({
          updatedAt,
          metadataRevision: document.metadataRevision + 1,
        })
        .where(eq(documents.id, input.documentId));
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action: "document.version-restored",
        resourceId: input.documentId,
        generationId: nextGenerationId,
        requestId: input.requestId,
        details: {
          previousGenerationId: currentGeneration.id,
          versionId: version.id,
          durableSeq: version.durableSeq,
        },
      });
      const restored: ActiveDocument = {
        id: document.id,
        tenantId: document.tenantId,
        title: document.title,
        createdBy: document.createdBy,
        schemaVersion: sourceGeneration.schemaVersion,
        extensions: sourceGeneration.extensions,
        generationId: nextGenerationId,
        durableSeq: version.durableSeq,
        createdAt: document.createdAt,
        updatedAt,
        metadataRevision: document.metadataRevision + 1,
      };
      return {
        status: "restored",
        previousGenerationId: currentGeneration.id,
        document: restored,
      };
    });
  }

  async switchActiveGeneration(input: {
    tenantId: string;
    documentId: string;
    identityId: string;
    expectedGenerationId: string;
    expectedSchemaVersion: number;
    expectedDurableSeq: number;
    targetSchemaVersion: number;
    extensions: Array<{ name: string; version: string; required: boolean }>;
    updateHash: string;
    updateBytes: Uint8Array;
    content: DocumentContent;
    requestId?: string;
  }): Promise<GenerationSwitchResult> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          title: documents.title,
          createdBy: documents.createdBy,
          status: documents.status,
          metadataRevision: documents.metadataRevision,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
        .for("update")
        .limit(1);
      if (!document || document.status !== "active") return { status: "not-found" };
      if (document.createdBy !== input.identityId) {
        const [writeGrant] = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.documentId),
              eq(documentAcl.identityId, input.identityId),
              eq(documentAcl.action, "write"),
            ),
          )
          .limit(1);
        if (!writeGrant) return { status: "not-found" };
      }

      const [generation] = await tx
        .select({
          id: documentGenerations.id,
          schemaVersion: documentGenerations.schemaVersion,
          extensions: documentGenerations.extensions,
          durableSeq: documentGenerations.durableSeq,
        })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !generation ||
        generation.id !== input.expectedGenerationId ||
        generation.schemaVersion !== input.expectedSchemaVersion ||
        generation.durableSeq !== input.expectedDurableSeq ||
        input.targetSchemaVersion < generation.schemaVersion
      ) {
        return { status: "conflict" };
      }

      const nextGenerationId = `gen_${randomUUID()}`;
      const durableSeq = 1;
      const updatedAt = new Date();
      await tx
        .update(documentGenerations)
        .set({ status: "retired" })
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.id, generation.id),
            eq(documentGenerations.status, "active"),
          ),
        );
      await tx.insert(documentGenerations).values({
        id: nextGenerationId,
        documentId: input.documentId,
        schemaVersion: input.targetSchemaVersion,
        extensions: input.extensions,
        durableSeq,
        status: "active",
      });
      await tx.insert(collaborationUpdates).values({
        documentId: input.documentId,
        generationId: nextGenerationId,
        updateHash: input.updateHash,
        sourceUpdateHash: input.updateHash,
        updateBytes: Buffer.from(input.updateBytes),
        durableSeq,
        createdBy: input.identityId,
      });
      await insertProjectionOutbox(tx, {
        tenantId: input.tenantId,
        documentId: input.documentId,
        generationId: nextGenerationId,
        durableSeq,
        updateHash: input.updateHash,
        contentChanged: true,
        content: input.content,
      });
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action:
          input.targetSchemaVersion === generation.schemaVersion
            ? "document.block-ids-repaired"
            : "document.schema-migrated",
        resourceId: input.documentId,
        generationId: nextGenerationId,
        requestId: input.requestId,
        details: {
          previousGenerationId: generation.id,
          fromSchemaVersion: generation.schemaVersion,
          toSchemaVersion: input.targetSchemaVersion,
        },
      });
      await tx
        .update(documents)
        .set({ updatedAt, metadataRevision: document.metadataRevision + 1 })
        .where(eq(documents.id, input.documentId));

      return {
        status: input.targetSchemaVersion === generation.schemaVersion ? "repaired" : "migrated",
        previousGenerationId: generation.id,
        document: {
          id: document.id,
          tenantId: document.tenantId,
          title: document.title,
          createdBy: document.createdBy,
          schemaVersion: input.targetSchemaVersion,
          extensions: input.extensions,
          generationId: nextGenerationId,
          durableSeq,
          createdAt: document.createdAt,
          updatedAt,
          metadataRevision: document.metadataRevision + 1,
        },
      };
    });
  }

  async findActiveForAction(
    documentId: string,
    tenantId: string,
    identityId: string,
    action: DocumentPermissionAction,
  ): Promise<ActiveDocument | null> {
    const row = await this.findActiveRow(documentId, tenantId);
    if (!row) return null;
    if (row.createdBy === identityId) return row;

    const grants = await this.db
      .select({ action: documentAcl.action })
      .from(documentAcl)
      .where(
        and(
          eq(documentAcl.tenantId, tenantId),
          eq(documentAcl.documentId, documentId),
          eq(documentAcl.identityId, identityId),
        ),
      );
    return hasDocumentAction(new Set(grants.map((grant) => grant.action)), action) ? row : null;
  }

  async setAcl(
    tenantId: string,
    documentId: string,
    ownerId: string,
    identityId: string,
    actions: readonly DocumentPermissionAction[],
    requestId?: string,
  ): Promise<AclChangeResult> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };
      if (document.createdBy !== ownerId) return { status: "not-owner" };

      const [generation] = await tx
        .select({ id: documentGenerations.id })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .limit(1);
      if (!generation) return { status: "not-found" };

      await tx
        .delete(documentAcl)
        .where(
          and(
            eq(documentAcl.tenantId, tenantId),
            eq(documentAcl.documentId, documentId),
            eq(documentAcl.identityId, identityId),
          ),
        );
      if (actions.length > 0) {
        await tx.insert(documentAcl).values(
          actions.map((action) => ({
            tenantId,
            documentId,
            identityId,
            action,
            grantedBy: ownerId,
          })),
        );
      }
      await insertDocumentAudit(tx, {
        tenantId,
        actorIdentityId: ownerId,
        action: "document.acl-updated",
        resourceId: documentId,
        generationId: generation.id,
        requestId,
        details: { subjectIdentityId: identityId, actions: [...actions] },
      });
      return { status: "updated", generationId: generation.id, actions: [...actions] };
    });
  }

  async removeAcl(
    tenantId: string,
    documentId: string,
    ownerId: string,
    identityId: string,
    requestId?: string,
  ): Promise<AclChangeResult> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };
      if (document.createdBy !== ownerId) return { status: "not-owner" };

      const [generation] = await tx
        .select({ id: documentGenerations.id })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .limit(1);
      if (!generation) return { status: "not-found" };

      await tx
        .delete(documentAcl)
        .where(
          and(
            eq(documentAcl.tenantId, tenantId),
            eq(documentAcl.documentId, documentId),
            eq(documentAcl.identityId, identityId),
          ),
        );
      await insertDocumentAudit(tx, {
        tenantId,
        actorIdentityId: ownerId,
        action: "document.acl-removed",
        resourceId: documentId,
        generationId: generation.id,
        requestId,
        details: { subjectIdentityId: identityId },
      });
      return { status: "updated", generationId: generation.id, actions: [] };
    });
  }

  async persistUpdate(input: {
    documentId: string;
    generationId: string;
    tenantId: string;
    subjectId: string;
    updateHash: string;
    sourceUpdateHash?: string;
    updateBytes: Uint8Array;
    contentChanged: boolean;
    content: DocumentContent;
    assetReferences?: readonly { assetId: string; blockId: string }[];
  }): Promise<{ updateHash: string; durableSeq: number; duplicate: boolean }> {
    const sourceUpdateHash = input.sourceUpdateHash ?? input.updateHash;
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id, createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, input.documentId),
            eq(documents.tenantId, input.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) throw new Error("Document authorization changed");
      if (document.createdBy !== input.subjectId) {
        const [writeGrant] = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.documentId),
              eq(documentAcl.identityId, input.subjectId),
              eq(documentAcl.action, "write"),
            ),
          )
          .limit(1);
        if (!writeGrant) throw new Error("Document authorization changed");
      }

      const [generation] = await tx
        .select({ id: documentGenerations.id, durableSeq: documentGenerations.durableSeq })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.id, input.generationId),
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!generation) throw new Error("Document generation is no longer writable");

      const [existing] = await tx
        .select({ durableSeq: collaborationUpdates.durableSeq })
        .from(collaborationUpdates)
        .where(
          and(
            eq(collaborationUpdates.generationId, input.generationId),
            or(
              eq(collaborationUpdates.updateHash, sourceUpdateHash),
              eq(collaborationUpdates.sourceUpdateHash, sourceUpdateHash),
            ),
          ),
        )
        .limit(1);
      if (existing) {
        return { updateHash: sourceUpdateHash, durableSeq: existing.durableSeq, duplicate: true };
      }

      const durableSeq = generation.durableSeq + 1;
      if (!Number.isSafeInteger(durableSeq)) throw new Error("Document sequence limit reached");
      await tx.insert(collaborationUpdates).values({
        documentId: input.documentId,
        generationId: input.generationId,
        updateHash: input.updateHash,
        sourceUpdateHash,
        updateBytes: Buffer.from(input.updateBytes),
        durableSeq,
        createdBy: input.subjectId,
      });
      await tx
        .update(documentGenerations)
        .set({ durableSeq })
        .where(eq(documentGenerations.id, generation.id));

      await insertProjectionOutbox(tx, {
        tenantId: input.tenantId,
        documentId: input.documentId,
        generationId: input.generationId,
        durableSeq,
        updateHash: input.updateHash,
        contentChanged: input.contentChanged,
        content: input.content,
      });

      if (input.assetReferences) {
        const referencedAssetIds = [
          ...new Set(input.assetReferences.map(({ assetId }) => assetId)),
        ];
        if (referencedAssetIds.length > 0) {
          const readyAssets = await tx
            .select({ id: assets.id })
            .from(assets)
            .where(
              and(
                eq(assets.tenantId, input.tenantId),
                eq(assets.documentId, input.documentId),
                eq(assets.status, "ready"),
                inArray(assets.id, referencedAssetIds),
              ),
            );
          if (readyAssets.length !== referencedAssetIds.length) {
            throw new Error("Document contains an unavailable or foreign asset");
          }
        }

        if (input.assetReferences.length > 0) {
          await tx
            .insert(assetReferences)
            .values(
              input.assetReferences.map(({ assetId, blockId }) => ({
                tenantId: input.tenantId,
                documentId: input.documentId,
                generationId: input.generationId,
                durableSeq,
                assetId,
                blockId,
              })),
            )
            .onConflictDoNothing();
        }

        const versionRows = await tx
          .select({ durableSeq: documentVersions.durableSeq })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.tenantId, input.tenantId),
              eq(documentVersions.documentId, input.documentId),
              eq(documentVersions.generationId, input.generationId),
            ),
          );
        const retainedSequences = [
          ...new Set([durableSeq, ...versionRows.map(({ durableSeq: versionSeq }) => versionSeq)]),
        ];
        await tx
          .delete(assetReferences)
          .where(
            and(
              eq(assetReferences.tenantId, input.tenantId),
              eq(assetReferences.documentId, input.documentId),
              eq(assetReferences.generationId, input.generationId),
              notInArray(assetReferences.durableSeq, retainedSequences),
            ),
          );
      }

      if (!input.contentChanged) {
        return { updateHash: sourceUpdateHash, durableSeq, duplicate: false };
      }

      const [lastAutomaticVersion] = await tx
        .select({
          durableSeq: documentVersions.durableSeq,
          intervalElapsed: sql<boolean>`CURRENT_TIMESTAMP - ${documentVersions.createdAt} >= ${AUTOMATIC_VERSION_INTERVAL_MS} * INTERVAL '1 millisecond'`,
        })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.tenantId, input.tenantId),
            eq(documentVersions.documentId, input.documentId),
            eq(documentVersions.generationId, generation.id),
            eq(documentVersions.kind, "automatic"),
          ),
        )
        .orderBy(desc(documentVersions.createdAt), desc(documentVersions.id))
        .limit(1);
      const shouldCreateAutomaticVersion =
        !lastAutomaticVersion ||
        (durableSeq > lastAutomaticVersion.durableSeq && lastAutomaticVersion.intervalElapsed);

      if (shouldCreateAutomaticVersion) {
        await tx.insert(documentVersions).values({
          id: `ver_${randomUUID()}`,
          tenantId: input.tenantId,
          documentId: input.documentId,
          generationId: generation.id,
          name: `自动版本 · ${generation.id.slice(-8)} · ${durableSeq}`,
          kind: "automatic",
          durableSeq,
          createdBy: input.subjectId,
        });

        const expiredAutomaticVersions = await tx
          .select({ id: documentVersions.id, durableSeq: documentVersions.durableSeq })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.tenantId, input.tenantId),
              eq(documentVersions.documentId, input.documentId),
              eq(documentVersions.kind, "automatic"),
            ),
          )
          .orderBy(desc(documentVersions.createdAt), desc(documentVersions.id))
          .offset(MAX_AUTOMATIC_VERSIONS_PER_DOCUMENT);
        if (expiredAutomaticVersions.length > 0) {
          await tx.delete(documentVersions).where(
            inArray(
              documentVersions.id,
              expiredAutomaticVersions.map(({ id }) => id),
            ),
          );
          const remainingVersions = await tx
            .select({ durableSeq: documentVersions.durableSeq })
            .from(documentVersions)
            .where(
              and(
                eq(documentVersions.tenantId, input.tenantId),
                eq(documentVersions.documentId, input.documentId),
                eq(documentVersions.generationId, generation.id),
              ),
            );
          const retainedSequences = [
            ...new Set([durableSeq, ...remainingVersions.map(({ durableSeq: seq }) => seq)]),
          ];
          await tx
            .delete(assetReferences)
            .where(
              and(
                eq(assetReferences.tenantId, input.tenantId),
                eq(assetReferences.documentId, input.documentId),
                eq(assetReferences.generationId, generation.id),
                notInArray(assetReferences.durableSeq, retainedSequences),
              ),
            );
        }
      }

      return { updateHash: sourceUpdateHash, durableSeq, duplicate: false };
    });
  }

  async claimProjectionJob(
    now = new Date(),
    documentId?: string,
  ): Promise<ClaimedProjectionJob | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(documentOutbox)
        .where(
          and(
            or(
              and(eq(documentOutbox.status, "pending"), lte(documentOutbox.availableAt, now)),
              and(eq(documentOutbox.status, "processing"), lte(documentOutbox.leaseUntil, now)),
            ),
            ...(documentId ? [eq(documentOutbox.documentId, documentId)] : []),
          ),
        )
        .orderBy(asc(documentOutbox.availableAt), asc(documentOutbox.createdAt))
        .for("update", { skipLocked: true })
        .limit(1);
      if (!row) return null;

      const leaseToken = randomUUID();
      const [claimed] = await tx
        .update(documentOutbox)
        .set({
          status: "processing",
          attempts: row.attempts + 1,
          leaseUntil: new Date(now.getTime() + PROJECTION_LEASE_MS),
          leaseToken,
        })
        .where(eq(documentOutbox.id, row.id))
        .returning();
      if (!claimed) return null;
      if (!claimed.snapshotContent || !claimed.contentHash) {
        await tx
          .update(documentOutbox)
          .set({
            status: "dead",
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: "snapshot-payload-missing",
          })
          .where(eq(documentOutbox.id, claimed.id));
        return null;
      }
      return {
        id: claimed.id,
        leaseToken,
        tenantId: claimed.tenantId,
        documentId: claimed.documentId,
        generationId: claimed.generationId,
        durableSeq: claimed.durableSeq,
        content: claimed.snapshotContent,
        contentHash: claimed.contentHash,
        summary: claimed.summary,
      };
    });
  }

  async processProjectionJob(job: ClaimedProjectionJob, now = new Date()): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .select({ id: documentOutbox.id })
        .from(documentOutbox)
        .where(
          and(
            eq(documentOutbox.id, job.id),
            eq(documentOutbox.leaseToken, job.leaseToken),
            eq(documentOutbox.status, "processing"),
          ),
        )
        .for("update")
        .limit(1);
      if (!claimed) return false;

      await tx
        .insert(documentProjectionSnapshots)
        .values({
          tenantId: job.tenantId,
          documentId: job.documentId,
          generationId: job.generationId,
          durableSeq: job.durableSeq,
          snapshotRevision: 1,
          content: job.content,
          contentHash: job.contentHash,
          ...job.summary,
          projectedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            documentProjectionSnapshots.tenantId,
            documentProjectionSnapshots.documentId,
            documentProjectionSnapshots.generationId,
          ],
          set: {
            durableSeq: job.durableSeq,
            snapshotRevision: sql`${documentProjectionSnapshots.snapshotRevision} + 1`,
            content: job.content,
            contentHash: job.contentHash,
            ...job.summary,
            projectedAt: now,
          },
          setWhere: sql`${documentProjectionSnapshots.durableSeq} < ${job.durableSeq}`,
        });
      await tx
        .update(documentOutbox)
        .set({
          status: "done",
          processedAt: now,
          leaseUntil: null,
          leaseToken: null,
          snapshotContent: null,
        })
        .where(eq(documentOutbox.id, job.id));
      return true;
    });
  }

  async failProjectionJob(
    job: Pick<ClaimedProjectionJob, "id" | "leaseToken">,
    errorCode = "projection-persist-failed",
    now = new Date(),
  ): Promise<"retry" | "dead" | "stale"> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ attempts: documentOutbox.attempts })
        .from(documentOutbox)
        .where(
          and(
            eq(documentOutbox.id, job.id),
            eq(documentOutbox.leaseToken, job.leaseToken),
            eq(documentOutbox.status, "processing"),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return "stale";

      if (row.attempts >= PROJECTION_MAX_ATTEMPTS) {
        await tx
          .update(documentOutbox)
          .set({
            status: "dead",
            leaseUntil: null,
            leaseToken: null,
            lastErrorCode: errorCode,
          })
          .where(eq(documentOutbox.id, job.id));
        return "dead";
      }
      const delay = Math.min(
        PROJECTION_RETRY_BASE_MS * 2 ** Math.max(0, row.attempts - 1),
        PROJECTION_RETRY_MAX_MS,
      );
      await tx
        .update(documentOutbox)
        .set({
          status: "pending",
          availableAt: new Date(now.getTime() + delay),
          leaseUntil: null,
          leaseToken: null,
          lastErrorCode: errorCode,
        })
        .where(eq(documentOutbox.id, job.id));
      return "retry";
    });
  }

  async backfillProjectionSnapshot(input: {
    tenantId: string;
    documentId: string;
    generationId: string;
    durableSeq: number;
    content: DocumentContent;
    projectedAt?: Date;
  }): Promise<boolean> {
    const projectedAt = input.projectedAt ?? new Date();
    const [row] = await this.db
      .insert(documentProjectionSnapshots)
      .values({
        tenantId: input.tenantId,
        documentId: input.documentId,
        generationId: input.generationId,
        durableSeq: input.durableSeq,
        snapshotRevision: 1,
        content: input.content,
        contentHash: hashDocumentContent(input.content),
        ...summarizeDocumentContent(input.content),
        projectedAt,
      })
      .onConflictDoUpdate({
        target: [
          documentProjectionSnapshots.tenantId,
          documentProjectionSnapshots.documentId,
          documentProjectionSnapshots.generationId,
        ],
        set: {
          durableSeq: input.durableSeq,
          snapshotRevision: sql`${documentProjectionSnapshots.snapshotRevision} + 1`,
          content: input.content,
          contentHash: hashDocumentContent(input.content),
          ...summarizeDocumentContent(input.content),
          projectedAt,
        },
        setWhere: sql`${documentProjectionSnapshots.durableSeq} < ${input.durableSeq}`,
      })
      .returning({ durableSeq: documentProjectionSnapshots.durableSeq });
    return row !== undefined;
  }

  async getProjectionQueueStatus(
    documentId?: string,
  ): Promise<{ pending: number; processing: number; dead: number }> {
    const query = this.db
      .select({
        pending: sql<number>`count(*) filter (where ${documentOutbox.status} = 'pending')::int`,
        processing: sql<number>`count(*) filter (where ${documentOutbox.status} = 'processing')::int`,
        dead: sql<number>`count(*) filter (where ${documentOutbox.status} = 'dead')::int`,
      })
      .from(documentOutbox);
    const [row] = documentId
      ? await query.where(eq(documentOutbox.documentId, documentId))
      : await query;
    return row ?? { pending: 0, processing: 0, dead: 0 };
  }

  async loadUpdates(
    documentId: string,
    generationId: string,
    maxDurableSeq?: number,
  ): Promise<PersistedUpdate[]> {
    const rows = await this.db
      .select({
        updateHash: collaborationUpdates.updateHash,
        updateBytes: collaborationUpdates.updateBytes,
        durableSeq: collaborationUpdates.durableSeq,
      })
      .from(collaborationUpdates)
      .where(
        and(
          eq(collaborationUpdates.documentId, documentId),
          eq(collaborationUpdates.generationId, generationId),
          ...(maxDurableSeq === undefined
            ? []
            : [lte(collaborationUpdates.durableSeq, maxDurableSeq)]),
        ),
      )
      .orderBy(asc(collaborationUpdates.durableSeq));
    return rows.map((row) => ({ ...row, updateBytes: new Uint8Array(row.updateBytes) }));
  }

  async findUpdateReceipt(
    documentId: string,
    generationId: string,
    updateHash: string,
  ): Promise<{ durableSeq: number } | null> {
    const [row] = await this.db
      .select({ durableSeq: collaborationUpdates.durableSeq })
      .from(collaborationUpdates)
      .where(
        and(
          eq(collaborationUpdates.documentId, documentId),
          eq(collaborationUpdates.generationId, generationId),
          or(
            eq(collaborationUpdates.updateHash, updateHash),
            eq(collaborationUpdates.sourceUpdateHash, updateHash),
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private async findActiveRow(
    documentId: string,
    tenantId: string,
  ): Promise<ActiveDocument | null> {
    const [row] = await this.db
      .select({
        id: documents.id,
        tenantId: documents.tenantId,
        title: documents.title,
        createdBy: documents.createdBy,
        schemaVersion: documentGenerations.schemaVersion,
        extensions: documentGenerations.extensions,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
        metadataRevision: documents.metadataRevision,
      })
      .from(documents)
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.tenantId, tenantId),
          eq(documents.status, "active"),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
