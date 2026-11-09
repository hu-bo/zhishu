import { stableJsonStringify } from "../../shared/stable-json.js";
import { summarizeDocumentContent, type DocumentAssetReference } from "./document-content.js";
import {
  insertProjectionOutbox,
  insertEmptyProjectionSnapshot,
} from "./document-projection.repository.js";
import { lockKnowledgeTree, readKnowledgeTree } from "../../shared/knowledge-transaction.js";
import {
  accessRoles,
  effectiveActions,
  permissionActions,
  type AccessRole,
  type PermissionAction,
} from "../authorization/policy.js";
import { catalogActionSql, loadPolicyOverrides } from "../authorization/access.js";
import { recordBodyMentionNotifications } from "./body-mentions.js";
import { documentRecipients, insertNotifications } from "../notifications/index.js";
import {
  documentActionSql,
  documentGrantActiveSql,
  hasDocumentPermission,
  requireDocumentManager,
  type DocumentAccessMode,
} from "../authorization/permissions.js";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import type { DocumentTag } from "./document.schema.js";
import { DomainError } from "../../shared/domain-error.js";
import type { DocumentWriteTransaction } from "../collaboration/owner.js";
import { ensureRootCatalog, workspaceNameSql } from "../catalogs/index.js";
import { requireWorkspaceOrganizer } from "../authorization/permissions.js";
import {
  assetReferences,
  assets,
  apiIdempotencyRecords,
  catalogs,
  collaborationUpdates,
  documentAuditEvents,
  resourceAcl,
  identityProfiles,
  documentFavorites,
  documentGenerationCheckpoints,
  documentGenerations,
  documentMigrationSnapshots,
  documentProjectionSnapshots,
  documentRecents,
  documentVersions,
  documents,
  workspaces,
} from "../../../database/schema/index.js";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  type ContentMigrationReport,
  type ContentMigrationStepSnapshot,
  type DocumentContent,
} from "@zhishu/document-contracts";
const validPermissionActions = new Set<string>(permissionActions);

function assetReferencesMatchReadyAssets(
  references: readonly DocumentAssetReference[],
  readyAssets: readonly { id: string; mediaType: string }[],
): boolean {
  const expectedMediaTypes = new Map<string, string>();
  for (const reference of references) {
    const current = expectedMediaTypes.get(reference.assetId);
    if (current && current !== reference.mediaType) return false;
    expectedMediaTypes.set(reference.assetId, reference.mediaType);
  }
  return (
    expectedMediaTypes.size === readyAssets.length &&
    readyAssets.every((asset) => expectedMediaTypes.get(asset.id) === asset.mediaType)
  );
}

function isPermissionAction(value: string): value is PermissionAction {
  return validPermissionActions.has(value);
}

type DocumentAuditAction =
  | "document.created"
  | "document.content-updated"
  | "document.collaboration-enabled"
  | "document.imported"
  | "document.exported"
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

type MigrationSnapshotExecutor = Pick<Database, "insert">;

async function insertMigrationSnapshots(
  executor: MigrationSnapshotExecutor,
  input: {
    tenantId: string;
    documentId: string;
    migrationId?: string;
    stepSnapshots?: readonly ContentMigrationStepSnapshot[];
  },
): Promise<void> {
  if (!input.migrationId || !input.stepSnapshots?.length) return;
  await executor.insert(documentMigrationSnapshots).values(
    input.stepSnapshots.map((step, stepIndex) => ({
      tenantId: input.tenantId,
      documentId: input.documentId,
      migrationId: input.migrationId!,
      stepIndex,
      stepId: step.id,
      summary: step.summary,
      fromSchemaVersion: step.fromSchemaVersion,
      toSchemaVersion: step.toSchemaVersion,
      content: step.content,
      contentHash: createHash("sha256").update(stableJsonStringify(step.content)).digest("hex"),
    })),
  );
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
  workspaceId?: string;
  catalogId?: string;
  position?: number;
  icon?: string | null;
  tags?: DocumentTag[];
  accessMode?: DocumentAccessMode;
  canManage?: boolean;
  canWrite?: boolean;
  offlineCacheAllowed?: boolean;
  canComment?: boolean;
  canMove?: boolean;
  canShare?: boolean;
  canExport?: boolean;
  createdBy: string;
  schemaVersion: number;
  extensions: Array<{ name: string; version: string; required: boolean }>;
  generationId: string;
  durableSeq: number;
  createdAt: Date;
  updatedAt: Date;
  metadataRevision: number;
};

export type DocumentIdempotency = {
  operationId:
    | "documents.create"
    | "documents.import"
    | "documents.copy"
    | "documents.version.create"
    | "documents.metadata.update"
    | "documents.lifecycle"
    | "documents.acl.set"
    | "documents.acl.remove"
    | "documents.version.restore";
  key: string;
  requestHash: string;
};

type IdempotencyExecutor = Pick<Database, "delete" | "execute" | "insert" | "select">;

function parseStoredActiveDocument(value: Record<string, unknown>): ActiveDocument {
  const createdAt = new Date(String(value.createdAt));
  const updatedAt = new Date(String(value.updatedAt));
  if (
    typeof value.id !== "string" ||
    typeof value.tenantId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.createdBy !== "string" ||
    typeof value.schemaVersion !== "number" ||
    !Array.isArray(value.extensions) ||
    typeof value.generationId !== "string" ||
    typeof value.durableSeq !== "number" ||
    Number.isNaN(createdAt.getTime()) ||
    Number.isNaN(updatedAt.getTime()) ||
    typeof value.metadataRevision !== "number"
  ) {
    throw new Error("Stored document creation response is invalid");
  }
  return {
    id: value.id,
    tenantId: value.tenantId,
    title: value.title,
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : "ws_default",
    catalogId: typeof value.catalogId === "string" ? value.catalogId : "",
    position: typeof value.position === "number" ? value.position : 0,
    icon: typeof value.icon === "string" ? value.icon : null,
    tags: Array.isArray(value.tags) ? (value.tags as NonNullable<ActiveDocument["tags"]>) : [],
    accessMode:
      value.accessMode === "personal" || value.accessMode === "workspace-inherited"
        ? value.accessMode
        : "restricted",
    createdBy: value.createdBy,
    schemaVersion: value.schemaVersion,
    extensions: value.extensions as ActiveDocument["extensions"],
    generationId: value.generationId,
    durableSeq: value.durableSeq,
    createdAt,
    updatedAt,
    metadataRevision: value.metadataRevision,
  };
}

function parseStoredDocumentVersion(value: Record<string, unknown>): DocumentVersion {
  const createdAt = new Date(String(value.createdAt));
  if (
    typeof value.id !== "string" ||
    typeof value.documentId !== "string" ||
    typeof value.generationId !== "string" ||
    typeof value.name !== "string" ||
    (value.kind !== "named" && value.kind !== "automatic") ||
    typeof value.durableSeq !== "number" ||
    typeof value.createdBy !== "string" ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new Error("Stored document version response is invalid");
  }
  return {
    id: value.id,
    documentId: value.documentId,
    generationId: value.generationId,
    name: value.name,
    kind: value.kind,
    durableSeq: value.durableSeq,
    createdBy: value.createdBy,
    createdAt,
  };
}

function parseStoredLifecycleResponse(value: Record<string, unknown>): string {
  if (typeof value.generationId !== "string") {
    throw new Error("Stored document lifecycle response is invalid");
  }
  return value.generationId;
}

function parseStoredAclResponse(value: Record<string, unknown>): {
  generationId: string;
  actions: PermissionAction[];
} {
  if (
    typeof value.generationId !== "string" ||
    !Array.isArray(value.actions) ||
    !value.actions.every(
      (action): action is PermissionAction =>
        typeof action === "string" && isPermissionAction(action),
    )
  ) {
    throw new Error("Stored document ACL idempotency response is invalid");
  }
  return { generationId: value.generationId, actions: value.actions };
}

function parseStoredVersionRestoreResponse(value: Record<string, unknown>): {
  previousGenerationId: string;
  document: ActiveDocument;
} {
  if (
    typeof value.previousGenerationId !== "string" ||
    typeof value.document !== "object" ||
    value.document === null ||
    Array.isArray(value.document)
  ) {
    throw new Error("Stored document version restore response is invalid");
  }
  return {
    previousGenerationId: value.previousGenerationId,
    document: parseStoredActiveDocument(value.document as Record<string, unknown>),
  };
}

async function loadIdempotencyReplay<T>(
  tx: IdempotencyExecutor,
  input: {
    tenantId: string;
    subjectId: string;
    idempotency: DocumentIdempotency;
  },
  parseResponse: (value: Record<string, unknown>) => T,
): Promise<T | null> {
  const keyHash = createHash("sha256").update(input.idempotency.key).digest("hex");
  const lockKey = [input.tenantId, input.subjectId, input.idempotency.operationId, keyHash].join(
    ":",
  );
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 718269))`);
  const [record] = await tx
    .select()
    .from(apiIdempotencyRecords)
    .where(
      and(
        eq(apiIdempotencyRecords.tenantId, input.tenantId),
        eq(apiIdempotencyRecords.subjectId, input.subjectId),
        eq(apiIdempotencyRecords.operationId, input.idempotency.operationId),
        eq(apiIdempotencyRecords.keyHash, keyHash),
      ),
    )
    .for("update")
    .limit(1);
  if (!record) return null;
  if (record.expiresAt.getTime() <= Date.now()) {
    await tx
      .delete(apiIdempotencyRecords)
      .where(
        and(
          eq(apiIdempotencyRecords.tenantId, input.tenantId),
          eq(apiIdempotencyRecords.subjectId, input.subjectId),
          eq(apiIdempotencyRecords.operationId, input.idempotency.operationId),
          eq(apiIdempotencyRecords.keyHash, keyHash),
        ),
      );
    return null;
  }
  if (record.requestHash !== input.idempotency.requestHash) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was reused with a different request",
    );
  }
  return parseResponse(record.responseBody);
}

function loadDocumentIdempotencyReplay(
  tx: IdempotencyExecutor,
  input: { tenantId: string; subjectId: string; idempotency: DocumentIdempotency },
): Promise<ActiveDocument | null> {
  return loadIdempotencyReplay(tx, input, parseStoredActiveDocument);
}

function loadVersionIdempotencyReplay(
  tx: IdempotencyExecutor,
  input: { tenantId: string; subjectId: string; idempotency: DocumentIdempotency },
): Promise<DocumentVersion | null> {
  return loadIdempotencyReplay(tx, input, parseStoredDocumentVersion);
}

function loadLifecycleIdempotencyReplay(
  tx: IdempotencyExecutor,
  input: { tenantId: string; subjectId: string; idempotency: DocumentIdempotency },
): Promise<string | null> {
  return loadIdempotencyReplay(tx, input, parseStoredLifecycleResponse);
}

function loadAclIdempotencyReplay(
  tx: IdempotencyExecutor,
  input: { tenantId: string; subjectId: string; idempotency: DocumentIdempotency },
): Promise<{ generationId: string; actions: PermissionAction[] } | null> {
  return loadIdempotencyReplay(tx, input, parseStoredAclResponse);
}

function loadVersionRestoreIdempotencyReplay(
  tx: IdempotencyExecutor,
  input: { tenantId: string; subjectId: string; idempotency: DocumentIdempotency },
): Promise<{ previousGenerationId: string; document: ActiveDocument } | null> {
  return loadIdempotencyReplay(tx, input, parseStoredVersionRestoreResponse);
}

async function saveIdempotencyReplay(
  tx: IdempotencyExecutor,
  input: {
    tenantId: string;
    subjectId: string;
    idempotency: DocumentIdempotency;
    response: object;
    responseStatus?: 200 | 201 | 204;
  },
): Promise<void> {
  await tx.insert(apiIdempotencyRecords).values({
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    operationId: input.idempotency.operationId,
    keyHash: createHash("sha256").update(input.idempotency.key).digest("hex"),
    requestHash: input.idempotency.requestHash,
    responseStatus:
      input.responseStatus ?? (input.idempotency.operationId === "documents.import" ? 200 : 201),
    responseBody: input.response as Record<string, unknown>,
  });
}

export type DocumentListView = "all" | "mine" | "recent" | "favorites" | "archived" | "trash";
export type DocumentLifecycleResult =
  | { status: "not-found" }
  | { status: "not-owner" }
  | { status: "conflict"; currentStatus: string }
  | { status: "updated" | "replayed"; generationId: string };

export type DocumentListItem = ActiveDocument & {
  isFavorite: boolean;
  deletedAt: Date | null;
  workspaceName: string;
  excerpt: string;
};
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
  | { status: "replayed"; version: DocumentVersion }
  | {
      status: "restored" | "restore-replayed";
      previousGenerationId: string;
      document: ActiveDocument;
    };

export type GenerationSwitchResult =
  | { status: "not-found" | "conflict" }
  | {
      status: "migrated" | "repaired";
      previousGenerationId: string;
      document: ActiveDocument;
    };

export type AclChangeResult =
  | { status: "not-found" }
  | { status: "not-owner" }
  | { status: "updated" | "replayed"; generationId: string; actions: PermissionAction[] };

export type DocumentAclEntry = {
  documentId: string;
  identityId: string;
  actions: PermissionAction[];
  role?: AccessRole;
  grantedAt?: string;
  displayName?: string;
  email?: string;
};

export class DocumentRepository {
  constructor(private readonly db: Database) {}

  async findDocumentIdempotencyReplay(input: {
    tenantId: string;
    subjectId: string;
    idempotency: DocumentIdempotency;
  }): Promise<ActiveDocument | null> {
    return this.db.transaction((tx) => loadDocumentIdempotencyReplay(tx, input));
  }

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
    initialUpdate?: { updateHash: string; updateBytes: Uint8Array; content: DocumentContent },
    idempotency?: DocumentIdempotency,
    migrationReport?: ContentMigrationReport,
    migrationPersistence?: {
      migrationId: string;
      stepSnapshots: readonly ContentMigrationStepSnapshot[];
    },
    location: { workspaceId: string; catalogId: string | null } = {
      workspaceId: "ws_default",
      catalogId: null,
    },
  ): Promise<ActiveDocument> {
    const documentId = `doc_${randomUUID()}`;
    const generationId = `gen_${randomUUID()}`;
    return this.db.transaction(async (tx) => {
      if (idempotency) {
        const replay = await loadDocumentIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
        });
        if (replay) return replay;
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${tenantId}`}, 718267))`,
      );
      await lockKnowledgeTree(tx, tenantId, ownerId);
      await tx
        .insert(workspaces)
        .values({
          tenantId,
          id: "ws_default",
          name: "团队知识库",
          kind: "team",
          createdBy: "system",
        })
        .onConflictDoNothing();
      const [workspace] = await tx
        .select({ id: workspaces.id, kind: workspaces.kind })
        .from(workspaces)
        .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, location.workspaceId)))
        .limit(1);
      if (!workspace) throw new DomainError("NOT_FOUND", "Workspace not found");
      await requireWorkspaceOrganizer(tx, { tenantId, identityId: ownerId }, location.workspaceId);
      const catalogId =
        location.catalogId ?? (await ensureRootCatalog(tx, tenantId, location.workspaceId));
      if (location.catalogId) {
        const [catalog] = await tx
          .select({ id: catalogs.id })
          .from(catalogs)
          .where(
            and(
              eq(catalogs.tenantId, tenantId),
              eq(catalogs.id, location.catalogId),
              eq(catalogs.workspaceId, location.workspaceId),
              catalogActionSql({ tenantId, identityId: ownerId }, "write"),
            ),
          )
          .limit(1);
        if (!catalog) throw new DomainError("NOT_FOUND", "Catalog is unavailable");
      }
      const [lastPosition] = await tx
        .select({ value: sql<number>`coalesce(max(${documents.position}), -1)::int + 1` })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            eq(documents.workspaceId, location.workspaceId),
            eq(documents.catalogId, catalogId),
            eq(documents.status, "active"),
          ),
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
        .values({
          id: documentId,
          tenantId,
          title,
          createdBy: ownerId,
          accessMode:
            workspace.kind === "team"
              ? "workspace-inherited"
              : workspace.kind === "personal"
                ? "personal"
                : "restricted",
          workspaceId: location.workspaceId,
          catalogId,
          position: lastPosition?.value ?? 0,
        })
        .returning();
      if (!document) throw new Error("Document insert returned no row");
      if (document.accessMode !== "workspace-inherited")
        await tx
          .insert(resourceAcl)
          .values({ tenantId, documentId, identityId: ownerId, role: "admin", createdBy: ownerId });
      await requireDocumentManager(tx, tenantId, documentId);

      const [generation] = await tx
        .insert(documentGenerations)
        .values({
          id: generationId,
          documentId,
          schemaVersion: template?.schemaVersion ?? CURRENT_DOCUMENT_SCHEMA_VERSION,
          extensions: template?.extensions ?? [],
          durableSeq: initialUpdate ? 1 : 0,
        })
        .returning();
      if (!generation) throw new Error("Generation insert returned no row");

      await insertDocumentAudit(tx, {
        tenantId,
        actorIdentityId: ownerId,
        action: initialUpdate ? "document.imported" : "document.created",
        resourceId: document.id,
        generationId: generation.id,
        requestId,
        ...(initialUpdate
          ? {
              details: {
                schemaVersion: generation.schemaVersion,
                blockCount: summarizeDocumentContent(initialUpdate.content).blockCount,
                ...(migrationReport ? { migration: migrationReport } : {}),
                ...(migrationPersistence ? { migrationId: migrationPersistence.migrationId } : {}),
              },
            }
          : {}),
      });
      await insertMigrationSnapshots(tx, {
        tenantId,
        documentId: document.id,
        ...migrationPersistence,
      });
      if (initialUpdate) {
        await tx.insert(collaborationUpdates).values({
          documentId: document.id,
          generationId: generation.id,
          updateHash: initialUpdate.updateHash,
          sourceUpdateHash: initialUpdate.updateHash,
          updateBytes: Buffer.from(initialUpdate.updateBytes),
          durableSeq: 1,
          createdBy: ownerId,
        });
        await insertProjectionOutbox(tx, {
          tenantId,
          documentId: document.id,
          generationId: generation.id,
          durableSeq: 1,
          updateHash: initialUpdate.updateHash,
          contentChanged: true,
          content: initialUpdate.content,
        });
      } else {
        await insertEmptyProjectionSnapshot(tx, {
          tenantId,
          documentId: document.id,
          generationId: generation.id,
        });
      }

      const createdDocument: ActiveDocument = {
        id: document.id,
        tenantId: document.tenantId,
        title: document.title,
        workspaceId: document.workspaceId,
        catalogId: document.catalogId,
        position: document.position,
        icon: document.icon,
        tags: document.tags,
        accessMode: document.accessMode,
        createdBy: document.createdBy,
        schemaVersion: generation.schemaVersion,
        extensions: generation.extensions,
        generationId: generation.id,
        durableSeq: initialUpdate ? 1 : generation.durableSeq,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        metadataRevision: document.metadataRevision,
      };
      if (idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
          response: createdDocument,
        });
      }
      return createdDocument;
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
    migrationPersistence?: {
      migrationId: string;
      stepSnapshots: readonly ContentMigrationStepSnapshot[];
    };
    requestId?: string;
    maxDocumentsPerTenant: number;
    idempotency?: DocumentIdempotency;
  }): Promise<
    | { status: "not-found" }
    | { status: "conflict" }
    | { status: "quota-exceeded" }
    | { status: "copied"; document: ActiveDocument }
    | { status: "replayed"; document: ActiveDocument }
  > {
    return this.db.transaction(async (tx) => {
      if (input.idempotency) {
        const replay = await loadDocumentIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
        });
        if (replay) return { status: "replayed", document: replay };
      }

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`document-quota:${input.tenantId}`}, 718267))`,
      );
      await lockKnowledgeTree(tx, input.tenantId, input.identityId);
      const [template] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          createdBy: documents.createdBy,
          accessMode: documents.accessMode,
        })
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

      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.identityId },
          template.id,
          "export",
        ))
      ) {
        throw new DomainError("NOT_FOUND", "Template document is unavailable");
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
      const copyCatalogId = await ensureRootCatalog(tx, input.tenantId, "ws_default");
      await requireWorkspaceOrganizer(
        tx,
        { tenantId: input.tenantId, identityId: input.identityId },
        "ws_default",
      );
      const [document] = await tx
        .insert(documents)
        .values({
          id: documentId,
          tenantId: input.tenantId,
          title: input.title,
          createdBy: input.identityId,
          catalogId: copyCatalogId,
        })
        .returning();
      if (!document) throw new Error("Copied document insert returned no row");
      await tx.insert(resourceAcl).values({
        tenantId: input.tenantId,
        documentId,
        identityId: input.identityId,
        role: "admin",
        createdBy: input.identityId,
      });
      await requireDocumentManager(tx, input.tenantId, documentId);

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
        details: {
          sourceDocumentId: input.templateId,
          sourceDurableSeq: generation.durableSeq,
          ...(input.migrationPersistence
            ? { migrationId: input.migrationPersistence.migrationId }
            : {}),
        },
      });
      await insertMigrationSnapshots(tx, {
        tenantId: input.tenantId,
        documentId,
        ...input.migrationPersistence,
      });

      const copiedDocument: ActiveDocument = {
        id: document.id,
        tenantId: document.tenantId,
        title: document.title,
        workspaceId: document.workspaceId,
        catalogId: document.catalogId,
        position: document.position,
        icon: document.icon,
        tags: document.tags,
        accessMode: document.accessMode,
        createdBy: document.createdBy,
        schemaVersion: copiedGeneration.schemaVersion,
        extensions: copiedGeneration.extensions,
        generationId: copiedGeneration.id,
        durableSeq: copiedGeneration.durableSeq,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        metadataRevision: document.metadataRevision,
      };
      if (input.idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
          response: copiedDocument,
        });
      }

      return {
        status: "copied",
        document: copiedDocument,
      };
    });
  }

  async list(input: {
    tenantId: string;
    identityId: string;
    view: DocumentListView;
    query?: string;
    workspaceId?: string;
    sort: "recent" | "updated" | "created" | "title";
    direction: "asc" | "desc";
    limit: number;
    offset: number;
  }): Promise<{ items: DocumentListItem[]; hasMore: boolean }> {
    const owner = eq(documents.createdBy, input.identityId);
    const readable = documentActionSql(input, "read");
    const status =
      input.view === "trash" ? "trashed" : input.view === "archived" ? "archived" : "active";
    const filters = [
      eq(documents.tenantId, input.tenantId),
      eq(documents.status, status),
      readable,
    ];
    if (input.workspaceId) filters.push(eq(documents.workspaceId, input.workspaceId));
    if (input.view === "mine") {
      filters.push(owner);
    }
    if (input.view === "archived" || input.view === "trash")
      filters.push(documentActionSql(input, "manage"));
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
    const statusLabels = sql.join(
      DOCUMENT_STATUSES.map((status) => sql`when ${status} then ${DOCUMENT_STATUS_LABELS[status]}`),
      sql` `,
    );
    // Same text aggregation as knowledge search, trimmed to a card-sized excerpt.
    const excerpt = sql<string>`left(coalesce((select string_agg(
      case value->>'type'
        when 'text' then value->>'text'
        when 'horizontalRule' then value#>>'{attrs,label}'
        when 'mention' then '@' || (value#>>'{attrs,label}')
        when 'statusTag' then case value#>>'{attrs,status}' ${statusLabels} end
      end, ' ')
      from jsonb_path_query(${documentProjectionSnapshots.content},
        'strict $.** ? (@.type() == "object" && (@.type == "text" || @.type == "horizontalRule" || @.type == "statusTag" || @.type == "mention"))') as value), ''), 160)`;
    const rows = await this.db
      .select({
        id: documents.id,
        tenantId: documents.tenantId,
        title: documents.title,
        workspaceId: documents.workspaceId,
        workspaceName: workspaceNameSql(input),
        catalogId: documents.catalogId,
        position: documents.position,
        icon: documents.icon,
        tags: documents.tags,
        canManage: documentActionSql(input, "manage"),
        canWrite: documentActionSql(input, "write"),
        offlineCacheAllowed: workspaces.offlineCacheAllowed,
        canComment: documentActionSql(input, "comment"),
        canMove: documentActionSql(input, "move"),
        canShare: documentActionSql(input, "share"),
        canExport: documentActionSql(input, "export"),

        createdBy: documents.createdBy,
        accessMode: documents.accessMode,
        excerpt,
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
        documentFavorites,
        and(
          eq(documentFavorites.tenantId, input.tenantId),
          eq(documentFavorites.documentId, documents.id),
          eq(documentFavorites.identityId, input.identityId),
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
      items: rows.slice(0, input.limit).map((row) => ({
        ...row,
        isFavorite: row.isFavorite,
      })),
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
    title?: string;
    icon?: string | null;
    tags?: DocumentTag[];
    accessMode?: DocumentAccessMode;
    canManage?: boolean;
    requestId?: string;
    idempotency?: DocumentIdempotency;
  }): Promise<
    | { status: "not-found" }
    | { status: "conflict" }
    | { status: "updated" | "replayed"; document: ActiveDocument }
  > {
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, input.tenantId);
      const [document] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          createdBy: documents.createdBy,
          accessMode: documents.accessMode,
          createdAt: documents.createdAt,
          metadataRevision: documents.metadataRevision,
        })
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
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.identityId },
          input.documentId,
          "write",
        ))
      )
        return { status: "not-found" };
      if (input.idempotency) {
        const replay = await loadDocumentIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
        });
        if (replay) return { status: "replayed", document: replay };
      }
      if (document.metadataRevision !== input.expectedRevision) return { status: "conflict" };
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
      if (!generation) return { status: "not-found" };
      const updatedAt = new Date();
      const [updatedDocument] = await tx
        .update(documents)
        .set({
          title: input.title,
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          metadataRevision: input.expectedRevision + 1,
          updatedAt,
        })
        .where(eq(documents.id, input.documentId))
        .returning();
      if (!updatedDocument) return { status: "not-found" };
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action: "document.title-updated",
        resourceId: input.documentId,
        requestId: input.requestId,
        details: { metadataRevision: input.expectedRevision + 1 },
      });
      const activeDocument: ActiveDocument = {
        id: updatedDocument.id,
        tenantId: updatedDocument.tenantId,
        title: updatedDocument.title,
        workspaceId: updatedDocument.workspaceId,
        catalogId: updatedDocument.catalogId,
        position: updatedDocument.position,
        icon: updatedDocument.icon,
        tags: updatedDocument.tags,
        accessMode: updatedDocument.accessMode,
        createdBy: updatedDocument.createdBy,
        schemaVersion: generation.schemaVersion,
        extensions: generation.extensions,
        generationId: generation.id,
        durableSeq: generation.durableSeq,
        createdAt: updatedDocument.createdAt,
        updatedAt: updatedDocument.updatedAt,
        metadataRevision: updatedDocument.metadataRevision,
      };
      if (input.idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
          response: activeDocument,
          responseStatus: 200,
        });
      }
      return { status: "updated", document: activeDocument };
    });
  }

  async setLifecycle(input: {
    tenantId: string;
    documentId: string;
    ownerId: string;
    operation: "archive" | "trash" | "restore" | "purge";
    requestId?: string;
    idempotency?: DocumentIdempotency;
  }): Promise<DocumentLifecycleResult> {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, input.tenantId, input.ownerId);
      if (input.idempotency) {
        const replay = await loadLifecycleIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.ownerId,
          idempotency: input.idempotency,
        });
        if (replay) return { status: "replayed", generationId: replay };
      }
      const [document] = await tx
        .select({
          createdBy: documents.createdBy,
          accessMode: documents.accessMode,
          status: documents.status,
        })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.ownerId },
          input.documentId,
          "manage",
        ))
      )
        return { status: "not-owner" };
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
      if (input.operation === "trash" || input.operation === "purge") {
        const recipients = await documentRecipients(tx, input.tenantId, input.documentId);
        await insertNotifications(
          tx,
          recipients.map((recipientId) => ({
            tenantId: input.tenantId,
            actorId: input.ownerId,
            recipientId,
            type: "deleted",
            eventKey: `deleted:${randomUUID()}`,
            documentId: input.documentId,
            message:
              input.operation === "purge"
                ? "一篇与你有关的文档已被永久删除"
                : "一篇与你有关的文档已移入回收站",
          })),
        );
      }
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
      if (input.idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.ownerId,
          idempotency: input.idempotency,
          response: { generationId: generation.id },
          responseStatus: 204,
        });
      }
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
    idempotency?: DocumentIdempotency;
  }): Promise<VersionMutationResult> {
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, input.tenantId);
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
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.identityId },
          input.documentId,
          "write",
        ))
      )
        return { status: "not-found" };
      if (input.idempotency) {
        const replay = await loadVersionIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
        });
        if (replay) return { status: "replayed", version: replay };
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
      const createdVersion: DocumentVersion = {
        ...version,
        kind: parseDocumentVersionKind(version.kind),
      };
      if (input.idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
          response: createdVersion,
        });
      }
      return {
        status: "created",
        version: createdVersion,
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
    return version
      ? {
          ...version,
          kind: parseDocumentVersionKind(version.kind),
        }
      : null;
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
    stateBytes: Uint8Array;
    idempotency?: DocumentIdempotency;
  }): Promise<VersionMutationResult> {
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, input.tenantId);
      const [document] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          title: documents.title,
          workspaceId: documents.workspaceId,
          catalogId: documents.catalogId,
          position: documents.position,
          icon: documents.icon,
          tags: documents.tags,
          createdBy: documents.createdBy,
          accessMode: documents.accessMode,
          status: documents.status,
          metadataRevision: documents.metadataRevision,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
        .for("update")
        .limit(1);
      if (!document || document.status !== "active") return { status: "not-found" };
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.identityId },
          input.documentId,
          "write",
        ))
      )
        return { status: "not-found" };
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
      if (input.idempotency) {
        const replay = await loadVersionRestoreIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
        });
        if (replay) return { status: "restore-replayed", ...replay };
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
      const targetDurableSeq = version.durableSeq;
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
        durableSeq: targetDurableSeq,
      });
      if (version.durableSeq === 0) {
        await insertEmptyProjectionSnapshot(tx, {
          tenantId: input.tenantId,
          documentId: input.documentId,
          generationId: nextGenerationId,
        });
      } else {
        const updateHash = createHash("sha256").update(input.stateBytes).digest("hex");
        await tx.insert(documentGenerationCheckpoints).values({
          documentId: input.documentId,
          generationId: nextGenerationId,
          durableSeq: targetDurableSeq,
          stateBytes: Buffer.from(input.stateBytes),
          stateHash: updateHash,
        });
        await tx.insert(collaborationUpdates).values({
          documentId: input.documentId,
          generationId: nextGenerationId,
          updateHash,
          updateBytes: null,
          durableSeq: targetDurableSeq,
          createdBy: input.identityId,
        });
        await insertProjectionOutbox(tx, {
          tenantId: input.tenantId,
          documentId: input.documentId,
          generationId: nextGenerationId,
          durableSeq: targetDurableSeq,
          updateHash,
          contentChanged: true,
          content: input.content,
        });
      }
      if (targetDurableSeq > 0) {
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
      }
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
          durableSeq: targetDurableSeq,
        },
      });
      const restored: ActiveDocument = {
        id: document.id,
        tenantId: document.tenantId,
        title: document.title,
        workspaceId: document.workspaceId,
        catalogId: document.catalogId,
        position: document.position,
        icon: document.icon,
        tags: document.tags,
        accessMode: document.accessMode,
        createdBy: document.createdBy,
        schemaVersion: sourceGeneration.schemaVersion,
        extensions: sourceGeneration.extensions,
        generationId: nextGenerationId,
        durableSeq: targetDurableSeq,
        createdAt: document.createdAt,
        updatedAt,
        metadataRevision: document.metadataRevision + 1,
      };
      if (input.idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.identityId,
          idempotency: input.idempotency,
          response: { previousGenerationId: currentGeneration.id, document: restored },
          responseStatus: 200,
        });
      }
      return {
        status: "restored",
        previousGenerationId: currentGeneration.id,
        document: restored,
      };
    });
  }

  async findProjectionContentSnapshot(
    tenantId: string,
    documentId: string,
    generationId: string,
  ): Promise<{ snapshotRevision: number; durableSeq: number; content: DocumentContent } | null> {
    const [snapshot] = await this.db
      .select({
        snapshotRevision: documentProjectionSnapshots.snapshotRevision,
        durableSeq: documentProjectionSnapshots.durableSeq,
        content: documentProjectionSnapshots.content,
      })
      .from(documentProjectionSnapshots)
      .where(
        and(
          eq(documentProjectionSnapshots.tenantId, tenantId),
          eq(documentProjectionSnapshots.documentId, documentId),
          eq(documentProjectionSnapshots.generationId, generationId),
        ),
      )
      .limit(1);
    if (!snapshot) return null;
    return {
      snapshotRevision: snapshot.snapshotRevision,
      durableSeq: snapshot.durableSeq,
      content: snapshot.content,
    };
  }

  async recordExport(input: {
    tenantId: string;
    documentId: string;
    identityId: string;
    generationId: string;
    durableSeq: number;
    schemaVersion: number;
    blockCount: number;
    requestId?: string;
  }): Promise<"not-found" | "conflict" | "not-authorized" | "recorded"> {
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, input.tenantId);
      const [document] = await tx
        .select({
          id: documents.id,
          createdBy: documents.createdBy,
          accessMode: documents.accessMode,
          generationId: documentGenerations.id,
          durableSeq: documentGenerations.durableSeq,
          schemaVersion: documentGenerations.schemaVersion,
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
            eq(documents.id, input.documentId),
            eq(documents.tenantId, input.tenantId),
            eq(documents.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (!document) return "not-found";
      if (
        document.generationId !== input.generationId ||
        document.durableSeq !== input.durableSeq ||
        document.schemaVersion !== input.schemaVersion
      ) {
        return "conflict";
      }
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.identityId },
          input.documentId,
          "export",
        ))
      )
        throw new DomainError("NOT_FOUND", "Document not found");
      await insertDocumentAudit(tx, {
        tenantId: input.tenantId,
        actorIdentityId: input.identityId,
        action: "document.exported",
        resourceId: input.documentId,
        generationId: input.generationId,
        requestId: input.requestId,
        details: {
          schemaVersion: input.schemaVersion,
          durableSeq: input.durableSeq,
          blockCount: input.blockCount,
        },
      });
      return "recorded";
    });
  }

  async setAcl(
    tenantId: string,
    documentId: string,
    ownerId: string,
    identityId: string,
    actions: readonly PermissionAction[],
    requestId?: string,
    idempotency?: DocumentIdempotency,
    role?: AccessRole,
  ): Promise<AclChangeResult> {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, tenantId, ownerId);
      const [document] = await tx
        .select({
          id: documents.id,
          createdBy: documents.createdBy,
          workspaceId: documents.workspaceId,
        })
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
      if (
        !(await hasDocumentPermission(tx, { tenantId, identityId: ownerId }, documentId, "manage"))
      )
        return { status: "not-owner" };

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

      if (idempotency) {
        const replay = await loadAclIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
        });
        if (replay) return { status: "replayed", ...replay };
      }

      if (role)
        actions = effectiveActions(
          "document",
          role,
          await loadPolicyOverrides(tx, tenantId, document.workspaceId),
        ).filter(isPermissionAction);
      const grants = role ? [role] : actions;
      const previous = await tx
        .select()
        .from(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, tenantId),
            eq(resourceAcl.documentId, documentId),
            eq(resourceAcl.identityId, identityId),
            isNull(resourceAcl.sourceShareId),
          ),
        );
      const [profile] = await tx
        .select()
        .from(identityProfiles)
        .where(
          and(eq(identityProfiles.tenantId, tenantId), eq(identityProfiles.identityId, identityId)),
        )
        .limit(1);
      if (!profile) throw new DomainError("VALIDATION_ERROR", "请选择同租户的真实成员");
      if (
        previous.length === grants.length &&
        previous.every((p) => grants.some((g) => g === p.role))
      ) {
        if (idempotency)
          await saveIdempotencyReplay(tx, {
            tenantId,
            subjectId: ownerId,
            idempotency,
            response: { generationId: generation.id, actions: [...actions] },
            responseStatus: 200,
          });
        return { status: "updated", generationId: generation.id, actions: [...actions] };
      }
      await tx
        .delete(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, tenantId),
            eq(resourceAcl.documentId, documentId),
            eq(resourceAcl.identityId, identityId),
            isNull(resourceAcl.sourceShareId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(resourceAcl).values(
          grants.map((action) => ({
            tenantId,
            documentId,
            identityId,
            role: action,
            createdBy: previous.find((p) => p.role === action)?.createdBy ?? ownerId,
            createdAt: previous.find((p) => p.role === action)?.createdAt ?? new Date(),
          })),
        );
      }
      await requireDocumentManager(tx, tenantId, documentId);
      await insertNotifications(tx, [
        {
          tenantId,
          actorId: ownerId,
          recipientId: identityId,
          type: previous.length ? "permission" : "share",
          eventKey: `acl:${randomUUID()}`,
          documentId,
          message: previous.length ? "你的文档权限已更新" : "有人向你分享了一篇文档",
        },
      ]);
      await insertDocumentAudit(tx, {
        tenantId,
        actorIdentityId: ownerId,
        action: "document.acl-updated",
        resourceId: documentId,
        generationId: generation.id,
        requestId,
        details: { subjectIdentityId: identityId, actions: [...actions] },
      });
      if (idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
          response: { generationId: generation.id, actions: [...actions] },
          responseStatus: 200,
        });
      }
      return { status: "updated", generationId: generation.id, actions: [...actions] };
    });
  }

  async listAcl(
    tenantId: string,
    documentId: string,
    ownerId: string,
  ): Promise<DocumentAclEntry[] | null> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ createdBy: documents.createdBy, workspaceId: documents.workspaceId })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            eq(documents.status, "active"),
          ),
        )
        .limit(1);
      if (
        !document ||
        !(await hasDocumentPermission(tx, { tenantId, identityId: ownerId }, documentId, "manage"))
      )
        return null;

      const rows = await tx
        .select({
          identityId: resourceAcl.identityId,
          action: resourceAcl.role,
          grantedAt: resourceAcl.createdAt,
          displayName: identityProfiles.displayName,
          email: identityProfiles.email,
        })
        .from(resourceAcl)
        .innerJoin(
          documents,
          and(
            eq(documents.tenantId, resourceAcl.tenantId),
            eq(documents.id, resourceAcl.documentId),
          ),
        )
        .leftJoin(
          identityProfiles,
          and(
            eq(identityProfiles.tenantId, resourceAcl.tenantId),
            eq(identityProfiles.identityId, resourceAcl.identityId),
          ),
        )
        .where(
          and(
            eq(resourceAcl.tenantId, tenantId),
            eq(resourceAcl.documentId, documentId),
            documentGrantActiveSql(undefined, true, "resource_acl"),
          ),
        )
        .orderBy(asc(resourceAcl.identityId), asc(resourceAcl.role));
      const overrides = await loadPolicyOverrides(tx, tenantId, document.workspaceId);
      const grouped = new Map<string, PermissionAction[]>();
      for (const row of rows) {
        const actions = grouped.get(row.identityId) ?? [];
        actions.push(
          ...effectiveActions("document", row.action, overrides).filter(isPermissionAction),
        );
        grouped.set(row.identityId, [...new Set(actions)]);
      }
      return [...grouped.entries()].map(([identityId, actions]) => ({
        documentId,
        identityId,
        actions,
        role: accessRoles.find((role) =>
          rows.some((r) => r.identityId === identityId && r.action === role),
        ),
        grantedAt: rows
          .filter((r) => r.identityId === identityId)
          .map((r) => r.grantedAt.toISOString())
          .sort()[0],
        displayName: rows.find((r) => r.identityId === identityId)?.displayName ?? identityId,
        email: rows.find((r) => r.identityId === identityId)?.email ?? "",
      }));
    });
  }

  async removeAcl(
    tenantId: string,
    documentId: string,
    ownerId: string,
    identityId: string,
    requestId?: string,
    idempotency?: DocumentIdempotency,
  ): Promise<AclChangeResult> {
    return this.db.transaction(async (tx) => {
      await lockKnowledgeTree(tx, tenantId, ownerId);
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
      if (
        !(await hasDocumentPermission(tx, { tenantId, identityId: ownerId }, documentId, "manage"))
      )
        return { status: "not-owner" };

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

      if (idempotency) {
        const replay = await loadAclIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
        });
        if (replay) return { status: "replayed", ...replay };
      }

      const removed = await tx
        .delete(resourceAcl)
        .where(
          and(
            eq(resourceAcl.tenantId, tenantId),
            eq(resourceAcl.documentId, documentId),
            eq(resourceAcl.identityId, identityId),
          ),
        )
        .returning({ identityId: resourceAcl.identityId });
      await requireDocumentManager(tx, tenantId, documentId);
      if (removed.length)
        await insertNotifications(tx, [
          {
            tenantId,
            actorId: ownerId,
            recipientId: identityId,
            type: "permission",
            eventKey: `acl-removed:${randomUUID()}`,
            documentId,
            message: "你的一项文档单独授权已撤销",
          },
        ]);
      await insertDocumentAudit(tx, {
        tenantId,
        actorIdentityId: ownerId,
        action: "document.acl-removed",
        resourceId: documentId,
        generationId: generation.id,
        requestId,
        details: { subjectIdentityId: identityId },
      });
      if (idempotency) {
        await saveIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
          response: { generationId: generation.id, actions: [] },
          responseStatus: 204,
        });
      }
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
    assetReferences?: readonly DocumentAssetReference[];
    expectedDurableSeq?: number;
    guard?: (tx: DocumentWriteTransaction) => Promise<void>;
    record?: (tx: DocumentWriteTransaction, durableSeq: number) => Promise<void>;
  }): Promise<{ updateHash: string; durableSeq: number; duplicate: boolean }> {
    const sourceUpdateHash = input.sourceUpdateHash ?? input.updateHash;
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, input.tenantId);
      const [document] = await tx
        .select({
          id: documents.id,
          createdBy: documents.createdBy,
          workspaceId: documents.workspaceId,
        })
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
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.subjectId },
          input.documentId,
          "write",
        ))
      )
        throw new Error("Document authorization changed");

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

      // Text updates, structural commands and generation switches lock these same rows.
      // Keep the conditional version check and application guard inside that boundary.
      if (
        input.expectedDurableSeq !== undefined &&
        generation.durableSeq !== input.expectedDurableSeq
      )
        throw new DomainError("CONFLICT", "文档已更新，本次未写入。草稿已保留。");
      await input.guard?.(tx);

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
      await input.record?.(tx, durableSeq);

      if (input.contentChanged)
        await recordBodyMentionNotifications(tx, {
          tenantId: input.tenantId,
          documentId: input.documentId,
          workspaceId: document.workspaceId,
          generationId: generation.id,
          previousSeq: generation.durableSeq,
          durableSeq,
          actorId: input.subjectId,
          content: input.content,
        });

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
            .select({ id: assets.id, mediaType: assets.mediaType })
            .from(assets)
            .where(
              and(
                eq(assets.tenantId, input.tenantId),
                eq(assets.documentId, input.documentId),
                eq(assets.status, "ready"),
                inArray(assets.id, referencedAssetIds),
              ),
            );
          if (
            !assetReferencesMatchReadyAssets(input.assetReferences, readyAssets) ||
            readyAssets.length !== referencedAssetIds.length
          ) {
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
    migrationReport?: ContentMigrationReport;
    migrationPersistence?: {
      migrationId: string;
      stepSnapshots: readonly ContentMigrationStepSnapshot[];
    };
    requestId?: string;
  }): Promise<GenerationSwitchResult> {
    return this.db.transaction(async (tx) => {
      await readKnowledgeTree(tx, input.tenantId);
      const [document] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          title: documents.title,
          workspaceId: documents.workspaceId,
          catalogId: documents.catalogId,
          position: documents.position,
          icon: documents.icon,
          tags: documents.tags,
          createdBy: documents.createdBy,
          accessMode: documents.accessMode,
          status: documents.status,
          metadataRevision: documents.metadataRevision,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(eq(documents.id, input.documentId), eq(documents.tenantId, input.tenantId)))
        .for("update")
        .limit(1);
      if (!document || document.status !== "active") return { status: "not-found" };
      if (
        !(await hasDocumentPermission(
          tx,
          { tenantId: input.tenantId, identityId: input.identityId },
          input.documentId,
          "write",
        ))
      )
        return { status: "not-found" };

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
          ...(input.migrationReport ? { migration: input.migrationReport } : {}),
          ...(input.migrationPersistence
            ? { migrationId: input.migrationPersistence.migrationId }
            : {}),
        },
      });
      await insertMigrationSnapshots(tx, {
        tenantId: input.tenantId,
        documentId: input.documentId,
        ...input.migrationPersistence,
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
          workspaceId: document.workspaceId,
          catalogId: document.catalogId,
          position: document.position,
          icon: document.icon,
          tags: document.tags,
          accessMode: document.accessMode,
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
    action: PermissionAction,
  ): Promise<ActiveDocument | null> {
    const row = await this.findActiveRow(documentId, tenantId, identityId);
    if (
      !row ||
      !(await hasDocumentPermission(this.db, { tenantId, identityId }, documentId, action))
    )
      return null;
    return row;
  }

  private async findActiveRow(
    documentId: string,
    tenantId: string,
    identityId: string,
  ): Promise<ActiveDocument | null> {
    const [row] = await this.db
      .select({
        canManage: documentActionSql({ tenantId, identityId }, "manage"),
        canWrite: documentActionSql({ tenantId, identityId }, "write"),
        offlineCacheAllowed: sql<boolean>`coalesce((select w.offline_cache_allowed from workspaces w where w.tenant_id = ${tenantId} and w.id = documents.workspace_id),false)`,
        canComment: documentActionSql({ tenantId, identityId }, "comment"),
        canMove: documentActionSql({ tenantId, identityId }, "move"),
        canShare: documentActionSql({ tenantId, identityId }, "share"),
        canExport: documentActionSql({ tenantId, identityId }, "export"),

        id: documents.id,
        tenantId: documents.tenantId,
        title: documents.title,
        workspaceId: documents.workspaceId,
        catalogId: documents.catalogId,
        position: documents.position,
        icon: documents.icon,
        tags: documents.tags,
        createdBy: documents.createdBy,
        accessMode: documents.accessMode,
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
