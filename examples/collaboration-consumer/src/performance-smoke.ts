import assert from "node:assert/strict";
import { createServer, createConnection, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import * as Y from "yjs";
import { CURRENT_DOCUMENT_SCHEMA_VERSION, type DocumentBlock } from "@zhishu/document-contracts";
import type { CollaborationSessionInfo } from "@zhishu/editor-collaboration";
import { HocuspocusCollaborationSession } from "@zhishu/editor-collaboration/hocuspocus";

const apiUrl = new URL(process.env.API_URL ?? "http://127.0.0.1:3100");
assert.equal(
  process.env.PERFORMANCE_QA,
  "true",
  "Set PERFORMANCE_QA=true for a disposable QA server",
);
assert.ok(["127.0.0.1", "localhost"].includes(apiUrl.hostname), "Loopback QA server required");
const clientCount = 20;
const samples = 35;
const warmupSamples = 5;
const editedBlockPositions =
  process.env.PERFORMANCE_POSITION_MATRIX === "true" ? [0, 500, 999] : [0];
const oneWayDelayMs = 50;
const clients: Array<{ document: Y.Doc; session: HocuspocusCollaborationSession }> = [];
const sockets = new Set<Socket>();
const timers = new Set<ReturnType<typeof setTimeout>>();
let backendUrl: URL | undefined;
let createdDocumentId: string | undefined;
let authorization: Record<string, string> = {};

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, apiUrl), {
    ...options,
    headers: {
      ...authorization,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: HTTP ${response.status}`);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function waitUntil(condition: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await delay(10);
  }
}

// Delay both directions of the actual WebSocket byte stream, including its handshake.
// HTTP throttling alone would not establish this collaboration network baseline.
const proxy = createServer((downstream) => {
  if (!backendUrl) {
    downstream.destroy();
    return;
  }
  const upstream = createConnection({ host: backendUrl.hostname, port: Number(backendUrl.port) });
  sockets.add(downstream);
  sockets.add(upstream);
  const forward = (source: Socket, target: Socket) => {
    let queuedBytes = 0;
    let waitingForDrain = false;
    source.on("data", (data: Buffer) => {
      queuedBytes += data.byteLength;
      if (queuedBytes > 32 * 1024 * 1024) {
        source.destroy();
        target.destroy();
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        queuedBytes -= data.byteLength;
        if (!target.destroyed && !target.write(data) && !waitingForDrain) {
          waitingForDrain = true;
          source.pause();
          target.once("drain", () => {
            waitingForDrain = false;
            source.resume();
          });
        }
      }, oneWayDelayMs);
      timers.add(timer);
    });
    source.on("error", () => target.destroy());
    source.on("close", () => {
      sockets.delete(source);
      target.destroy();
    });
  };
  forward(downstream, upstream);
  forward(upstream, downstream);
});

function blockText(document: Y.Doc, position: number): Y.XmlText {
  const paragraph = document.getXmlFragment("content").get(position);
  assert.ok(paragraph instanceof Y.XmlElement);
  const text = paragraph.get(0);
  assert.ok(text instanceof Y.XmlText);
  return text;
}

function waitForRemoteText(document: Y.Doc, marker: string, position: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      document.off("update", changed);
      reject(new Error("Remote update timed out"));
    }, 15_000);
    const changed = () => {
      if (!blockText(document, position).toString().includes(marker)) return;
      clearTimeout(timeout);
      document.off("update", changed);
      resolve();
    };
    document.on("update", changed);
  });
}

function p95(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(1));
}

try {
  const login = await requestJson<{ accessToken: string }>("/api/auth/mock/login", {
    method: "POST",
  });
  authorization = { authorization: `Bearer ${login.accessToken}` };
  const created = await requestJson<{ id: string; generationId: string }>("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      title: "20-session WebSocket performance smoke",
      mode: "collaborative",
    }),
  });
  createdDocumentId = created.id;
  const createTicket = () =>
    requestJson<CollaborationSessionInfo>(`/api/documents/${created.id}/collaboration-session`, {
      method: "POST",
      body: JSON.stringify({ schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION, extensions: [] }),
    });
  const initialTicket = await createTicket();
  backendUrl = new URL(initialTicket.providerUrl);
  assert.equal(backendUrl.protocol, "ws:");
  assert.ok(["localhost", "127.0.0.1"].includes(backendUrl.hostname));
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const proxyUrl = `ws://127.0.0.1:${address.port}`;
  const ticketThroughProxy = async () => ({ ...(await createTicket()), providerUrl: proxyUrl });
  const connect = async (ticket: CollaborationSessionInfo) => {
    const document = new Y.Doc();
    const session = new HocuspocusCollaborationSession({
      document,
      session: { ...ticket, providerUrl: proxyUrl },
      refreshSession: ticketThroughProxy,
    });
    clients.push({ document, session });
    await session.waitUntilSynced();
    await waitUntil(() => session.getStatus().connection === "connected", "connected peer");
    return { document, session };
  };
  const seed = await connect(initialTicket);
  const blocks: DocumentBlock[] = Array.from({ length: 1000 }, (_, index) => ({
    type: "paragraph",
    attrs: { blockId: `block_perf_${index}` },
    content: [
      { type: "text", text: `段落 ${index}。` + "Writing knowledge together. ".repeat(33) },
    ],
  }));
  const fixtureBytes = Buffer.byteLength(JSON.stringify({ type: "doc", content: blocks }));
  for (let offset = 0; offset < blocks.length; offset += 250) {
    const result = await seed.session.submitStructureOperation(
      {
        documentId: created.id,
        generationId: created.generationId,
        operationId: `op_performance_seed_${offset}`,
        origin: "user",
        operations: blocks
          .slice(offset, offset + 250)
          .map((block) => ({ type: "insert-block", parentBlockId: null, block })),
      },
      seed.session.getStructureRevision(),
    );
    assert.equal(result.status, "accepted");
  }
  await waitUntil(
    () => seed.document.getXmlFragment("content").length === 1000,
    "1000 seeded blocks",
  );
  const tickets = await Promise.all(Array.from({ length: clientCount - 1 }, ticketThroughProxy));
  await Promise.all(tickets.map(connect));
  await waitUntil(
    () => clients.every((client) => client.document.getXmlFragment("content").length === 1000),
    "all 20 peers see 1000 blocks",
  );
  await delay(300);
  console.log(
    JSON.stringify({
      phase: "ready",
      sessions: clients.length,
      blocks: 1000,
      fixtureBytes,
      websocketRoundTripDelayMs: oneWayDelayMs * 2,
    }),
  );
  const remoteVisibleMs: number[] = [],
    durableAckMs: number[] = [];
  for (let index = -warmupSamples; index < samples; index++) {
    const writerIndex = (index + warmupSamples) % clients.length,
      writer = clients[writerIndex]!;
    const marker = `[sample-${index}]`;
    const position = editedBlockPositions[(index + warmupSamples) % editedBlockPositions.length]!;
    const waiters = clients
      .filter((_, peer) => peer !== writerIndex)
      .map((client) => waitForRemoteText(client.document, marker, position));
    const start = performance.now();
    blockText(writer.document, position).insert(0, marker);
    const receiptPromise = writer.session.waitForPersisted(undefined, 15_000).then((receipt) => {
      assert.equal(receipt.status, "persisted");
      if (index >= 0) durableAckMs.push(performance.now() - start);
    });
    await Promise.all(waiters);
    const remoteMs = performance.now() - start;
    if (index >= 0) remoteVisibleMs.push(remoteMs);
    await receiptPromise;
    console.log(
      JSON.stringify({
        sample: index,
        position,
        remoteMs: Number(remoteMs.toFixed(1)),
        durableMs: index >= 0 ? Number(durableAckMs.at(-1)!.toFixed(1)) : undefined,
      }),
    );
    await delay(30);
  }
  const result = {
    sessions: clients.length,
    distinctAuthenticatedIdentities: 1,
    blocks: 1000,
    fixtureBytes,
    samples,
    warmupSamples,
    editedBlockPositions,
    websocketRoundTripDelayMs: oneWayDelayMs * 2,
    remoteYDocAllPeersP95Ms: p95(remoteVisibleMs),
    remoteYDocAllPeersMaxMs: Number(Math.max(...remoteVisibleMs).toFixed(1)),
    durableAckP95Ms: p95(durableAckMs),
    durableAckMaxMs: Number(Math.max(...durableAckMs).toFixed(1)),
    clientRenderingMeasured: false,
  };
  console.log(JSON.stringify(result));
  assert.ok(
    result.remoteYDocAllPeersP95Ms <= 500,
    "Remote delivery P95 exceeds initial 500ms target",
  );
  assert.ok(result.durableAckP95Ms <= 2_000, "Durable ack P95 exceeds initial 2s target");
} finally {
  for (const client of clients) {
    client.session.destroy();
    client.document.destroy();
  }
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  if (createdDocumentId) {
    await requestJson(`/api/documents/${createdDocumentId}`, { method: "DELETE" });
    await requestJson(`/api/documents/${createdDocumentId}/permanent`, { method: "DELETE" });
  }
}
