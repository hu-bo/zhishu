import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import type { DocumentTag } from "./document.schema.js";
import { DomainError } from "../../shared/domain-error.js";
import type { DocumentWriteTransaction } from "../collaboration/owner.js";
import { ensureRootCatalog } from "./catalog.repository.js";
import { requireWorkspaceOrganizer } from "./workspace-access.js";
import {
  assetReferences,
  assets,
  apiIdempotencyRecords,
  catalogs,
  collaborationUpdates,
  documentAuditEvents,
  documentAcl,
  documentFavorites,
  documentGenerationCheckpoints,
  documentGenerations,
  documentMigrationSnapshots,
  documentOutbox,
  documentProjectionSnapshots,
  documentRecents,
  documentVersions,
  documentVersionCheckpoints,
  documents,
  workspaces,
} from "../../../database/schema/index.js";
import {
  documentPermissionActions,
  type DocumentPermissionAction,
} from "./document.permissions.js";

const yjsReplayPageSize = 16;
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  type ContentMigrationReport,
  type ContentMigrationStepSnapshot,
  type DocumentContent,
} from "@zhishu/document-contracts";

const PROJECTION_LEASE_MS = 30_000;
const PROJECTION_MAX_ATTEMPTS = 8;
const PROJECTION_RETRY_BASE_MS = 1_000;
const PROJECTION_RETRY_MAX_MS = 5 * 60_000;
const validDocumentPermissionActions = new Set<string>(documentPermissionActions);
type DocumentAssetReference = { assetId: string; blockId: string; mediaType: string };

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

function isDocumentPermissionAction(value: string): value is DocumentPermissionAction {
  return validDocumentPermissionActions.has(value);
}

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

export function summarizeDocumentContent(content: DocumentContent): ProjectionSummary {
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
    if (node.type === "image" || node.type === "pdfAttachment") assetCount += 1;
    if (node.type === "text" && typeof node.text === "string") textLength += [...node.text].length;
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return { blockCount, textLength, assetCount };
}

export function hashDocumentContent(content: DocumentContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJsonStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

type ProjectionOutboxExecutor = Pick<Database, "insert" | "update">;

export async function insertProjectionOutbox(
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
  workspaceId?: string;
  catalogId?: string;
  position?: number;
  icon?: string | null;
  tags?: DocumentTag[];
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
  actions: DocumentPermissionAction[];
} {
  if (
    typeof value.generationId !== "string" ||
    !Array.isArray(value.actions) ||
    !value.actions.every(
      (action): action is DocumentPermissionAction =>
        typeof action === "string" && isDocumentPermissionAction(action),
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
): Promise<{ generationId: string; actions: DocumentPermissionAction[] } | null> {
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

export type PersistedUpdate = {
  updateHash: string;
  updateBytes: Uint8Array;
  durableSeq: number;
};

export type YjsCompactionTarget = {
  documentId: string;
  generationId: string;
  durableSeq: number;
  checkpointSeq: number | null;
};

export type VersionCheckpointInput = {
  versionId: string;
  durableSeq: number;
  stateBytes: Uint8Array;
};

export type AclChangeResult =
  | { status: "not-found" }
  | { status: "not-owner" }
  | { status: "updated" | "replayed"; generationId: string; actions: DocumentPermissionAction[] };

export type DocumentAclEntry = {
  documentId: string;
  identityId: string;
  actions: DocumentPermissionAction[];
};

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

  async findDocumentIdempotencyReplay(input: {
    tenantId: string;
    subjectId: string;
    idempotency: DocumentIdempotency;
  }): Promise<ActiveDocument | null> {
    return this.db.transaction((tx) => loadDocumentIdempotencyReplay(tx, input));
  }

  async replayYjsState(
    input: {
      documentId: string;
      generationId: string;
      targetSeq: number;
      versionId?: string;
    },
    applyUpdate: (updateBytes: Uint8Array, durableSeq: number) => void,
    onAppliedSeq?: (durableSeq: number) => void,
  ): Promise<{ checkpointSeq: number }> {
    let checkpointSeq = 0;
    let checkpointBytes: Buffer | undefined;
    if (input.versionId) {
      const [snapshot] = await this.db
        .select({
          stateBytes: documentVersionCheckpoints.stateBytes,
          stateHash: documentVersionCheckpoints.stateHash,
        })
        .from(documentVersionCheckpoints)
        .innerJoin(documentVersions, eq(documentVersions.id, documentVersionCheckpoints.versionId))
        .where(
          and(
            eq(documentVersionCheckpoints.versionId, input.versionId),
            eq(documentVersions.documentId, input.documentId),
            eq(documentVersions.generationId, input.generationId),
            eq(documentVersions.durableSeq, input.targetSeq),
          ),
        )
        .limit(1);
      if (snapshot) {
        if (createHash("sha256").update(snapshot.stateBytes).digest("hex") !== snapshot.stateHash) {
          throw new Error("Version checkpoint checksum does not match");
        }
        checkpointSeq = input.targetSeq;
        checkpointBytes = snapshot.stateBytes;
      }
    }
    if (!checkpointBytes) {
      const [checkpoint] = await this.db
        .select({
          durableSeq: documentGenerationCheckpoints.durableSeq,
          stateBytes: documentGenerationCheckpoints.stateBytes,
          stateHash: documentGenerationCheckpoints.stateHash,
        })
        .from(documentGenerationCheckpoints)
        .where(
          and(
            eq(documentGenerationCheckpoints.documentId, input.documentId),
            eq(documentGenerationCheckpoints.generationId, input.generationId),
            lte(documentGenerationCheckpoints.durableSeq, input.targetSeq),
          ),
        )
        .limit(1);
      if (checkpoint) {
        if (
          createHash("sha256").update(checkpoint.stateBytes).digest("hex") !== checkpoint.stateHash
        ) {
          throw new Error("Generation checkpoint checksum does not match");
        }
        checkpointSeq = checkpoint.durableSeq;
        checkpointBytes = checkpoint.stateBytes;
      }
    }

    if (checkpointSeq > input.targetSeq) throw new Error("Yjs checkpoint is newer than the target");
    if (checkpointBytes) applyUpdate(new Uint8Array(checkpointBytes), checkpointSeq);
    onAppliedSeq?.(checkpointSeq);

    let nextSeq = checkpointSeq + 1;
    while (nextSeq <= input.targetSeq) {
      const rows = await this.db
        .select({
          durableSeq: collaborationUpdates.durableSeq,
          updateBytes: collaborationUpdates.updateBytes,
        })
        .from(collaborationUpdates)
        .where(
          and(
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generationId, input.generationId),
            gte(collaborationUpdates.durableSeq, nextSeq),
            lte(collaborationUpdates.durableSeq, input.targetSeq),
          ),
        )
        .orderBy(asc(collaborationUpdates.durableSeq))
        .limit(yjsReplayPageSize);
      if (rows.length === 0)
        throw new Error(`Yjs update history is incomplete at sequence ${nextSeq}`);
      for (const row of rows) {
        if (row.durableSeq !== nextSeq || !row.updateBytes) {
          throw new Error(`Yjs update history is incomplete at sequence ${nextSeq}`);
        }
        const updateBytes = new Uint8Array(row.updateBytes);
        applyUpdate(updateBytes, row.durableSeq);
        onAppliedSeq?.(row.durableSeq);
        nextSeq += 1;
      }
    }
    if (nextSeq - 1 !== input.targetSeq) {
      throw new Error("Yjs update history does not reach the requested sequence");
    }
    return { checkpointSeq };
  }

  async listYjsCompactionTargets(): Promise<YjsCompactionTarget[]> {
    const rows = await this.db
      .select({
        documentId: documentGenerations.documentId,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
        checkpointSeq: documentGenerationCheckpoints.durableSeq,
      })
      .from(documentGenerations)
      .leftJoin(
        documentGenerationCheckpoints,
        and(
          eq(documentGenerationCheckpoints.documentId, documentGenerations.documentId),
          eq(documentGenerationCheckpoints.generationId, documentGenerations.id),
        ),
      )
      .orderBy(asc(documentGenerations.documentId), asc(documentGenerations.createdAt));
    return rows;
  }

  async listVersionsNeedingCheckpoint(
    generationId: string,
    throughSeq: number,
  ): Promise<Array<{ versionId: string; durableSeq: number }>> {
    return this.db
      .select({ versionId: documentVersions.id, durableSeq: documentVersions.durableSeq })
      .from(documentVersions)
      .leftJoin(
        documentVersionCheckpoints,
        eq(documentVersionCheckpoints.versionId, documentVersions.id),
      )
      .where(
        and(
          eq(documentVersions.generationId, generationId),
          lte(documentVersions.durableSeq, throughSeq),
          isNull(documentVersionCheckpoints.versionId),
        ),
      )
      .orderBy(asc(documentVersions.durableSeq), asc(documentVersions.id));
  }

  async commitYjsCheckpoints(input: {
    documentId: string;
    generationId: string;
    durableSeq: number;
    stateBytes: Uint8Array;
    versionCheckpoints: readonly VersionCheckpointInput[];
  }): Promise<
    | { status: "not-found" | "conflict" | "stale" }
    | { status: "compacted"; prunedUpdates: number; prunedBytes: number; versionSnapshots: number }
  > {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .for("update")
        .limit(1);
      if (!document) return { status: "not-found" };

      const [generation] = await tx
        .select({ durableSeq: documentGenerations.durableSeq })
        .from(documentGenerations)
        .where(
          and(
            eq(documentGenerations.documentId, input.documentId),
            eq(documentGenerations.id, input.generationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!generation) return { status: "not-found" };
      if (generation.durableSeq !== input.durableSeq) return { status: "conflict" };

      const [existingCheckpoint] = await tx
        .select({ durableSeq: documentGenerationCheckpoints.durableSeq })
        .from(documentGenerationCheckpoints)
        .where(
          and(
            eq(documentGenerationCheckpoints.documentId, input.documentId),
            eq(documentGenerationCheckpoints.generationId, input.generationId),
          ),
        )
        .limit(1);
      if (existingCheckpoint && existingCheckpoint.durableSeq > input.durableSeq) {
        return { status: "conflict" };
      }

      const suppliedSnapshots = new Map(
        input.versionCheckpoints.map((checkpoint) => [checkpoint.versionId, checkpoint]),
      );
      const missingVersions = await tx
        .select({ versionId: documentVersions.id })
        .from(documentVersions)
        .leftJoin(
          documentVersionCheckpoints,
          eq(documentVersionCheckpoints.versionId, documentVersions.id),
        )
        .where(
          and(
            eq(documentVersions.generationId, input.generationId),
            lte(documentVersions.durableSeq, input.durableSeq),
            isNull(documentVersionCheckpoints.versionId),
          ),
        );
      if (missingVersions.some((version) => !suppliedSnapshots.has(version.versionId))) {
        return { status: "stale" };
      }
      if (input.versionCheckpoints.length > 0) {
        const validVersions = await tx
          .select({ id: documentVersions.id, durableSeq: documentVersions.durableSeq })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.generationId, input.generationId),
              lte(documentVersions.durableSeq, input.durableSeq),
              inArray(
                documentVersions.id,
                input.versionCheckpoints.map((item) => item.versionId),
              ),
            ),
          );
        if (
          validVersions.length !== input.versionCheckpoints.length ||
          input.versionCheckpoints.some(
            (snapshot) =>
              validVersions.find((version) => version.id === snapshot.versionId)?.durableSeq !==
              snapshot.durableSeq,
          )
        ) {
          return { status: "stale" };
        }
      }

      const createdAt = new Date();
      if (input.versionCheckpoints.length > 0) {
        await tx
          .insert(documentVersionCheckpoints)
          .values(
            input.versionCheckpoints.map((checkpoint) => ({
              versionId: checkpoint.versionId,
              stateBytes: Buffer.from(checkpoint.stateBytes),
              stateHash: createHash("sha256").update(checkpoint.stateBytes).digest("hex"),
              createdAt,
            })),
          )
          .onConflictDoNothing();
      }
      const stateHash = createHash("sha256").update(input.stateBytes).digest("hex");
      await tx
        .insert(documentGenerationCheckpoints)
        .values({
          documentId: input.documentId,
          generationId: input.generationId,
          durableSeq: input.durableSeq,
          stateBytes: Buffer.from(input.stateBytes),
          stateHash,
          createdAt,
        })
        .onConflictDoUpdate({
          target: [
            documentGenerationCheckpoints.documentId,
            documentGenerationCheckpoints.generationId,
          ],
          set: {
            durableSeq: input.durableSeq,
            stateBytes: Buffer.from(input.stateBytes),
            stateHash,
            createdAt,
          },
        });

      const [prunable] = await tx
        .select({
          count: sql<string>`count(*)::text`,
          bytes: sql<string>`coalesce(sum(octet_length(${collaborationUpdates.updateBytes})), 0)::text`,
        })
        .from(collaborationUpdates)
        .where(
          and(
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generationId, input.generationId),
            lte(collaborationUpdates.durableSeq, input.durableSeq),
            isNotNull(collaborationUpdates.updateBytes),
          ),
        );
      await tx
        .update(collaborationUpdates)
        .set({ updateBytes: null })
        .where(
          and(
            eq(collaborationUpdates.documentId, input.documentId),
            eq(collaborationUpdates.generationId, input.generationId),
            lte(collaborationUpdates.durableSeq, input.durableSeq),
            isNotNull(collaborationUpdates.updateBytes),
          ),
        );
      return {
        status: "compacted",
        prunedUpdates: Number(prunable?.count ?? 0),
        prunedBytes: Number(prunable?.bytes ?? 0),
        versionSnapshots: input.versionCheckpoints.length,
      };
    });
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${tenantId}`}, 718268))`,
      );
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
        .select({ id: workspaces.id })
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
          workspaceId: location.workspaceId,
          catalogId,
          position: lastPosition?.value ?? 0,
        })
        .returning();
      if (!document) throw new Error("Document insert returned no row");

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

      const [template] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          createdBy: documents.createdBy,
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
      const copyCatalogId = await ensureRootCatalog(tx, input.tenantId, "ws_default");
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
    if (input.workspaceId) filters.push(eq(documents.workspaceId, input.workspaceId));
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
    const statusLabels = sql.join(
      DOCUMENT_STATUSES.map((status) => sql`when ${status} then ${DOCUMENT_STATUS_LABELS[status]}`),
      sql` `,
    );
    // Same text aggregation as knowledge search, trimmed to a card-sized excerpt.
    const excerpt = sql<string>`left(coalesce((select string_agg(
      case value->>'type'
        when 'text' then value->>'text'
        when 'horizontalRule' then value#>>'{attrs,label}'
        when 'statusTag' then case value#>>'{attrs,status}' ${statusLabels} end
      end, ' ')
      from jsonb_path_query(${documentProjectionSnapshots.content},
        'strict $.** ? (@.type() == "object" && (@.type == "text" || @.type == "horizontalRule" || @.type == "statusTag"))') as value), ''), 160)`;
    const rows = await this.db
      .select({
        id: documents.id,
        tenantId: documents.tenantId,
        title: documents.title,
        workspaceId: documents.workspaceId,
        workspaceName: workspaces.name,
        catalogId: documents.catalogId,
        position: documents.position,
        icon: documents.icon,
        tags: documents.tags,
        createdBy: documents.createdBy,
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
    requestId?: string;
    idempotency?: DocumentIdempotency;
  }): Promise<
    | { status: "not-found" }
    | { status: "conflict" }
    | { status: "updated" | "replayed"; document: ActiveDocument }
  > {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({
          id: documents.id,
          tenantId: documents.tenantId,
          createdBy: documents.createdBy,
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${input.tenantId}`}, 718268))`,
      );
      if (input.idempotency) {
        const replay = await loadLifecycleIdempotencyReplay(tx, {
          tenantId: input.tenantId,
          subjectId: input.ownerId,
          idempotency: input.idempotency,
        });
        if (replay) return { status: "replayed", generationId: replay };
      }
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
      const [document] = await tx
        .select({
          id: documents.id,
          createdBy: documents.createdBy,
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
      if (document.createdBy !== input.identityId) {
        const grants = await tx
          .select({ action: documentAcl.action })
          .from(documentAcl)
          .where(
            and(
              eq(documentAcl.tenantId, input.tenantId),
              eq(documentAcl.documentId, input.documentId),
              eq(documentAcl.identityId, input.identityId),
            ),
          );
        if (!hasDocumentAction(new Set(grants.map((grant) => grant.action)), "export")) {
          return "not-authorized";
        }
      }
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
    actions: readonly DocumentPermissionAction[],
    requestId?: string,
    idempotency?: DocumentIdempotency,
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

      if (idempotency) {
        const replay = await loadAclIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
        });
        if (replay) return { status: "replayed", ...replay };
      }

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
        .select({ createdBy: documents.createdBy })
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.tenantId, tenantId),
            eq(documents.status, "active"),
          ),
        )
        .limit(1);
      if (!document || document.createdBy !== ownerId) return null;

      const rows = await tx
        .select({ identityId: documentAcl.identityId, action: documentAcl.action })
        .from(documentAcl)
        .where(and(eq(documentAcl.tenantId, tenantId), eq(documentAcl.documentId, documentId)))
        .orderBy(asc(documentAcl.identityId), asc(documentAcl.action));
      const grouped = new Map<string, DocumentPermissionAction[]>();
      for (const row of rows) {
        if (!isDocumentPermissionAction(row.action)) {
          throw new Error("Unsupported document ACL action");
        }
        const actions = grouped.get(row.identityId) ?? [];
        actions.push(row.action);
        grouped.set(row.identityId, actions);
      }
      return [...grouped.entries()].map(([identityId, actions]) => ({
        documentId,
        identityId,
        actions,
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

      if (idempotency) {
        const replay = await loadAclIdempotencyReplay(tx, {
          tenantId,
          subjectId: ownerId,
          idempotency,
        });
        if (replay) return { status: "replayed", ...replay };
      }

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
    if (rows.some((row) => row.updateBytes === null)) {
      throw new Error("Compacted Yjs history must be replayed with replayYjsState");
    }
    return rows.map((row) => ({
      updateHash: row.updateHash,
      durableSeq: row.durableSeq,
      updateBytes: new Uint8Array(row.updateBytes as Buffer),
    }));
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

  private async findActiveRow(
    documentId: string,
    tenantId: string,
  ): Promise<ActiveDocument | null> {
    const [row] = await this.db
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
