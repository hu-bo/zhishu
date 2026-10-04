import { sql } from "drizzle-orm";
import type { DocumentTag } from "../../src/modules/documents/document.schema.js";
import type { ContentMigrationStepSnapshot, DocumentContent } from "@zhishu/document-contracts";
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const workspaces = pgTable(
  "workspaces",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    description: text("description").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);

// Directory tree of a workspace. Every workspace owns exactly one root node (parentId = null,
// id = `cat_root_${workspaceId}`); documents always mount to a catalog node, never to another
// document. Catalogs are workspace furniture visible to the whole tenant; document ACLs remain
// the security boundary.
export const catalogs = pgTable(
  "catalogs",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    icon: text("icon"),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "catalogs_workspace_fk",
    }),
    foreignKey({
      columns: [table.tenantId, table.parentId],
      foreignColumns: [table.tenantId, table.id],
      name: "catalogs_parent_fk",
    }),
    check("catalogs_position_check", sql`${table.position} >= 0`),
    check(
      "catalogs_parent_self_check",
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    // Exactly one root catalog per workspace.
    uniqueIndex("catalogs_workspace_root_uq")
      .on(table.tenantId, table.workspaceId)
      .where(sql`${table.parentId} is null`),
    index("catalogs_workspace_parent_idx").on(
      table.tenantId,
      table.workspaceId,
      table.parentId,
      table.position,
      table.id,
    ),
  ],
);

// Retain installation markers after deletion so initialization never resurrects samples.
export const knowledgePresetInstallations = pgTable(
  "knowledge_preset_installations",
  {
    tenantId: text("tenant_id").notNull(),
    identityId: text("identity_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    presetId: text("preset_id").notNull(),
    documentId: text("document_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.identityId, table.workspaceId, table.presetId] }),
    index("knowledge_preset_installations_document_idx").on(table.tenantId, table.documentId),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().default("local"),
    title: text("title").notNull(),
    workspaceId: text("workspace_id").notNull().default("ws_default"),
    catalogId: text("catalog_id").notNull(),
    position: integer("position").notNull().default(0),
    icon: text("icon"),
    tags: jsonb("tags").$type<DocumentTag[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    mode: text("mode").notNull().default("collaborative"),
    status: text("status").notNull().default("active"),
    metadataRevision: integer("metadata_revision").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
      name: "documents_workspace_fk",
    }),
    foreignKey({
      columns: [table.tenantId, table.catalogId],
      foreignColumns: [catalogs.tenantId, catalogs.id],
      name: "documents_catalog_fk",
    }),
    check("documents_position_check", sql`${table.position} >= 0`),
    index("documents_catalog_idx").on(
      table.tenantId,
      table.workspaceId,
      table.catalogId,
      table.position,
      table.id,
    ),
    check("documents_status_check", sql`${table.status} in ('active', 'archived', 'trashed')`),
    check("documents_mode_check", sql`${table.mode} in ('standard', 'collaborative')`),
    check("documents_metadata_revision_check", sql`${table.metadataRevision} > 0`),
    uniqueIndex("documents_tenant_id_id_uq").on(table.tenantId, table.id),
    index("documents_tenant_created_idx").on(table.tenantId, table.createdAt, table.id),
  ],
);

export const documentJsonSnapshots = pgTable(
  "document_json_snapshots",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    snapshotRevision: integer("snapshot_revision").notNull().default(1),
    content: jsonb("content").$type<DocumentContent>().notNull(),
    contentHash: text("content_hash").notNull(),
    blockCount: integer("block_count").notNull(),
    textLength: integer("text_length").notNull(),
    assetCount: integer("asset_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.documentId] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_json_snapshots_tenant_document_fk",
    }).onDelete("cascade"),
    check("document_json_snapshots_revision_check", sql`${table.snapshotRevision} > 0`),
    check(
      "document_json_snapshots_summary_check",
      sql`${table.blockCount} >= 0 and ${table.textLength} >= 0 and ${table.assetCount} >= 0`,
    ),
  ],
);

export const documentAuditEvents = pgTable(
  "document_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    actorIdentityId: text("actor_identity_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull().default("document"),
    resourceId: text("resource_id").notNull(),
    generationId: text("generation_id"),
    requestId: text("request_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "document_audit_events_action_check",
      sql`${table.action} in ('document.created', 'document.imported', 'document.exported', 'document.content-updated', 'document.collaboration-enabled', 'document.copied', 'document.title-updated', 'document.archived', 'document.trashed', 'document.restored', 'document.permanently-deleted', 'document.version-created', 'document.version-restored', 'document.acl-updated', 'document.acl-removed', 'document.schema-migrated', 'document.block-ids-repaired', 'document.share-created', 'document.share-revoked')`,
    ),
    check("document_audit_events_resource_type_check", sql`${table.resourceType} = 'document'`),
    index("document_audit_events_tenant_created_idx").on(table.tenantId, table.createdAt, table.id),
    index("document_audit_events_request_idx").on(
      table.tenantId,
      table.requestId,
      table.createdAt,
      table.id,
    ),
    index("document_audit_events_resource_created_idx").on(
      table.tenantId,
      table.resourceId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const documentMigrationSnapshots = pgTable(
  "document_migration_snapshots",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    migrationId: uuid("migration_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    stepId: text("step_id").notNull(),
    summary: text("summary").notNull(),
    fromSchemaVersion: integer("from_schema_version").notNull(),
    toSchemaVersion: integer("to_schema_version").notNull(),
    content: jsonb("content").$type<ContentMigrationStepSnapshot["content"]>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.documentId, table.migrationId, table.stepIndex],
    }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_migration_snapshots_tenant_document_fk",
    }).onDelete("cascade"),
    check("document_migration_snapshots_step_index_check", sql`${table.stepIndex} >= 0`),
    check(
      "document_migration_snapshots_version_range_check",
      sql`${table.fromSchemaVersion} > 0 and ${table.toSchemaVersion} > ${table.fromSchemaVersion}`,
    ),
    index("document_migration_snapshots_document_created_idx").on(
      table.tenantId,
      table.documentId,
      table.createdAt,
    ),
  ],
);

export const apiIdempotencyRecords = pgTable(
  "api_idempotency_records",
  {
    tenantId: text("tenant_id").notNull(),
    subjectId: text("subject_id").notNull(),
    operationId: text("operation_id").notNull(),
    keyHash: text("key_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .default(sql`now() + interval '24 hours'`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.subjectId, table.operationId, table.keyHash],
      name: "api_idempotency_records_pk",
    }),
    check("api_idempotency_records_hash_check", sql`${table.keyHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "api_idempotency_records_request_hash_check",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("api_idempotency_records_status_check", sql`${table.responseStatus} between 200 and 299`),
    check("api_idempotency_records_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    index("api_idempotency_records_expiry_idx").on(table.expiresAt),
  ],
);

export const documentFavorites = pgTable(
  "document_favorites",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    identityId: text("identity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.documentId, table.identityId] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_favorites_tenant_document_fk",
    }).onDelete("cascade"),
    index("document_favorites_identity_created_idx").on(
      table.tenantId,
      table.identityId,
      table.createdAt,
    ),
  ],
);

export const documentRecents = pgTable(
  "document_recents",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    identityId: text("identity_id").notNull(),
    lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.documentId, table.identityId] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_recents_tenant_document_fk",
    }).onDelete("cascade"),
    index("document_recents_identity_opened_idx").on(
      table.tenantId,
      table.identityId,
      table.lastOpenedAt,
    ),
  ],
);

export const documentAcl = pgTable(
  "document_acl",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    identityId: text("identity_id").notNull(),
    action: text("action").notNull(),
    grantedBy: text("granted_by").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_acl_tenant_document_fk",
    }).onDelete("cascade"),
    check(
      "document_acl_action_check",
      sql`${table.action} in ('read', 'write', 'comment', 'share', 'export', 'ai')`,
    ),
    uniqueIndex("document_acl_subject_action_uq").on(
      table.tenantId,
      table.documentId,
      table.identityId,
      table.action,
    ),
    index("document_acl_subject_document_idx").on(
      table.tenantId,
      table.identityId,
      table.documentId,
    ),
  ],
);

// Public capability links for a single document. Each share record mints its own `shr_*` id used
// in the public URL; permission tier and expiry are per-record. Anonymous visitors always get
// read-only content; logged-in visitors can join (ACL grant per tier) via the share id.
export const documentShares = pgTable(
  "document_shares",
  {
    tenantId: text("tenant_id").notNull(),
    id: text("id").notNull(),
    documentId: text("document_id").notNull(),
    permission: text("permission").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    joinCount: integer("join_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_shares_document_fk",
    }).onDelete("cascade"),
    check("document_shares_permission_check", sql`${table.permission} in ('read', 'edit')`),
    check("document_shares_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    check("document_shares_join_count_check", sql`${table.joinCount} >= 0`),
    index("document_shares_document_created_idx").on(
      table.tenantId,
      table.documentId,
      table.createdAt,
    ),
  ],
);

export const documentGenerations = pgTable(
  "document_generations",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(5),
    extensions: jsonb("extensions")
      .$type<Array<{ name: string; version: string; required: boolean }>>()
      .notNull()
      .default([]),
    status: text("status").notNull().default("active"),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("document_generations_document_id_id_uq").on(table.documentId, table.id),
    uniqueIndex("document_generations_one_active_per_document_uq")
      .on(table.documentId)
      .where(sql`${table.status} = 'active'`),
    index("document_generations_document_created_idx").on(table.documentId, table.createdAt),
  ],
);

export const documentGenerationCheckpoints = pgTable(
  "document_generation_checkpoints",
  {
    documentId: text("document_id").notNull(),
    generationId: text("generation_id").notNull(),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull(),
    stateBytes: bytea("state_bytes").notNull(),
    stateHash: text("state_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.generationId] }),
    foreignKey({
      columns: [table.documentId, table.generationId],
      foreignColumns: [documentGenerations.documentId, documentGenerations.id],
      name: "document_generation_checkpoints_generation_fk",
    }).onDelete("cascade"),
    check("document_generation_checkpoints_durable_seq_check", sql`${table.durableSeq} >= 0`),
    index("document_generation_checkpoints_document_idx").on(table.documentId, table.durableSeq),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    generationId: text("generation_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("named"),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_versions_tenant_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId, table.generationId],
      foreignColumns: [documentGenerations.documentId, documentGenerations.id],
      name: "document_versions_generation_fk",
    }).onDelete("cascade"),
    check("document_versions_durable_seq_check", sql`${table.durableSeq} >= 0`),
    check("document_versions_kind_check", sql`${table.kind} in ('named', 'automatic')`),
    uniqueIndex("document_versions_document_name_uq").on(table.documentId, table.name),
    index("document_versions_document_created_idx").on(
      table.tenantId,
      table.documentId,
      table.createdAt,
    ),
    index("document_versions_generation_kind_created_idx").on(
      table.tenantId,
      table.documentId,
      table.generationId,
      table.kind,
      table.createdAt,
    ),
  ],
);

export const documentVersionCheckpoints = pgTable("document_version_checkpoints", {
  versionId: text("version_id")
    .primaryKey()
    .references(() => documentVersions.id, { onDelete: "cascade" }),
  stateBytes: bytea("state_bytes").notNull(),
  stateHash: text("state_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const collaborationUpdates = pgTable(
  "collaboration_updates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: text("document_id").notNull(),
    generationId: text("generation_id").notNull(),
    updateHash: text("update_hash").notNull(),
    sourceUpdateHash: text("source_update_hash"),
    updateBytes: bytea("update_bytes"),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.documentId, table.generationId],
      foreignColumns: [documentGenerations.documentId, documentGenerations.id],
      name: "collaboration_updates_generation_fk",
    }).onDelete("cascade"),
    uniqueIndex("collaboration_updates_generation_hash_uq").on(
      table.generationId,
      table.updateHash,
    ),
    uniqueIndex("collaboration_updates_generation_source_hash_uq").on(
      table.generationId,
      table.sourceUpdateHash,
    ),
    uniqueIndex("collaboration_updates_generation_seq_uq").on(table.generationId, table.durableSeq),
    index("collaboration_updates_document_generation_seq_idx").on(
      table.documentId,
      table.generationId,
      table.durableSeq,
    ),
  ],
);

export const documentProjectionSnapshots = pgTable(
  "document_projection_snapshots",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    generationId: text("generation_id").notNull(),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull(),
    snapshotRevision: integer("snapshot_revision").notNull(),
    content: jsonb("content").$type<DocumentContent>().notNull(),
    contentHash: text("content_hash").notNull(),
    blockCount: integer("block_count").notNull(),
    textLength: integer("text_length").notNull(),
    assetCount: integer("asset_count").notNull(),
    projectedAt: timestamp("projected_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.documentId, table.generationId] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_projection_snapshots_tenant_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId, table.generationId],
      foreignColumns: [documentGenerations.documentId, documentGenerations.id],
      name: "document_projection_snapshots_generation_fk",
    }).onDelete("cascade"),
    check("document_projection_snapshots_seq_check", sql`${table.durableSeq} >= 0`),
    check("document_projection_snapshots_revision_check", sql`${table.snapshotRevision} > 0`),
    check(
      "document_projection_snapshots_summary_check",
      sql`${table.blockCount} >= 0 and ${table.textLength} >= 0 and ${table.assetCount} >= 0`,
    ),
  ],
);

export const documentOutbox = pgTable(
  "document_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    generationId: text("generation_id").notNull(),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull(),
    eventType: text("event_type").notNull().default("document.update"),
    updateHash: text("update_hash").notNull(),
    contentChanged: boolean("content_changed").notNull(),
    summary: jsonb("summary")
      .$type<{ blockCount: number; textLength: number; assetCount: number }>()
      .notNull(),
    snapshotContent: jsonb("snapshot_content").$type<DocumentContent>(),
    contentHash: text("content_hash"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_outbox_tenant_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId, table.generationId],
      foreignColumns: [documentGenerations.documentId, documentGenerations.id],
      name: "document_outbox_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.generationId, table.durableSeq],
      foreignColumns: [collaborationUpdates.generationId, collaborationUpdates.durableSeq],
      name: "document_outbox_update_fk",
    }).onDelete("cascade"),
    check("document_outbox_seq_check", sql`${table.durableSeq} > 0`),
    check("document_outbox_event_type_check", sql`${table.eventType} = 'document.update'`),
    check(
      "document_outbox_status_check",
      sql`${table.status} in ('pending', 'processing', 'done', 'dead')`,
    ),
    check("document_outbox_attempts_check", sql`${table.attempts} >= 0`),
    uniqueIndex("document_outbox_generation_seq_type_uq").on(
      table.generationId,
      table.durableSeq,
      table.eventType,
    ),
    index("document_outbox_ready_idx").on(table.status, table.availableAt, table.createdAt),
  ],
);

// Keep asset rows through document purge so the object sweeper can still find each private object key.
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    objectKey: text("object_key").notNull(),
    fileName: text("file_name").notNull(),
    mediaType: text("media_type").notNull(),
    declaredSize: integer("declared_size").notNull(),
    actualSize: integer("actual_size"),
    sha256: text("sha256"),
    status: text("status").notNull().default("uploading"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check("assets_size_check", sql`${table.declaredSize} > 0 and ${table.actualSize} >= 0`),
    check(
      "assets_status_check",
      sql`${table.status} in ('uploading', 'receiving', 'uploaded', 'ready', 'cancelled', 'failed')`,
    ),
    uniqueIndex("assets_tenant_document_id_uq").on(table.tenantId, table.documentId, table.id),
    uniqueIndex("assets_object_key_uq").on(table.objectKey),
    index("assets_upload_cleanup_idx").on(table.status, table.uploadExpiresAt),
  ],
);

export const documentJsonAssetReferences = pgTable(
  "document_json_asset_references",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    assetId: text("asset_id").notNull(),
    blockId: text("block_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.documentId, table.assetId, table.blockId] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_json_asset_references_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.documentId, table.assetId],
      foreignColumns: [assets.tenantId, assets.documentId, assets.id],
      name: "document_json_asset_references_asset_fk",
    }).onDelete("cascade"),
    index("document_json_asset_references_asset_idx").on(table.tenantId, table.assetId),
  ],
);

export const documentJsonVersionSnapshots = pgTable(
  "document_json_version_snapshots",
  {
    versionId: text("version_id")
      .primaryKey()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    snapshotRevision: integer("snapshot_revision").notNull(),
    content: jsonb("content").$type<DocumentContent>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_json_version_snapshots_tenant_document_fk",
    }).onDelete("cascade"),
    check("document_json_version_snapshots_revision_check", sql`${table.snapshotRevision} > 0`),
    check(
      "document_json_version_snapshots_hash_check",
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    index("document_json_version_snapshots_document_idx").on(table.tenantId, table.documentId),
  ],
);

export const documentJsonVersionAssetReferences = pgTable(
  "document_json_version_asset_references",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => documentVersions.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    assetId: text("asset_id").notNull(),
    blockId: text("block_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.assetId, table.blockId] }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "document_json_version_asset_references_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.documentId, table.assetId],
      foreignColumns: [assets.tenantId, assets.documentId, assets.id],
      name: "document_json_version_asset_references_asset_fk",
    }).onDelete("cascade"),
    index("document_json_version_asset_references_asset_idx").on(table.tenantId, table.assetId),
  ],
);

export const assetReferences = pgTable(
  "asset_references",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    generationId: text("generation_id").notNull(),
    assetId: text("asset_id").notNull(),
    blockId: text("block_id").notNull(),
    durableSeq: bigint("durable_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.documentId,
        table.generationId,
        table.durableSeq,
        table.assetId,
        table.blockId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.documentId],
      foreignColumns: [documents.tenantId, documents.id],
      name: "asset_references_tenant_document_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.documentId, table.generationId],
      foreignColumns: [documentGenerations.documentId, documentGenerations.id],
      name: "asset_references_generation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.generationId, table.durableSeq],
      foreignColumns: [collaborationUpdates.generationId, collaborationUpdates.durableSeq],
      name: "asset_references_update_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.documentId, table.assetId],
      foreignColumns: [assets.tenantId, assets.documentId, assets.id],
      name: "asset_references_asset_fk",
    }).onDelete("cascade"),
    index("asset_references_asset_idx").on(table.tenantId, table.assetId),
    index("asset_references_generation_seq_idx").on(
      table.tenantId,
      table.documentId,
      table.generationId,
      table.durableSeq,
    ),
  ],
);
