import "../environment.js";
import assert from "node:assert/strict";
import { projectDocumentContent } from "../modules/collaboration/hocuspocus.server.js";
import {
  readStoredStructureState,
  sameDocumentContent,
} from "../modules/collaboration/structure-operations.js";
import * as Y from "yjs";
import { createDatabase, createPool } from "../../database/index.js";
import { DocumentHistoryRepository } from "../modules/documents/index.js";

assert.ok(
  process.argv.slice(2).includes("--apply"),
  "Yjs compaction prunes update payloads; pass --apply after reviewing the target database.",
);
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Yjs compaction only accepts the project-local 127.0.0.1:5432/app database",
);

const pool = createPool({ connectionString: databaseUrl, max: 3 });
const repository = new DocumentHistoryRepository(createDatabase(pool));
let compacted = 0;
let skipped = 0;
let prunedUpdates = 0;
let prunedBytes = 0;
let versionSnapshots = 0;

function assertConsistentDocumentState(yDoc: Y.Doc, generationId: string): void {
  const content = projectDocumentContent(yDoc);
  const structure = readStoredStructureState(yDoc);
  if (!structure || !sameDocumentContent(structure.content, content)) {
    throw new Error(`Refusing to compact inconsistent body/Block state in ${generationId}.`);
  }
}

try {
  const targets = await repository.listYjsCompactionTargets();
  for (const target of targets) {
    const versions = await repository.listVersionsNeedingCheckpoint(
      target.generationId,
      target.durableSeq,
    );
    const checkpointSeq = target.checkpointSeq ?? 0;
    if (target.durableSeq <= checkpointSeq && versions.length === 0) {
      skipped += 1;
      continue;
    }
    if (versions.some((version) => version.durableSeq < checkpointSeq)) {
      throw new Error(
        `Cannot compact ${target.generationId}: a version before the current checkpoint has no saved snapshot.`,
      );
    }

    const versionsBySeq = new Map<number, typeof versions>();
    for (const version of versions) {
      const sameSeq = versionsBySeq.get(version.durableSeq) ?? [];
      sameSeq.push(version);
      versionsBySeq.set(version.durableSeq, sameSeq);
    }
    const snapshots = new Map<
      string,
      { versionId: string; durableSeq: number; stateBytes: Uint8Array }
    >();
    const yDoc = new Y.Doc();
    try {
      await repository.replayYjsState(
        {
          documentId: target.documentId,
          generationId: target.generationId,
          targetSeq: target.durableSeq,
        },
        (updateBytes) => Y.applyUpdate(yDoc, updateBytes, "document-compaction"),
        (durableSeq) => {
          for (const version of versionsBySeq.get(durableSeq) ?? []) {
            assertConsistentDocumentState(yDoc, target.generationId);
            snapshots.set(version.versionId, {
              versionId: version.versionId,
              durableSeq,
              stateBytes: Y.encodeStateAsUpdate(yDoc),
            });
          }
        },
      );
      assertConsistentDocumentState(yDoc, target.generationId);
      if (snapshots.size !== versions.length) {
        throw new Error(
          `Could not reconstruct every version checkpoint for ${target.generationId}.`,
        );
      }
      const result = await repository.commitYjsCheckpoints({
        documentId: target.documentId,
        generationId: target.generationId,
        durableSeq: target.durableSeq,
        stateBytes: Y.encodeStateAsUpdate(yDoc),
        versionCheckpoints: [...snapshots.values()],
      });
      if (result.status !== "compacted") {
        throw new Error(`Yjs compaction for ${target.generationId} stopped: ${result.status}.`);
      }
      compacted += 1;
      prunedUpdates += result.prunedUpdates;
      prunedBytes += result.prunedBytes;
      versionSnapshots += result.versionSnapshots;
    } finally {
      yDoc.destroy();
    }
  }
  console.log(
    JSON.stringify({
      generations: targets.length,
      compacted,
      skipped,
      prunedUpdates,
      prunedBytes,
      versionSnapshots,
    }),
  );
} finally {
  await pool.end();
}
