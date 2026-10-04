import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import { createEditorSchema } from "@zhishu/editor-core";
import { CURRENT_DOCUMENT_SCHEMA_VERSION, type DocumentBlock } from "@zhishu/document-contracts";
import * as Y from "yjs";
import type { CollaborationSessionInfo, OperationBatch } from "@zhishu/editor-collaboration";
import { HocuspocusCollaborationSession } from "@zhishu/editor-collaboration/hocuspocus";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";

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
  return (await response.json()) as T;
}

async function waitForCurrent(session: HocuspocusCollaborationSession): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = session.getStatus();
    if (status.sync === "current" && status.connection === "connected") return;
    if (status.sync === "incompatible" || status.connection === "denied") {
      throw new Error(status.errorCode ?? "collaboration-session-denied");
    }
    await delay(50);
  }
  throw new Error("collaboration-sync-timeout");
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`timeout: ${description}`);
}

function storedState(document: Y.Doc): {
  revision: number;
  content: {
    type: "doc";
    content: Array<Record<string, unknown> & { attrs: { blockId: string } }>;
  };
  tombstones: string[];
} {
  const meta = document.getMap<unknown>("zhishu.structure.v1");
  const revision = meta.get("revision");
  const root = meta.get("root");
  if (typeof revision !== "number" || typeof root !== "string") {
    throw new Error("structure-state-not-initialized");
  }
  const nodeMap = document.getMap<string>("zhishu.structure.nodes.v1");
  const orderMap = document.getMap<string>("zhishu.structure.orders.v1");
  const build = (blockId: string): Record<string, unknown> & { attrs: { blockId: string } } => {
    const raw = nodeMap.get(blockId);
    if (!raw) throw new Error(`structure-node-missing:${blockId}`);
    const block = JSON.parse(raw) as Record<string, unknown> & { attrs: { blockId: string } };
    const rawChildren = orderMap.get(blockId);
    if (rawChildren !== undefined) {
      block.content = (JSON.parse(rawChildren) as string[]).map(build);
    }
    return block;
  };
  return {
    revision,
    content: { type: "doc", content: (JSON.parse(root) as string[]).map(build) },
    tombstones: [...document.getMap<boolean>("zhishu.structure.tombstones.v1").keys()].sort(),
  };
}

function structureSignature(document: Y.Doc): string {
  return JSON.stringify(
    [
      "zhishu.structure.v1",
      "zhishu.structure.nodes.v1",
      "zhishu.structure.orders.v1",
      "zhishu.structure.tombstones.v1",
      "zhishu.structure.operations.v1",
    ].map((name) => document.getMap<unknown>(name).toJSON()),
  );
}

function assertBodyMatchesStructure(document: Y.Doc): void {
  const body = yDocToProsemirrorJSON(document, "content");
  const pending: unknown[] = [body];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.marks)) {
      for (const mark of record.marks) {
        if (typeof mark !== "object" || mark === null || Array.isArray(mark)) continue;
        const markRecord = mark as Record<string, unknown>;
        if (
          typeof markRecord.attrs === "object" &&
          markRecord.attrs !== null &&
          !Array.isArray(markRecord.attrs) &&
          Object.keys(markRecord.attrs).length === 0
        ) {
          delete markRecord.attrs;
        }
      }
    }
    if (Array.isArray(record.content)) pending.push(...record.content);
  }
  const structure = storedState(document);
  assert.deepEqual(
    body.content,
    structure.content.content,
    "the Tiptap XmlFragment and canonical Block projection must match",
  );
}

function paragraph(blockId: string, text: string) {
  return {
    type: "paragraph" as const,
    attrs: { blockId },
    content: [{ type: "text" as const, text }],
  };
}

function largeParagraph(blockId: string, totalCharacters: number) {
  const chunk = "x".repeat(100_000);
  const fullChunks = Math.floor(totalCharacters / chunk.length);
  const remainder = totalCharacters % chunk.length;
  return {
    type: "paragraph" as const,
    attrs: { blockId },
    content: [
      ...Array.from({ length: fullChunks }, (_, index) => ({
        type: "text" as const,
        text: chunk,
        ...(index % 2 === 0 ? { marks: [{ type: "bold" as const }] } : {}),
      })),
      ...(remainder === 0
        ? []
        : [
            {
              type: "text" as const,
              text: chunk.slice(0, remainder),
              marks: [{ type: "bold" as const }],
            },
          ]),
    ],
  };
}

const login = await requestJson<{ accessToken: string }>("/api/auth/mock/login", {
  method: "POST",
});
const authorization = { authorization: `Bearer ${login.accessToken}` };
const document = await requestJson<{ id: string; generationId: string }>("/api/documents", {
  method: "POST",
  headers: authorization,
  body: JSON.stringify({ title: "Concurrent structure smoke" }),
});

async function createSession(): Promise<CollaborationSessionInfo> {
  return requestJson<CollaborationSessionInfo>(
    `/api/documents/${document.id}/collaboration-session`,
    {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({ schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION, extensions: [] }),
    },
  );
}

const docs: Y.Doc[] = [];
const sessions: HocuspocusCollaborationSession[] = [];
function openSession(session: CollaborationSessionInfo): HocuspocusCollaborationSession {
  const ydoc = new Y.Doc();
  docs.push(ydoc);
  const collaboration = new HocuspocusCollaborationSession({ document: ydoc, session });
  sessions.push(collaboration);
  return collaboration;
}

try {
  const first = openSession(await createSession());
  const second = openSession(await createSession());
  await Promise.all([waitForCurrent(first), waitForCurrent(second)]);

  const initialBatch: OperationBatch = {
    operationId: "op_structure_initial",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      { type: "insert-block", parentBlockId: null, block: paragraph("block_alpha", "A") },
      { type: "insert-block", parentBlockId: null, block: paragraph("block_beta", "B") },
      { type: "insert-block", parentBlockId: null, block: paragraph("block_gamma", "C") },
    ],
  };
  const initial = await first.submitStructureOperation(initialBatch, 0);
  assert.equal(initial.status, "accepted");
  await waitUntil(() => second.getStructureRevision() === 1, "peer sees initialized structure");
  assertBodyMatchesStructure(docs[0] as Y.Doc);
  assertBodyMatchesStructure(docs[1] as Y.Doc);

  const bodyDocument = docs[0] as Y.Doc;
  const body = yDocToProsemirrorJSON(bodyDocument, "content");
  const beta = (body.content as Array<Record<string, unknown>>).find(
    (block) => (block.attrs as { blockId?: string } | undefined)?.blockId === "block_beta",
  );
  assert.ok(beta, "the initial structure operation must also populate the body XmlFragment");
  const largeBody = largeParagraph("block_beta", 900_000);
  Object.assign(beta, largeBody);
  prosemirrorJSONToYXmlFragment(
    createEditorSchema({ collaborative: true }),
    body,
    bodyDocument.getXmlFragment("content"),
  );
  await waitUntil(
    () => first.getStructureRevision() === 2 && second.getStructureRevision() === 2,
    "ordinary body update refreshes the canonical structure projection",
  );
  assertBodyMatchesStructure(bodyDocument);
  await waitUntil(
    () => storedState(docs[1] as Y.Doc).revision === 2,
    "peer receives the projected body update",
  );
  assertBodyMatchesStructure(docs[1] as Y.Doc);

  const largeNodeBytes =
    (docs[0] as Y.Doc).getMap<string>("zhishu.structure.nodes.v1").get("block_beta")?.length ?? 0;
  assert.ok(
    largeNodeBytes > 800_000,
    "the large Block payload must be stored independently from its position",
  );

  const firstMove: OperationBatch = {
    operationId: "op_structure_move_first",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      {
        type: "move-block",
        targetBlockId: "block_beta",
        parentBlockId: null,
        beforeBlockId: "block_alpha",
      },
    ],
  };
  const secondMove: OperationBatch = {
    operationId: "op_structure_move_second",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      {
        type: "move-block",
        targetBlockId: "block_beta",
        parentBlockId: null,
        afterBlockId: "block_gamma",
      },
    ],
  };
  const race = await Promise.all([
    first.submitStructureOperation(firstMove, 2),
    second.submitStructureOperation(secondMove, 2),
  ]);
  assert.equal(race.filter((result) => result.status === "accepted").length, 1);
  assert.equal(race.filter((result) => result.status === "conflict").length, 1);
  const conflict = race.find((result) => result.status === "conflict");
  if (conflict?.status !== "conflict") throw new Error("concurrent-structure-conflict-missing");
  assert.equal(conflict.code, "stale-structure-revision");
  await waitUntil(
    () => first.getStructureRevision() === 3 && second.getStructureRevision() === 3,
    "both peers receive the winning move",
  );
  assertBodyMatchesStructure(docs[0] as Y.Doc);
  assertBodyMatchesStructure(docs[1] as Y.Doc);
  const movedRootIds = storedState(docs[0] as Y.Doc).content.content.map(
    (block) => block.attrs.blockId,
  );
  assert.ok(
    JSON.stringify(movedRootIds) === JSON.stringify(["block_beta", "block_alpha", "block_gamma"]) ||
      JSON.stringify(movedRootIds) === JSON.stringify(["block_alpha", "block_gamma", "block_beta"]),
    "the winning move must produce one of the two valid target orders",
  );
  assert.equal(structureSignature(docs[0] as Y.Doc), structureSignature(docs[1] as Y.Doc));
  const acceptedIndex = race.findIndex((result) => result.status === "accepted");
  const acceptedBatch = acceptedIndex === 0 ? firstMove : secondMove;
  const acceptedSession = acceptedIndex === 0 ? first : second;
  const duplicate = await acceptedSession.submitStructureOperation(acceptedBatch, 2);
  assert.equal(duplicate.status, "duplicate", "replaying an accepted operation ID is idempotent");
  assert.equal(duplicate.revision, 3);

  const splitAlpha: OperationBatch = {
    operationId: "op_structure_split_alpha",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      {
        type: "replace-block",
        targetBlockId: "block_alpha",
        block: paragraph("block_alpha", "left"),
      },
      {
        type: "insert-block",
        parentBlockId: null,
        afterBlockId: "block_alpha",
        block: paragraph("block_split_right", "right"),
      },
    ],
  };
  assert.equal((await first.submitStructureOperation(splitAlpha, 3)).status, "accepted");
  const mergeAlpha: OperationBatch = {
    operationId: "op_structure_merge_alpha",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      {
        type: "replace-block",
        targetBlockId: "block_alpha",
        block: paragraph("block_alpha", "leftright"),
      },
      { type: "delete-block", targetBlockId: "block_split_right" },
    ],
  };
  assert.equal((await second.submitStructureOperation(mergeAlpha, 4)).status, "accepted");

  const deleteBlock: OperationBatch = {
    operationId: "op_structure_delete_gamma",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [{ type: "delete-block", targetBlockId: "block_gamma" }],
  };
  assert.equal((await first.submitStructureOperation(deleteBlock, 5)).status, "accepted");
  const reuseBlockId: OperationBatch = {
    operationId: "op_structure_reuse_gamma",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      { type: "insert-block", parentBlockId: null, block: paragraph("block_gamma", "reused") },
    ],
  };
  const retiredIdResult = await second.submitStructureOperation(reuseBlockId, 6);
  assert.equal(retiredIdResult.status, "rejected");
  assert.equal(retiredIdResult.code, "retired-block-id-reused");

  const calloutBatch: OperationBatch = {
    operationId: "op_structure_callout",
    documentId: document.id,
    generationId: document.generationId,
    origin: "user",
    operations: [
      {
        type: "wrap-block",
        targetBlockId: "block_alpha",
        wrapper: {
          type: "callout",
          attrs: { blockId: "block_callout", theme: "info" },
          content: [],
        },
      },
    ],
  };
  assert.equal((await first.submitStructureOperation(calloutBatch, 6)).status, "accepted");
  await waitUntil(
    () => second.getStructureRevision() === 7,
    "peer receives nested callout structure",
  );
  const calloutBlock = storedState(docs[0] as Y.Doc).content.content.find(
    (block) => block.type === "callout",
  );
  assert.ok(calloutBlock);
  const themedCallout = structuredClone(calloutBlock);
  Object.assign(themedCallout.attrs, { theme: "success" });
  assert.equal(
    (
      await second.submitStructureOperation(
        {
          operationId: "op_structure_callout_theme",
          documentId: document.id,
          generationId: document.generationId,
          origin: "user",
          operations: [
            {
              type: "replace-block",
              targetBlockId: "block_callout",
              block: themedCallout as DocumentBlock,
            },
          ],
        },
        7,
      )
    ).status,
    "accepted",
  );
  await waitUntil(
    () => first.getStructureRevision() === 8,
    "callout theme durable acknowledgement",
  );
  const statusBody = yDocToProsemirrorJSON(docs[0] as Y.Doc, "content");
  const statusCallout = (
    statusBody.content as Array<{ type: string; content?: Array<{ content?: unknown[] }> }>
  ).find((block) => block.type === "callout");
  assert.ok(statusCallout?.content?.[0]);
  statusCallout.content[0].content = [
    ...(statusCallout.content[0].content ?? []),
    { type: "statusTag", attrs: { status: "in-review" } },
  ];
  prosemirrorJSONToYXmlFragment(
    createEditorSchema({ collaborative: true }),
    statusBody,
    (docs[0] as Y.Doc).getXmlFragment("content"),
  );
  await waitUntil(
    () => first.getStructureRevision() === 9 && second.getStructureRevision() === 9,
    "inline status persisted inside callout",
  );
  assert.equal(
    (
      await first.submitStructureOperation(
        {
          operationId: "op_structure_labeled_divider",
          documentId: document.id,
          generationId: document.generationId,
          origin: "user",
          operations: [
            {
              type: "insert-block",
              parentBlockId: null,
              block: {
                type: "horizontalRule",
                attrs: { blockId: "block_labeled_divider", label: "交付后的维护" },
              },
            },
          ],
        },
        9,
      )
    ).status,
    "accepted",
  );
  await waitUntil(() => second.getStructureRevision() === 10, "divider label persisted");
  assertBodyMatchesStructure(docs[0] as Y.Doc);
  assertBodyMatchesStructure(docs[1] as Y.Doc);
  const versionDocument = await requestJson<{ generationId: string; durableSeq: number }>(
    `/api/documents/${document.id}`,
    { headers: authorization },
  );
  const extensionVersion = await requestJson<{ id: string }>(
    `/api/documents/${document.id}/versions`,
    {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        mode: "collaborative",
        name: "提示块与状态历史",
        expectedGenerationId: versionDocument.generationId,
        expectedDurableSeq: versionDocument.durableSeq,
      }),
    },
  );
  const historicalExtensions = await requestJson<{
    schemaVersion: number;
    content: { content: Array<{ type: string }> };
  }>(`/api/documents/${document.id}/versions/${extensionVersion.id}/content`, {
    headers: authorization,
  });
  assert.equal(historicalExtensions.schemaVersion, CURRENT_DOCUMENT_SCHEMA_VERSION);
  assert.ok(historicalExtensions.content.content.some((block) => block.type === "callout"));
  assert.equal(
    (
      await second.submitStructureOperation(
        {
          operationId: "op_structure_unwrap_callout",
          documentId: document.id,
          generationId: document.generationId,
          origin: "user",
          operations: [
            {
              type: "move-block",
              targetBlockId: "block_alpha",
              parentBlockId: null,
              beforeBlockId: "block_callout",
            },
            { type: "delete-block", targetBlockId: "block_callout" },
          ],
        },
        10,
      )
    ).status,
    "accepted",
  );
  await waitUntil(
    () => first.getStructureRevision() === 11,
    "unwrap preserves child identity and inline status",
  );

  const expectedState = storedState(docs[0] as Y.Doc);
  assert.equal(expectedState.revision, 11);
  assertBodyMatchesStructure(docs[0] as Y.Doc);
  assertBodyMatchesStructure(docs[1] as Y.Doc);
  first.disconnect();
  first.retry();
  await waitForCurrent(first);
  assert.deepEqual(
    storedState(docs[0] as Y.Doc),
    expectedState,
    "reconnecting the same Y.Doc accepts known structure items and delete sets",
  );
  assert.ok(expectedState.tombstones.includes("block_gamma"));
  assert.ok(expectedState.tombstones.includes("block_split_right"));
  assert.deepEqual(
    expectedState.content.content.map((block) => block.attrs?.blockId),
    [...new Set(expectedState.content.content.map((block) => block.attrs.blockId))],
    "the winning structure contains unique Block IDs",
  );

  first.destroy();
  second.destroy();
  sessions.length = 0;
  docs.forEach((ydoc) => ydoc.destroy());
  docs.length = 0;
  await delay(150);
  const reopened = openSession(await createSession());
  await waitForCurrent(reopened);
  assert.equal(reopened.getStructureRevision(), 11);
  assert.deepEqual(storedState(docs[0] as Y.Doc), expectedState);
  assertBodyMatchesStructure(docs[0] as Y.Doc);

  const unauthorizedDocument = docs[0] as Y.Doc;
  unauthorizedDocument.getMap<number>("zhishu.structure.v1").set("revision", 99);
  await waitUntil(
    () => reopened.getStatus().connection === "denied",
    "server rejects direct client mutation of the canonical structure",
  );

  console.log(
    JSON.stringify({
      documentId: document.id,
      generationId: document.generationId,
      concurrentMoveWinnerCount: 1,
      concurrentMoveConflictCount: 1,
      duplicateOperationReplay: true,
      splitAndMergeIdentityRules: true,
      retiredBlockIdReuseRejected: true,
      largeBlockMovedUnderFrameLimit: true,
      bodyAndStructureProjectionRoundtrip: true,
      structureRestoredAfterReconnect: true,
      sameDocumentReconnectWithKnownStructureDeletes: true,
      directStructureWriteRejected: true,
      calloutStatusDividerPersisted: true,
      extensionHistoryReadable: true,
      calloutUnwrapPreservesBlockIds: true,
    }),
  );
} finally {
  sessions.forEach((session) => session.destroy());
  docs.forEach((ydoc) => ydoc.destroy());
}
