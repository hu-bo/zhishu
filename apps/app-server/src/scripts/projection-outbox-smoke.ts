import "../environment.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase, createPool } from "../../database/index.js";
import {
  assets,
  documentOutbox,
  documentProjectionSnapshots,
  documents,
} from "../../database/schema/index.js";
import { DocumentRepository } from "../modules/documents/document.repository.js";
import type { DocumentContent } from "@zhishu/document-contracts";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the disposable project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Projection outbox smoke only accepts the project-local 127.0.0.1:5432/app database",
);

const pool = createPool({ connectionString: databaseUrl, max: 2 });
const db = createDatabase(pool);
const repository = new DocumentRepository(db);
const token = randomUUID();
const tenantId = `projection-smoke-${token}`;
const ownerId = `projection-smoke-${token}`;
const assetId = `asset_${token.replaceAll("-", "")}`;
let documentId: string | undefined;

try {
  const document = await repository.create(tenantId, ownerId, "Projection outbox smoke");
  documentId = document.id;
  const now = new Date();
  await db.insert(assets).values({
    id: assetId,
    tenantId,
    documentId,
    objectKey: `projection-smoke/${token}`,
    fileName: "projection.png",
    mediaType: "image/png",
    declaredSize: 8,
    actualSize: 8,
    sha256: "a".repeat(64),
    status: "ready",
    createdBy: ownerId,
    uploadExpiresAt: new Date(now.getTime() + 60_000),
    uploadedAt: now,
    completedAt: now,
  });

  const firstContent: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_projection_text" },
        content: [{ type: "text", text: "hello" }],
      },
      {
        type: "image",
        attrs: {
          blockId: "block_projection_image",
          assetId,
          mediaType: "image/png",
          alt: "projection test",
        },
      },
    ],
  };
  const firstReceipt = await repository.persistUpdate({
    documentId,
    generationId: document.generationId,
    tenantId,
    subjectId: ownerId,
    updateHash: `projection-${token}-1`,
    updateBytes: new Uint8Array([1]),
    contentChanged: true,
    content: firstContent,
    assetReferences: [{ assetId, blockId: "block_projection_image" }],
  });
  assert.equal(firstReceipt.durableSeq, 1);

  const [pendingOutbox] = await db
    .select()
    .from(documentOutbox)
    .where(
      and(
        eq(documentOutbox.documentId, documentId),
        eq(documentOutbox.generationId, document.generationId),
      ),
    );
  assert.ok(pendingOutbox, "durable update and outbox event commit together");
  assert.equal(pendingOutbox.status, "pending");
  assert.deepEqual(pendingOutbox.summary, { blockCount: 2, textLength: 5, assetCount: 1 });
  assert.deepEqual(pendingOutbox.snapshotContent, firstContent);

  const projectionJob = await repository.claimProjectionJob(new Date(Date.now() + 1_000));
  assert.ok(projectionJob);
  assert.equal(await repository.processProjectionJob(projectionJob), true);
  const [snapshot] = await db
    .select()
    .from(documentProjectionSnapshots)
    .where(
      and(
        eq(documentProjectionSnapshots.documentId, documentId),
        eq(documentProjectionSnapshots.generationId, document.generationId),
      ),
    );
  assert.ok(snapshot);
  assert.equal(snapshot.durableSeq, firstReceipt.durableSeq);
  assert.deepEqual(snapshot.content, firstContent);
  assert.equal(snapshot.blockCount, 2);
  assert.equal(snapshot.textLength, 5);
  assert.equal(snapshot.assetCount, 1);

  const secondContent: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_projection_text" },
        content: [{ type: "text", text: "later" }],
      },
    ],
  };
  await repository.persistUpdate({
    documentId,
    generationId: document.generationId,
    tenantId,
    subjectId: ownerId,
    updateHash: `projection-${token}-2`,
    updateBytes: new Uint8Array([2]),
    contentChanged: true,
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "block_projection_text" },
          content: [{ type: "text", text: "intermediate" }],
        },
      ],
    },
    assetReferences: [],
  });
  await repository.persistUpdate({
    documentId,
    generationId: document.generationId,
    tenantId,
    subjectId: ownerId,
    updateHash: `projection-${token}-3`,
    updateBytes: new Uint8Array([3]),
    contentChanged: true,
    content: secondContent,
    assetReferences: [],
  });
  const supersededRows = await db
    .select({ status: documentOutbox.status, snapshotContent: documentOutbox.snapshotContent })
    .from(documentOutbox)
    .where(and(eq(documentOutbox.documentId, documentId), eq(documentOutbox.durableSeq, 2)));
  assert.equal(supersededRows[0]?.status, "done");
  assert.equal(supersededRows[0]?.snapshotContent, null, "newer updates coalesce stale payloads");
  let failureStatus: "retry" | "dead" | "stale" = "stale";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const future = new Date(Date.now() + attempt * 600_000);
    const job = await repository.claimProjectionJob(future, documentId);
    assert.ok(job, `projection retry ${attempt} should be claimable`);
    failureStatus = await repository.failProjectionJob(job, "projection-smoke-failure", future);
    assert.equal(failureStatus, attempt === 8 ? "dead" : "retry");
  }
  assert.equal(failureStatus, "dead");

  const queue = await repository.getProjectionQueueStatus(documentId);
  assert.equal(queue.pending, 0);
  assert.equal(queue.processing, 0);
  assert.equal(queue.dead, 1);
  const [unchangedSnapshot] = await db
    .select({ durableSeq: documentProjectionSnapshots.durableSeq })
    .from(documentProjectionSnapshots)
    .where(eq(documentProjectionSnapshots.documentId, documentId));
  assert.equal(
    unchangedSnapshot?.durableSeq,
    firstReceipt.durableSeq,
    "a dead newer event must not overwrite the last successful projection",
  );

  const [completedOutbox] = await db
    .select({ status: documentOutbox.status, snapshotContent: documentOutbox.snapshotContent })
    .from(documentOutbox)
    .where(eq(documentOutbox.id, pendingOutbox.id));
  assert.equal(completedOutbox?.status, "done");
  assert.equal(
    completedOutbox?.snapshotContent,
    null,
    "completed rows release staged JSON payloads",
  );
  console.log("Transactional outbox, JSON projection, retries, dead letters, and status passed.");
} finally {
  if (documentId) {
    await db.delete(assets).where(eq(assets.id, assetId));
    await db.delete(documents).where(eq(documents.id, documentId));
  }
  await pool.end();
}
