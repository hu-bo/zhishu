import "../environment.js";
import assert from "node:assert/strict";
import { and, asc, eq } from "drizzle-orm";
import * as Y from "yjs";
import { createDatabase, createPool } from "../../database/index.js";
import { documentGenerations, documents } from "../../database/schema/index.js";
import { projectDocumentContent } from "../modules/collaboration/hocuspocus.server.js";
import { DocumentRepository } from "../modules/documents/document.repository.js";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Projection backfill only accepts the project-local 127.0.0.1:5432/app database",
);

const pool = createPool({ connectionString: databaseUrl, max: 2 });
const db = createDatabase(pool);
const repository = new DocumentRepository(db);
let projected = 0;
let alreadyCurrent = 0;

try {
  const activeGenerations = await db
    .select({
      tenantId: documents.tenantId,
      documentId: documents.id,
      generationId: documentGenerations.id,
      durableSeq: documentGenerations.durableSeq,
    })
    .from(documents)
    .innerJoin(
      documentGenerations,
      and(
        eq(documentGenerations.documentId, documents.id),
        eq(documentGenerations.status, "active"),
      ),
    )
    .orderBy(asc(documents.id));

  for (const row of activeGenerations) {
    const ydoc = new Y.Doc();
    try {
      await repository.replayYjsState(
        {
          documentId: row.documentId,
          generationId: row.generationId,
          targetSeq: row.durableSeq,
        },
        (updateBytes) => Y.applyUpdate(ydoc, updateBytes, "projection-backfill"),
      );
      const content = projectDocumentContent(ydoc);
      const changed = await repository.backfillProjectionSnapshot({
        tenantId: row.tenantId,
        documentId: row.documentId,
        generationId: row.generationId,
        durableSeq: row.durableSeq,
        content,
      });
      if (changed) projected += 1;
      else alreadyCurrent += 1;
    } finally {
      ydoc.destroy();
    }
  }

  console.log(JSON.stringify({ generations: activeGenerations.length, projected, alreadyCurrent }));
} finally {
  await pool.end();
}
