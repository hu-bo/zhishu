import assert from "node:assert/strict";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import type { CollaborationSessionInfo } from "@zhishu/editor-collaboration";
import { HocuspocusCollaborationSession } from "@zhishu/editor-collaboration/hocuspocus";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
const expectedText = "PostgreSQL 持久化回执";
const simulateDatabaseOutage = process.argv.includes("--database-outage");
const composeFile = resolve(process.cwd(), "../../deploy/compose.yaml");
let databasePaused = false;

function setDatabasePaused(paused: boolean): void {
  execFileSync("docker", ["compose", "-f", composeFile, paused ? "pause" : "unpause", "postgres"], {
    stdio: "ignore",
  });
  databasePaused = paused;
}

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

async function waitForText(document: Y.Doc, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (document.getText("smoke").toString() === expected) return;
    await delay(25);
  }
  assert.equal(document.getText("smoke").toString(), expected);
}

const login = await requestJson<{ accessToken: string }>("/api/auth/mock/login", {
  method: "POST",
});
const authorization = { authorization: `Bearer ${login.accessToken}` };
const document = await requestJson<{ id: string; generationId: string }>("/api/documents", {
  method: "POST",
  headers: authorization,
  body: JSON.stringify({ title: "Collaboration persistence smoke" }),
});

async function createSession(): Promise<CollaborationSessionInfo> {
  return requestJson<CollaborationSessionInfo>(
    `/api/documents/${document.id}/collaboration-session`,
    {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ schemaVersion: 1, extensions: [] }),
    },
  );
}

let firstDocument: Y.Doc | undefined;
let firstSession: HocuspocusCollaborationSession | undefined;
let collaboratorDocument: Y.Doc | undefined;
let collaboratorSession: HocuspocusCollaborationSession | undefined;
let secondDocument: Y.Doc | undefined;
let secondSession: HocuspocusCollaborationSession | undefined;
let localUpdate: Uint8Array | undefined;
let refreshedTickets = 0;
try {
  firstDocument = new Y.Doc();
  firstSession = new HocuspocusCollaborationSession({
    document: firstDocument,
    session: await createSession(),
    refreshSession: async () => {
      refreshedTickets += 1;
      return createSession();
    },
  });
  await waitForCurrent(firstSession);
  const ticketsBeforeReconnect = refreshedTickets;
  firstDocument.on("update", (update, origin) => {
    if (origin !== firstSession?.provider) localUpdate = Uint8Array.from(update);
  });
  if (simulateDatabaseOutage) setDatabasePaused(true);
  firstDocument.getText("smoke").insert(0, expectedText);
  let receipt = await firstSession.waitForPersisted(
    undefined,
    simulateDatabaseOutage ? 8_000 : 15_000,
  );
  if (simulateDatabaseOutage) {
    assert.equal(
      receipt.status,
      "pending",
      "database failure must leave the local update unconfirmed",
    );
    assert.equal(firstSession.getStatus().pendingUpdateCount, 1);
    setDatabasePaused(false);
    receipt = await firstSession.waitForPersisted(undefined, 30_000);
  }
  assert.equal(
    receipt.status,
    "persisted",
    "the server should acknowledge after PostgreSQL commit",
  );
  assert.ok(receipt.durableSeq > 0, "the server should allocate a durable sequence");
  assert.ok(localUpdate, "the consumer should retain the exact local Yjs update bytes");

  const duplicateHash = createHash("sha256").update(localUpdate).digest("hex");
  const duplicateRequest = JSON.stringify({
    type: "durable-replay",
    protocolVersion: 1,
    updateHash: duplicateHash,
    updateBase64: Buffer.from(localUpdate).toString("base64url"),
  });
  const duplicateSequences: number[] = [];
  const onStateless = ({ payload }: { payload: string }) => {
    try {
      const message = JSON.parse(payload) as {
        type?: string;
        updateHash?: string;
        durableSeq?: number;
      };
      if (message.type === "persisted" && message.updateHash === duplicateHash) {
        duplicateSequences.push(message.durableSeq ?? -1);
      }
    } catch {
      // Other stateless protocol messages are not relevant to this smoke run.
    }
  };
  firstSession.provider.on("stateless", onStateless);
  // Let the original write's stateless event finish before measuring replay replies.
  await delay(100);
  duplicateSequences.length = 0;
  firstSession.provider.sendStateless(duplicateRequest);
  firstSession.provider.sendStateless(duplicateRequest);
  const duplicateDeadline = Date.now() + 5_000;
  while (duplicateSequences.length < 2 && Date.now() < duplicateDeadline) await delay(25);
  firstSession.provider.off("stateless", onStateless);
  assert.deepEqual(duplicateSequences, [receipt.durableSeq, receipt.durableSeq]);

  collaboratorDocument = new Y.Doc();
  collaboratorSession = new HocuspocusCollaborationSession({
    document: collaboratorDocument,
    session: await createSession(),
  });
  await waitForCurrent(collaboratorSession);
  assert.equal(collaboratorDocument.getText("smoke").toString(), expectedText);
  collaboratorDocument.getText("smoke").insert(expectedText.length, " + second collaborator");
  const collaboratorReceipt = await collaboratorSession.waitForPersisted(undefined, 15_000);
  assert.equal(collaboratorReceipt.status, "persisted");
  await waitForText(firstDocument, `${expectedText} + second collaborator`);

  const namedVersion = await requestJson<{ id: string; durableSeq: number }>(
    `/api/documents/${document.id}/versions`,
    {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        name: "Before reconnect edit",
        expectedGenerationId: document.generationId,
        expectedDurableSeq: collaboratorReceipt.durableSeq,
      }),
    },
  );
  assert.equal(namedVersion.durableSeq, collaboratorReceipt.durableSeq);

  firstSession.disconnect();
  firstDocument.getText("smoke").insert(expectedText.length, " + retried connection");
  const reconnectReceipt = firstSession.waitForPersisted(undefined, 20_000);
  firstSession.retry();
  await waitForCurrent(firstSession);
  receipt = await reconnectReceipt;
  assert.equal(receipt.status, "persisted", "manual reconnect must persist pending local updates");
  assert.ok(refreshedTickets > ticketsBeforeReconnect, "reconnect must refresh the session ticket");

  const documentBeforeRestore = await requestJson<{ generationId: string; durableSeq: number }>(
    `/api/documents/${document.id}`,
    { headers: authorization },
  );
  assert.ok(documentBeforeRestore.durableSeq > namedVersion.durableSeq);
  const restoredVersion = await requestJson<{
    generationId: string;
    durableSeq: number;
  }>(`/api/documents/${document.id}/versions/${namedVersion.id}/restore`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({
      expectedGenerationId: documentBeforeRestore.generationId,
      expectedDurableSeq: documentBeforeRestore.durableSeq,
    }),
  });
  assert.notEqual(restoredVersion.generationId, documentBeforeRestore.generationId);
  assert.equal(restoredVersion.durableSeq, namedVersion.durableSeq);

  firstSession.destroy();
  firstDocument.destroy();
  collaboratorSession.destroy();
  collaboratorDocument.destroy();
  firstSession = undefined;
  firstDocument = undefined;
  collaboratorSession = undefined;
  collaboratorDocument = undefined;
  await delay(150);

  secondDocument = new Y.Doc();
  secondSession = new HocuspocusCollaborationSession({
    document: secondDocument,
    session: await createSession(),
  });
  await waitForCurrent(secondSession);
  assert.equal(secondDocument.getText("smoke").toString(), `${expectedText} + second collaborator`);
  console.log(
    JSON.stringify({
      documentId: document.id,
      generationId: restoredVersion.generationId,
      durableSeq: restoredVersion.durableSeq,
      dualClientEditPersisted: true,
      manualReconnectPersisted: true,
      reloadedFromPostgres: true,
    }),
  );
} finally {
  if (databasePaused) setDatabasePaused(false);
  firstSession?.destroy();
  firstDocument?.destroy();
  collaboratorSession?.destroy();
  collaboratorDocument?.destroy();
  secondSession?.destroy();
  secondDocument?.destroy();
}
