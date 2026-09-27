import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { createEditorSchema } from "@zhishu/editor-core";
import type { CollaborationSessionInfo, OperationBatch } from "@zhishu/editor-collaboration";
import { HocuspocusCollaborationSession } from "@zhishu/editor-collaboration/hocuspocus";
import * as Y from "yjs";

const workspaceRoot = resolve(process.cwd(), "../..");
const serverRoot = resolve(workspaceRoot, "apps/app-server");
const tsxCli = resolve(serverRoot, "node_modules/tsx/dist/cli.mjs");
const apiPort = Number(process.env.CRASH_TEST_API_PORT ?? 3030);
const collaborationPort = Number(process.env.CRASH_TEST_COLLABORATION_PORT ?? 3031);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const expectedText = "提交后、回执前进程崩溃恢复验收";
const expectedContent = {
  type: "doc" as const,
  content: [
    {
      type: "paragraph" as const,
      attrs: { blockId: "block_post_commit_crash" },
      content: [{ type: "text" as const, text: expectedText }],
    },
  ],
};

const configuredDatabaseUrl = process.env.DATABASE_URL;
assert.ok(configuredDatabaseUrl, "DATABASE_URL must target the isolated crash-test database");
const databaseUrl = new URL(configuredDatabaseUrl);
assert.equal(databaseUrl.hostname, "127.0.0.1", "smoke must use a loopback PostgreSQL host");
assert.equal(databaseUrl.port, "55432", "smoke must use the isolated PostgreSQL port 55432");
await access(tsxCli);

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, apiUrl), {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function spawnServer(crashAfterCommit: boolean): {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(process.execPath, [tsxCli, "src/scripts/post-commit-crash-server.ts"], {
    cwd: serverRoot,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: "test",
      AUTH_MODE: "external",
      LOG_LEVEL: "silent",
      PORT: String(apiPort),
      COLLABORATION_PORT: String(collaborationPort),
      COLLABORATION_PUBLIC_URL: `ws://127.0.0.1:${collaborationPort}`,
      COLLABORATION_TEST_CRASH_AFTER_COMMIT: crashAfterCommit ? "true" : "false",
      POST_COMMIT_CRASH_SMOKE_TOKEN: "post-commit-crash-smoke-token",
    },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  return { child, exited };
}

async function waitForServer(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`app-server-exited-before-ready: ${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(new URL("/health/ready", apiUrl), {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // Keep waiting while the process opens its API and collaboration listeners.
    }
    await delay(100);
  }
  throw new Error("app-server-ready-timeout");
}

async function waitForCurrent(session: HocuspocusCollaborationSession): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = session.getStatus();
    if (status.connection === "connected" && status.sync === "current") return;
    if (status.sync === "incompatible" || status.connection === "denied") {
      throw new Error(status.errorCode ?? "collaboration-session-denied");
    }
    await delay(50);
  }
  throw new Error(`collaboration-sync-timeout: ${JSON.stringify(session.getStatus())}`);
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timeout: ${description}`);
}

async function deleteDocument(documentId: string, token: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  await requestJson<void>(`/api/documents/${documentId}`, {
    method: "DELETE",
    headers,
  });
  await requestJson<void>(`/api/documents/${documentId}/permanent`, {
    method: "DELETE",
    headers,
  });
}

async function stopServer(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

const startedServers: ReturnType<typeof spawnServer>[] = [];
const startTrackedServer = (crashAfterCommit: boolean) => {
  const server = spawnServer(crashAfterCommit);
  startedServers.push(server);
  return server;
};
let activeServer = startTrackedServer(true);
let writerDocument: Y.Doc | undefined;
let writerSession: HocuspocusCollaborationSession | undefined;
let verifierDocument: Y.Doc | undefined;
let verifierSession: HocuspocusCollaborationSession | undefined;
let accessToken = "";
let documentId: string | undefined;

try {
  await waitForServer(activeServer.child);
  accessToken = "post-commit-crash-smoke-token";
  const authorization = { authorization: `Bearer ${accessToken}` };
  const bodyDocument = await requestJson<{ id: string; generationId: string }>("/api/documents", {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ title: "Post-commit body crash recovery smoke" }),
  });
  documentId = bodyDocument.id;

  const createBodySession = async () =>
    requestJson<CollaborationSessionInfo>(
      `/api/documents/${bodyDocument.id}/collaboration-session`,
      {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ schemaVersion: 1, extensions: [] }),
      },
    );

  writerDocument = new Y.Doc();
  writerSession = new HocuspocusCollaborationSession({
    document: writerDocument,
    session: await createBodySession(),
    refreshSession: createBodySession,
  });
  await waitForCurrent(writerSession);

  prosemirrorJSONToYXmlFragment(
    createEditorSchema({ collaborative: true }),
    expectedContent,
    writerDocument.getXmlFragment("content"),
  );
  const pendingReceipt = writerSession.waitForPersisted(undefined, 30_000);
  await waitUntil(
    () => (writerSession?.getStatus().pendingUpdateCount ?? 0) > 0,
    "the writer records the unacknowledged update",
  );

  const bodyCrash = await Promise.race([
    activeServer.exited,
    delay(15_000).then(() => {
      throw new Error("body post-commit crash injection did not terminate the server");
    }),
  ]);
  assert.notEqual(
    bodyCrash.code,
    0,
    "the body test server must crash before applying or acknowledging",
  );
  assert.ok(
    writerSession.getStatus().pendingUpdateCount > 0,
    "the client must keep the body update pending through the server crash",
  );

  activeServer = startTrackedServer(false);
  await waitForServer(activeServer.child);
  writerSession.retry();
  await waitForCurrent(writerSession);
  const bodyReceipt = await pendingReceipt;
  assert.equal(bodyReceipt.status, "persisted");
  assert.ok(bodyReceipt.durableSeq > 0, "replay must return a committed sequence");

  verifierDocument = new Y.Doc();
  verifierSession = new HocuspocusCollaborationSession({
    document: verifierDocument,
    session: await createBodySession(),
  });
  await waitForCurrent(verifierSession);
  assert.deepEqual(yDocToProsemirrorJSON(verifierDocument, "content"), expectedContent);

  const bodyRecovered = await requestJson<{ durableSeq: number }>(
    `/api/documents/${bodyDocument.id}`,
    { headers: authorization },
  );
  assert.equal(
    bodyRecovered.durableSeq,
    bodyReceipt.durableSeq,
    "replaying the pending update must not allocate another durable sequence",
  );

  writerSession.destroy();
  writerDocument.destroy();
  verifierSession.destroy();
  verifierDocument.destroy();
  writerSession = undefined;
  writerDocument = undefined;
  verifierSession = undefined;
  verifierDocument = undefined;

  await deleteDocument(bodyDocument.id, accessToken);
  documentId = undefined;

  const structureDocument = await requestJson<{ id: string; generationId: string }>(
    "/api/documents",
    {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ title: "Post-commit structure crash recovery smoke" }),
    },
  );
  documentId = structureDocument.id;
  const structureText = "结构命令提交后的恢复验收";
  const createStructureSession = async () =>
    requestJson<CollaborationSessionInfo>(
      `/api/documents/${structureDocument.id}/collaboration-session`,
      {
        method: "POST",
        headers: authorization,
        body: JSON.stringify({ schemaVersion: 1, extensions: [] }),
      },
    );

  writerDocument = new Y.Doc();
  writerSession = new HocuspocusCollaborationSession({
    document: writerDocument,
    session: await createStructureSession(),
    refreshSession: createStructureSession,
  });
  await waitForCurrent(writerSession);
  const initialStructureBatch: OperationBatch = {
    operationId: "op_crash_structure_initial",
    documentId: structureDocument.id,
    generationId: structureDocument.generationId,
    origin: "user",
    operations: [
      {
        type: "insert-block",
        parentBlockId: null,
        block: {
          type: "paragraph",
          attrs: { blockId: "block_crash_structure" },
          content: [{ type: "text", text: structureText }],
        },
      },
    ],
  };
  const initialStructureResult = await writerSession.submitStructureOperation(
    initialStructureBatch,
    0,
  );
  assert.equal(initialStructureResult.status, "accepted");
  const baseRevision = writerSession.getStructureRevision();
  assert.equal(baseRevision, 1, "the initial structure operation must seed revision one");

  await stopServer(activeServer.child, activeServer.exited);
  activeServer = startTrackedServer(true);
  await waitForServer(activeServer.child);
  writerSession.retry();
  await waitForCurrent(writerSession);
  assert.equal(writerSession.getStructureRevision(), baseRevision);

  const structureBatch: OperationBatch = {
    operationId: "op_crash_structure_once",
    documentId: structureDocument.id,
    generationId: structureDocument.generationId,
    origin: "user",
    operations: [
      {
        type: "replace-block",
        targetBlockId: "block_crash_structure",
        block: {
          type: "heading",
          attrs: { blockId: "block_crash_structure", level: 2 },
          content: [{ type: "text", text: structureText }],
        },
      },
    ],
  };
  const firstStructureResult = writerSession
    .submitStructureOperation(structureBatch, baseRevision, 1_000)
    .then(
      (result) => result,
      (error: unknown) => error,
    );
  const structureCrash = await Promise.race([
    activeServer.exited,
    delay(15_000).then(() => {
      throw new Error("structure post-commit crash injection did not terminate the server");
    }),
  ]);
  assert.notEqual(
    structureCrash.code,
    0,
    "the structure test server must crash before applying or acknowledging",
  );
  const firstStructureOutcome = await firstStructureResult;
  assert.ok(firstStructureOutcome instanceof Error);
  assert.equal(firstStructureOutcome.message, "structure-operation-timeout");

  activeServer = startTrackedServer(false);
  await waitForServer(activeServer.child);
  writerSession.retry();
  await waitForCurrent(writerSession);
  const duplicateResult = await writerSession.submitStructureOperation(
    structureBatch,
    baseRevision,
  );
  assert.equal(duplicateResult.status, "duplicate");
  assert.equal(writerSession.getStructureRevision(), baseRevision + 1);

  const recoveredStructureBody = yDocToProsemirrorJSON(writerDocument, "content");
  assert.equal(recoveredStructureBody.content[0]?.type, "heading");
  assert.equal(recoveredStructureBody.content[0]?.content?.[0]?.text, structureText);

  verifierDocument = new Y.Doc();
  verifierSession = new HocuspocusCollaborationSession({
    document: verifierDocument,
    session: await createStructureSession(),
  });
  await waitForCurrent(verifierSession);
  assert.deepEqual(yDocToProsemirrorJSON(verifierDocument, "content"), recoveredStructureBody);
  const structureRecovered = await requestJson<{ durableSeq: number }>(
    `/api/documents/${structureDocument.id}`,
    { headers: authorization },
  );
  assert.equal(structureRecovered.durableSeq, duplicateResult.durableSeq);

  writerSession.destroy();
  writerDocument.destroy();
  verifierSession.destroy();
  verifierDocument.destroy();
  writerSession = undefined;
  writerDocument = undefined;
  verifierSession = undefined;
  verifierDocument = undefined;

  await deleteDocument(structureDocument.id, accessToken);
  documentId = undefined;
  console.log(
    JSON.stringify({
      committedBodyUpdateRecoveredAfterProcessCrash: true,
      pendingClientReceivedDurableAck: true,
      committedStructureCommandRecoveredAfterProcessCrash: true,
      duplicateStructureCommandReturnedOriginalResult: true,
      bodyDurableSeq: bodyRecovered.durableSeq,
      structureDurableSeq: structureRecovered.durableSeq,
    }),
  );
} finally {
  writerSession?.destroy();
  writerDocument?.destroy();
  verifierSession?.destroy();
  verifierDocument?.destroy();
  if (
    documentId &&
    accessToken &&
    activeServer.child.exitCode === null &&
    activeServer.child.signalCode === null
  ) {
    await deleteDocument(documentId, accessToken).catch(() => undefined);
  }
  for (const server of [...startedServers].reverse()) {
    await stopServer(server.child, server.exited);
  }
}
