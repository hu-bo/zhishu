import "../environment.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must point to the project Compose PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Backup restore smoke only accepts the project-local 127.0.0.1:5432/app database",
);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../../../../");
const composeFile = resolve(workspaceRoot, "deploy/compose.yaml");
const composePrefix = ["compose", "-f", composeFile];
const temporaryDatabase = `zhishu_restore_verify_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "zhishu-restore-verify-"));
const safeTemporaryRoot = resolve(tmpdir()) + sep;
assert.ok(resolve(temporaryDirectory).startsWith(safeTemporaryRoot));
const archivePath = join(temporaryDirectory, "project.dump");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const restoredUrl = new URL(databaseUrl);
restoredUrl.pathname = `/${temporaryDatabase}`;
const verifiedTables = [
  "documents",
  "document_json_snapshots",
  "document_generations",
  "document_generation_checkpoints",
  "collaboration_updates",
  "document_projection_snapshots",
  "document_outbox",
  "document_versions",
  "document_version_checkpoints",
  "document_audit_events",
  "assets",
  "document_json_asset_references",
  "asset_references",
] as const;

function waitForProcess(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

function startDocker(args: string[]) {
  const child = spawn("docker", [...composePrefix, ...args], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  return { child, getStderr: () => stderr };
}

async function createBackup(): Promise<void> {
  const { child, getStderr } = startDocker([
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "--format=custom",
    "--username=postgres",
    "--dbname=app",
  ]);
  const processResult = waitForProcess(child);
  await pipeline(child.stdout, createWriteStream(archivePath, { flags: "wx" }));
  const exitCode = await processResult;
  if (exitCode !== 0) throw new Error(`pg_dump failed: ${getStderr()}`);
}

async function restoreBackup(): Promise<void> {
  const { child, getStderr } = startDocker([
    "exec",
    "-T",
    "postgres",
    "pg_restore",
    "--exit-on-error",
    "--no-owner",
    "--username=postgres",
    `--dbname=${temporaryDatabase}`,
  ]);
  child.stdout.resume();
  const processResult = waitForProcess(child);
  await pipeline(createReadStream(archivePath), child.stdin);
  const exitCode = await processResult;
  if (exitCode !== 0) throw new Error(`pg_restore failed: ${getStderr()}`);
}

async function getTableCounts(connectionString: string): Promise<Array<[string, string]>> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const counts: Array<[string, string]> = [];
    for (const table of verifiedTables) {
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from public."${table}"`,
      );
      counts.push([table, result.rows[0]?.count ?? "0"]);
    }
    return counts;
  } finally {
    await client.end();
  }
}

const admin = new Client({ connectionString: adminUrl.toString() });
let temporaryDatabaseCreated = false;
try {
  await admin.connect();
  await admin.query(`create database "${temporaryDatabase}"`);
  temporaryDatabaseCreated = true;
  await createBackup();
  await restoreBackup();
  const [sourceCounts, restoredCounts] = await Promise.all([
    getTableCounts(databaseUrl),
    getTableCounts(restoredUrl.toString()),
  ]);
  assert.deepEqual(restoredCounts, sourceCounts);
  console.log(
    `Backup restore verified: ${verifiedTables.length} tables and ${sourceCounts.reduce((sum, [, count]) => sum + Number(count), 0)} rows matched.`,
  );
} finally {
  if (temporaryDatabaseCreated) {
    await admin.query(`drop database "${temporaryDatabase}" with (force)`);
  }
  await admin.end();
  const resolvedTemporaryDirectory = resolve(temporaryDirectory);
  assert.ok(resolvedTemporaryDirectory.startsWith(safeTemporaryRoot));
  rmSync(resolvedTemporaryDirectory, { recursive: true, force: true });
}
