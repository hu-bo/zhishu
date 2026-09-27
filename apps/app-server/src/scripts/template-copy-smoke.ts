import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import {
  createEditorSchema,
  normalizeTiptapDocumentJSON,
  validateContentForEditor,
} from "@zhishu/editor-core/schema";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import {
  emptyStructureState,
  projectContentUpdateToStructure,
  readStoredStructureState,
  sameDocumentContent,
  writeStoredStructureState,
} from "../modules/collaboration/structure-operations.js";
import { DocumentRepository } from "../modules/documents/document.repository.js";
import type { DocumentContent } from "@zhishu/document-contracts";
import * as Y from "yjs";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the disposable project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Template copy smoke only accepts the project-local 127.0.0.1:5432/app database",
);

const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: "test", AUTH_MODE: "mock", LOG_LEVEL: "silent" }),
);
const repository = new DocumentRepository(app.db);
let sourceId: string | undefined;
let copiedId: string | undefined;
let sourceDocument: Y.Doc | undefined;
let copiedDocument: Y.Doc | undefined;

function stripBlockIds(input: DocumentContent): DocumentContent {
  const copy = structuredClone(input);
  const pending: unknown[] = [copy];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    const attrs = node.attrs;
    if (typeof attrs === "object" && attrs !== null && !Array.isArray(attrs)) {
      delete (attrs as Record<string, unknown>).blockId;
    }
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return copy;
}

try {
  await app.ready();
  const login = await app.inject({ method: "POST", url: "/api/auth/mock/login" });
  assert.equal(login.statusCode, 200, login.body);
  const authorization = { authorization: `Bearer ${login.json().accessToken as string}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/documents",
    headers: authorization,
    payload: { title: "Template copy source" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const source = created.json() as {
    id: string;
    generationId: string;
    tenantId: string;
    durableSeq: number;
  };
  sourceId = source.id;

  const sourceContent: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1, blockId: "block_template_heading" },
        content: [{ type: "text", text: "Template heading" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "block_template_paragraph" },
        content: [
          { type: "text", text: "Copied body with " },
          { type: "text", text: "formatting", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  const editorValidation = validateContentForEditor(sourceContent, createEditorSchema());
  assert.equal(editorValidation.success, true);
  sourceDocument = prosemirrorJSONToYDoc(createEditorSchema(), sourceContent, "content");
  const projected = projectContentUpdateToStructure(
    emptyStructureState(),
    { type: "doc", content: [] },
    sourceContent,
  );
  if (!projected.success) throw new Error(projected.code);
  writeStoredStructureState(sourceDocument, projected.state);
  const sourceUpdate = Y.encodeStateAsUpdate(sourceDocument);
  const sourceHash = createHash("sha256").update(sourceUpdate).digest("hex");
  const sourceReceipt = await repository.persistUpdate({
    documentId: source.id,
    generationId: source.generationId,
    tenantId: source.tenantId,
    subjectId: "mock-user-001",
    updateHash: sourceHash,
    updateBytes: sourceUpdate,
    contentChanged: true,
    content: sourceContent,
  });
  assert.equal(sourceReceipt.durableSeq, 1);

  const version = await app.inject({
    method: "POST",
    url: `/api/documents/${source.id}/versions`,
    headers: authorization,
    payload: {
      name: "Preview source content",
      expectedGenerationId: source.generationId,
      expectedDurableSeq: sourceReceipt.durableSeq,
    },
  });
  assert.equal(version.statusCode, 201, version.body);
  const preview = await app.inject({
    url: `/api/documents/${source.id}/versions/${version.json().id}/content`,
    headers: authorization,
  });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().generationId, source.generationId);
  assert.equal(preview.json().durableSeq, sourceReceipt.durableSeq);
  assert.deepEqual(preview.json().content, sourceContent);

  const copied = await app.inject({
    method: "POST",
    url: `/api/documents/${source.id}/copy`,
    headers: authorization,
    payload: { title: "Template copy result" },
  });
  assert.equal(copied.statusCode, 201, copied.body);
  const copy = copied.json() as {
    id: string;
    generationId: string;
    durableSeq: number;
  };
  copiedId = copy.id;
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.generationId, source.generationId);
  assert.equal(copy.durableSeq, 1);

  const copiedUpdates = await repository.loadUpdates(copy.id, copy.generationId, copy.durableSeq);
  assert.equal(copiedUpdates.length, 1);
  copiedDocument = new Y.Doc();
  for (const update of copiedUpdates) Y.applyUpdate(copiedDocument, update.updateBytes);
  const projectedJson = yDocToProsemirrorJSON(copiedDocument, "content");
  const normalized = normalizeTiptapDocumentJSON(
    Array.isArray(projectedJson.content) || projectedJson.content !== undefined
      ? projectedJson
      : { ...projectedJson, content: [] },
  );
  const copiedContent = validateContentForEditor(normalized, createEditorSchema());
  assert.equal(copiedContent.success, true);
  if (!copiedContent.success) throw new Error("Copied content is not valid for the editor");
  assert.deepEqual(stripBlockIds(copiedContent.content), stripBlockIds(sourceContent));

  const getIds = (content: DocumentContent): Set<string> => {
    const ids = new Set<string>();
    const pending: unknown[] = [...content.content];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const block = value as Record<string, unknown>;
      const attrs = block.attrs;
      if (
        typeof attrs === "object" &&
        attrs !== null &&
        !Array.isArray(attrs) &&
        typeof (attrs as Record<string, unknown>).blockId === "string"
      ) {
        ids.add((attrs as Record<string, unknown>).blockId as string);
      }
      if (Array.isArray(block.content)) pending.push(...block.content);
    }
    return ids;
  };
  const sourceIds = getIds(sourceContent);
  const copiedIds = getIds(copiedContent.content);
  assert.equal(copiedIds.size, sourceIds.size);
  assert.ok([...copiedIds].every((id) => !sourceIds.has(id)));

  const structure = readStoredStructureState(copiedDocument);
  assert.ok(structure);
  assert.equal(structure.revision, 1);
  assert.deepEqual(structure.tombstones, []);
  assert.deepEqual(structure.operations, {});
  assert.ok(sameDocumentContent(structure.content, copiedContent.content));
  console.log(
    JSON.stringify({
      copiedContent: true,
      regeneratedBlockIds: true,
      structureProjectionRebuilt: true,
      versionContentPreview: true,
      sourceGenerationUnchanged: true,
      durableSeq: copy.durableSeq,
    }),
  );
} finally {
  sourceDocument?.destroy();
  copiedDocument?.destroy();
  if (copiedId || sourceId) {
    await app.db.execute(
      sql`delete from documents where id in (${copiedId ?? ""}, ${sourceId ?? ""})`,
    );
  }
  await app.close();
}
