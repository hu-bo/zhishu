import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

// No cascading foreign key: deletion retains the responsibility to remove vector data.
export const documentIndexes = pgTable(
  "document_indexes",
  {
    tenantId: text("tenant_id").notNull(),
    documentId: text("document_id").notNull(),
    activeIndexVersion: uuid("active_index_version"),
    generationId: text("generation_id"),
    durableSeq: text("durable_seq"),
    metadataRevision: integer("metadata_revision"),
    configFingerprint: text("config_fingerprint"),
    snapshotId: text("snapshot_id"),
    chunkCount: integer("chunk_count").notNull().default(0),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastErrorCode: text("last_error_code"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.documentId] }),
    index("document_indexes_ready_idx").on(t.availableAt, t.leaseUntil),
  ],
);
