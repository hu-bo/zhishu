import "../environment.js";
import type { PoolClient } from "pg";
import { createDatabase, createPool } from "../../database/index.js";
import { loadConfig } from "../config.js";
import { collaborationOwnerLock } from "../modules/collaboration/owner-lock.js";
import { createDocumentService, DocumentRepository } from "../modules/documents/index.js";
import type { Principal } from "../modules/identity/identity.types.js";

function parseArguments(arguments_: string[]) {
  let documentId: string | undefined;
  let apply = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--document") {
      documentId = arguments_[index + 1];
      if (!documentId) throw new Error("--document requires a document ID.");
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (documentId !== undefined && !/^doc_[A-Za-z0-9_-]{1,80}$/.test(documentId)) {
    throw new Error("--document must be a document ID.");
  }
  if (apply && !documentId) {
    throw new Error("--apply requires one explicit --document ID; bulk apply is disabled.");
  }
  return { documentId, apply };
}

async function main(): Promise<void> {
  const { documentId, apply } = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    query_timeout: config.DATABASE_QUERY_TIMEOUT_MS,
  });
  const db = createDatabase(pool);
  const repository = new DocumentRepository(db);
  const service = createDocumentService(db, config, {
    revokeDocumentSessions: () => undefined,
  });
  let ownerLockClient: PoolClient | undefined;

  try {
    if (apply) {
      ownerLockClient = await pool.connect();
      const result = await ownerLockClient.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [collaborationOwnerLock.namespace, collaborationOwnerLock.resource],
      );
      if (!result.rows[0]?.locked) {
        throw new Error("Stop the collaboration server before applying a repair.");
      }
    }

    const targets = await repository.listActiveForIntegrityScan();
    const selected = documentId ? targets.filter((item) => item.id === documentId) : targets;
    if (documentId && selected.length === 0) throw new Error("The active document was not found.");

    let repairableCount = 0;
    let blockedCount = 0;
    let appliedCount = 0;
    for (const target of selected) {
      const principal: Principal = {
        identityId: target.createdBy,
        tenantId: target.tenantId,
        username: target.createdBy,
        displayName: "Integrity repair",
        email: "",
        globalRoles: [],
        active: true,
      };
      const inspection = await service.repairDuplicateBlockIds(principal, target.id, false);
      if (inspection.status === "clean") {
        if (documentId) console.log(`${target.id}: clean`);
        continue;
      }
      if (inspection.status === "conflict") {
        console.log(`${target.id}: blocked`);
        blockedCount += 1;
        continue;
      }

      repairableCount += 1;
      if (!apply) {
        console.log(`${target.id}: repairable, duplicate IDs=${inspection.duplicateCount}`);
        continue;
      }
      const result = await service.repairDuplicateBlockIds(principal, target.id, true);
      if (result.status !== "repaired") {
        console.log(`${target.id}: conflict during repair`);
        blockedCount += 1;
        continue;
      }
      appliedCount += 1;
      console.log(
        `${target.id}: repaired ${result.duplicateCount} duplicate IDs; generation ${result.previousGenerationId} -> ${result.generationId}`,
      );
    }

    console.log(
      JSON.stringify({
        scanned: selected.length,
        repairable: repairableCount,
        blocked: blockedCount,
        applied: appliedCount,
      }),
    );
    if (blockedCount > 0) process.exitCode = 2;
  } finally {
    if (ownerLockClient) {
      await ownerLockClient
        .query("SELECT pg_advisory_unlock($1, $2)", [
          collaborationOwnerLock.namespace,
          collaborationOwnerLock.resource,
        ])
        .catch(() => undefined);
      ownerLockClient.release();
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Duplicate Block ID repair failed.");
  process.exitCode = 1;
});
