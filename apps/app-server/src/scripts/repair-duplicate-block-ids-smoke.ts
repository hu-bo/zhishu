import "../environment.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import {
  createEditorSchema,
  normalizeTiptapDocumentJSON,
  validateContentForEditor,
} from "@zhishu/editor-core/schema";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { documentGenerations } from "../../database/schema/index.js";
import {
  projectContentUpdateToStructure,
  readStoredStructureState,
  sameDocumentContent,
  emptyStructureState,
} from "../modules/collaboration/structure-operations.js";
import {
  createDocumentService,
  DocumentRepository,
  DocumentHistoryRepository,
} from "../modules/documents/index.js";
import type { Principal } from "../modules/identity/identity.types.js";
import * as Y from "yjs";
import type { DocumentContent } from "@zhishu/document-contracts";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the disposable project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Block ID repair smoke only accepts the project-local 127.0.0.1:5432/app database",
);

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  AUTH_MODE: "mock",
  LOG_LEVEL: "silent",
});
const app = await buildApp(config);
const repository = new DocumentRepository(app.db);
const history = new DocumentHistoryRepository(app.db);
const service = createDocumentService(app.db, config, {
  revokeDocumentSessions: () => undefined,
});
let documentId: string | undefined;
let sourceDocument: Y.Doc | undefined;
let repairedDocument: Y.Doc | undefined;

function collectIds(content: unknown): string[] {
  const ids: string[] = [];
  const pending: unknown[] = [content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    const attrs = node.attrs;
    if (
      typeof attrs === "object" &&
      attrs !== null &&
      !Array.isArray(attrs) &&
      typeof (attrs as Record<string, unknown>).blockId === "string"
    ) {
      ids.push((attrs as Record<string, unknown>).blockId as string);
    }
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return ids;
}

try {
  await app.ready();
  const principal: Principal = {
    identityId: "mock-user-001",
    tenantId: "local",
    username: "mock-user",
    displayName: "Mock User",
    email: "mock@example.invalid",
    globalRoles: ["user"],
    active: true,
  };
  const created = await repository.create(
    principal.tenantId,
    principal.identityId,
    "Repair fixture",
  );
  documentId = created.id;
  const duplicatedContent: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_legacy_duplicate" },
        content: [{ type: "text", text: "first block" }],
      },
      {
        type: "paragraph",
        attrs: { blockId: "block_legacy_duplicate" },
        content: [{ type: "text", text: "second block" }],
      },
    ],
  };
  sourceDocument = prosemirrorJSONToYDoc(createEditorSchema(), duplicatedContent, "content");
  const sourceUpdate = Y.encodeStateAsUpdate(sourceDocument);
  const sourceHash = createHash("sha256").update(sourceUpdate).digest("hex");
  const receipt = await repository.persistUpdate({
    documentId: created.id,
    generationId: created.generationId,
    tenantId: created.tenantId,
    subjectId: principal.identityId,
    updateHash: sourceHash,
    updateBytes: sourceUpdate,
    contentChanged: true,
    content: duplicatedContent,
  });
  assert.equal(receipt.durableSeq, 1);

  const preview = await service.repairDuplicateBlockIds(principal, created.id, false);
  assert.deepEqual(preview, { status: "repairable", duplicateCount: 1 });
  const beforeApply = await repository.findActiveForAction(
    created.id,
    principal.tenantId,
    principal.identityId,
    "write",
  );
  assert.equal(beforeApply?.generationId, created.generationId);

  const repair = await service.repairDuplicateBlockIds(principal, created.id, true);
  assert.equal(repair.status, "repaired");
  if (repair.status !== "repaired") throw new Error("Duplicate Block ID repair did not complete");
  assert.equal(repair.duplicateCount, 1);
  assert.equal(repair.previousGenerationId, created.generationId);
  assert.notEqual(repair.generationId, created.generationId);

  const active = await repository.findActiveForAction(
    created.id,
    principal.tenantId,
    principal.identityId,
    "write",
  );
  assert.ok(active);
  assert.equal(active.generationId, repair.generationId);
  assert.equal(active.durableSeq, 1);
  const generations = await app.db
    .select({ id: documentGenerations.id, status: documentGenerations.status })
    .from(documentGenerations)
    .where(eq(documentGenerations.documentId, created.id));
  assert.equal(generations.find((item) => item.id === created.generationId)?.status, "retired");
  assert.equal(generations.find((item) => item.id === repair.generationId)?.status, "active");

  const repairedUpdates = await history.loadUpdates(created.id, repair.generationId, 1);
  assert.equal(repairedUpdates.length, 1);
  repairedDocument = new Y.Doc();
  Y.applyUpdate(repairedDocument, repairedUpdates[0]!.updateBytes);
  const projected = yDocToProsemirrorJSON(repairedDocument, "content");
  const normalized = normalizeTiptapDocumentJSON(
    Array.isArray(projected.content) || projected.content !== undefined
      ? projected
      : { ...projected, content: [] },
  );
  const editorValidation = validateContentForEditor(normalized, createEditorSchema());
  assert.equal(editorValidation.success, true);
  if (!editorValidation.success) throw new Error("Repaired content is not valid for the editor");
  const repairedContent = editorValidation.content;
  const repairedIds = collectIds(normalized);
  assert.equal(repairedIds.length, 2);
  assert.equal(new Set(repairedIds).size, 2);
  assert.ok(repairedIds.includes("block_legacy_duplicate"));
  const repairedStructure = readStoredStructureState(repairedDocument);
  assert.ok(repairedStructure);
  assert.ok(sameDocumentContent(repairedStructure.content, repairedContent));
  const rebuiltStructure = projectContentUpdateToStructure(
    emptyStructureState(),
    { type: "doc", content: [] },
    repairedContent,
  );
  assert.equal(rebuiltStructure.success, true);

  console.log(
    JSON.stringify({
      dryRunNonMutating: true,
      duplicateIdsRepaired: true,
      contentPreserved: true,
      structureProjectionRebuilt: true,
      oldGenerationRetired: true,
      newGenerationDurableSeq: active.durableSeq,
    }),
  );
} finally {
  sourceDocument?.destroy();
  repairedDocument?.destroy();
  if (documentId) {
    await app.db.execute(sql`delete from documents where id = ${documentId}`);
  }
  await app.close();
}
