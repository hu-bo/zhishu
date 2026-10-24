import "../environment.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createDatabase, createPool, sql } from "../../database/index.js";
import type { Database } from "../../database/index.js";
import {
  assetReferences,
  collaborationUpdates,
  documentAuditEvents,
  documentGenerations,
  documentProjectionSnapshots,
} from "../../database/schema/index.js";
import {
  hashDocumentContent,
  summarizeDocumentContent,
} from "../modules/documents/document.repository.js";
import {
  collectAssetReferences,
  createCollaborationStateFromContent,
} from "../modules/documents/document.service.js";
import type { DocumentContent } from "@zhishu/document-contracts";

// One-time standard → collaborative migration. MUST run before db:migrate drops
// the standard tables and the documents.mode column. Replicates the deleted
// DocumentRepository.enableCollaborationFromStandardSnapshot behavior against the
// pre-drop schema, using literal table names so it works regardless of the Drizzle
// schema. Idempotent: documents already marked collaborative are skipped.

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname),
  "The migration only accepts a project-local loopback database (never a shared/production server)",
);

const pool = createPool({ connectionString: databaseUrl, max: 2 });
const db = createDatabase(pool);

type StandardDocumentRow = {
  tenantId: string;
  documentId: string;
  createdBy: string;
  generationId: string;
  schemaVersion: number;
  extensions: Array<{ name: string; version: string; required: boolean }>;
  content: DocumentContent;
};

async function listStandardDocuments(): Promise<StandardDocumentRow[]> {
  const rows = await pool.query<Omit<StandardDocumentRow, "extensions"> & { extensions: unknown }>(
    `select
       d.tenant_id as "tenantId",
       d.id as "documentId",
       d.created_by as "createdBy",
       g.id as "generationId",
       g.schema_version as "schemaVersion",
       g.extensions as "extensions",
       s.content as "content"
     from documents d
     join document_generations g
       on g.document_id = d.id and g.status = 'active' and g.durable_seq = 0
     join document_json_snapshots s
       on s.tenant_id = d.tenant_id and s.document_id = d.id
     where d.mode = 'standard'`,
  );
  return rows.rows.map((row) => ({
    tenantId: row.tenantId,
    documentId: row.documentId,
    createdBy: row.createdBy,
    generationId: row.generationId,
    schemaVersion: Number(row.schemaVersion),
    extensions: row.extensions as StandardDocumentRow["extensions"],
    content: row.content as DocumentContent,
  }));
}

async function listStandardSourceVersionIds(
  executor: Pick<Database, "execute">,
  tenantId: string,
  documentId: string,
): Promise<string[]> {
  const result = await executor.execute(sql`
    select v.id from document_versions v
    where v.tenant_id = ${tenantId}
      and v.document_id = ${documentId}
      and exists (select 1 from document_json_version_snapshots j where j.version_id = v.id)
  `);
  return result.rows
    .map((row) => Object.values(row as Record<string, unknown>)[0])
    .filter((id): id is string => typeof id === "string")
    .map(String);
}

try {
  const standardDocuments = await listStandardDocuments();
  let converted = 0;
  let failed = 0;
  let versionsDropped = 0;

  for (const row of standardDocuments) {
    try {
      await db.transaction(async (tx) => {
        const updateBytes = createCollaborationStateFromContent(row.content);
        const updateHash = createHash("sha256").update(updateBytes).digest("hex");
        const nextGenerationId = `gen_${randomUUID()}`;

        // Retire the pre-collaboration generation (always durable_seq 0 for
        // standard documents) and promote a collaborative one in its place.
        await tx
          .update(documentGenerations)
          .set({ status: "retired" })
          .where(
            sql`${documentGenerations.documentId} = ${row.documentId} and ${documentGenerations.id} = ${row.generationId}`,
          );
        await tx.insert(documentGenerations).values({
          id: nextGenerationId,
          documentId: row.documentId,
          schemaVersion: row.schemaVersion,
          extensions: row.extensions,
          status: "active",
          durableSeq: 1,
        });
        await tx.insert(collaborationUpdates).values({
          documentId: row.documentId,
          generationId: nextGenerationId,
          updateHash,
          sourceUpdateHash: updateHash,
          updateBytes: Buffer.from(updateBytes),
          durableSeq: 1,
          createdBy: row.createdBy,
        });
        // Snapshot the converted content synchronously so the document is
        // readable immediately, mirroring backfillProjectionSnapshot.
        const summary = summarizeDocumentContent(row.content);
        await tx
          .insert(documentProjectionSnapshots)
          .values({
            tenantId: row.tenantId,
            documentId: row.documentId,
            generationId: nextGenerationId,
            durableSeq: 1,
            snapshotRevision: 1,
            content: row.content,
            contentHash: hashDocumentContent(row.content),
            ...summary,
          })
          .onConflictDoUpdate({
            target: [
              documentProjectionSnapshots.tenantId,
              documentProjectionSnapshots.documentId,
              documentProjectionSnapshots.generationId,
            ],
            set: {
              durableSeq: 1,
              snapshotRevision: sql`${documentProjectionSnapshots.snapshotRevision} + 1`,
              content: row.content,
              contentHash: hashDocumentContent(row.content),
              ...summary,
            },
            setWhere: sql`${documentProjectionSnapshots.durableSeq} < 1`,
          });
        const references = collectAssetReferences(row.content);
        for (const reference of references) {
          await tx
            .insert(assetReferences)
            .values({
              tenantId: row.tenantId,
              documentId: row.documentId,
              generationId: nextGenerationId,
              durableSeq: 1,
              assetId: reference.assetId,
              blockId: reference.blockId,
            })
            .onConflictDoNothing();
        }
        // Standard-era versions cannot be replayed once their snapshot tables
        // are dropped; remove them (the json version tables cascade via FK).
        const versionIds = await listStandardSourceVersionIds(tx, row.tenantId, row.documentId);
        if (versionIds.length > 0) {
          const versionParams = sql.join(
            versionIds.map((id: string) => sql`${id}`),
            sql`, `,
          );
          await tx.execute(
            sql`delete from document_json_version_asset_references where version_id in (${versionParams})`,
          );
          await tx.execute(
            sql`delete from document_json_version_snapshots where version_id in (${versionParams})`,
          );
          await tx.execute(sql`delete from document_versions where id in (${versionParams})`);
          versionsDropped += versionIds.length;
        }
        // The standard content tables are consumed; their definitions are
        // dropped by the subsequent db:migrate.
        await tx.execute(
          sql`delete from document_json_asset_references where tenant_id = ${row.tenantId} and document_id = ${row.documentId}`,
        );
        await tx.execute(
          sql`delete from document_json_snapshots where tenant_id = ${row.tenantId} and document_id = ${row.documentId}`,
        );
        await tx.execute(
          sql`update documents set mode = 'collaborative' where tenant_id = ${row.tenantId} and id = ${row.documentId}`,
        );
        await tx.insert(documentAuditEvents).values({
          tenantId: row.tenantId,
          actorIdentityId: row.createdBy,
          action: "document.collaboration-enabled",
          resourceId: row.documentId,
          generationId: nextGenerationId,
          details: { previousGenerationId: row.generationId, durableSeq: 1, migration: true },
        });
      });
      converted += 1;
    } catch (error) {
      failed += 1;
      console.error(
        JSON.stringify({
          documentId: row.documentId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  console.log(
    JSON.stringify({
      standardFound: standardDocuments.length,
      converted,
      failed,
      versionsDropped,
    }),
  );
  if (failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
