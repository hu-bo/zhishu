import "../environment.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { createEditorSchema } from "@zhishu/editor-core/schema";
import {
  assets,
  assetReferences,
  documentGenerations,
  documents,
} from "../../database/schema/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DocumentRepository } from "../modules/documents/index.js";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the disposable project PostgreSQL database");
const parsedDatabaseUrl = new URL(databaseUrl);
assert.ok(
  ["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) &&
    parsedDatabaseUrl.port === "5432" &&
    parsedDatabaseUrl.pathname === "/app",
  "Asset reference smoke only accepts the project-local 127.0.0.1:5432/app database",
);

const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: "test", AUTH_MODE: "mock", LOG_LEVEL: "silent" }),
);
const repository = new DocumentRepository(app.db);
const principal = {
  identityId: "asset-reference-smoke",
  tenantId: "asset-reference-smoke",
};
const token = randomUUID();
let documentId: string | undefined;
let assetId: string | undefined;

try {
  await app.ready();
  const document = await repository.create(
    principal.tenantId,
    principal.identityId,
    "Asset ref smoke",
  );
  documentId = document.id;
  assetId = `asset_${token}`;
  const now = new Date();
  const imageContent = {
    type: "doc" as const,
    content: [
      {
        type: "image" as const,
        attrs: {
          assetId,
          mediaType: "image/png" as const,
          alt: "smoke asset",
          blockId: "block_asset_smoke",
        },
      },
    ],
  };
  const versionDoc = prosemirrorJSONToYDoc(createEditorSchema(), imageContent, "content");
  const versionStateBytes = Y.encodeStateAsUpdate(versionDoc);
  versionDoc.destroy();
  await app.db.insert(assets).values({
    id: assetId,
    tenantId: principal.tenantId,
    documentId,
    objectKey: `smoke/${token}`,
    fileName: "smoke.png",
    mediaType: "image/png",
    declaredSize: 16,
    actualSize: 16,
    sha256: "a".repeat(64),
    status: "ready",
    createdBy: principal.identityId,
    uploadExpiresAt: new Date(now.getTime() + 60_000),
    uploadedAt: now,
    completedAt: now,
  });

  const first = await repository.persistUpdate({
    documentId,
    generationId: document.generationId,
    tenantId: principal.tenantId,
    subjectId: principal.identityId,
    updateHash: `asset-reference-${token}-1`,
    updateBytes: new Uint8Array([1]),
    contentChanged: true,
    content: imageContent,
    assetReferences: [{ assetId, blockId: "block_asset_smoke", mediaType: "image/png" }],
  });
  assert.equal(first.durableSeq, 1);

  const namedVersion = await repository.createVersion({
    tenantId: principal.tenantId,
    documentId,
    identityId: principal.identityId,
    name: `Asset reference ${token}`,
    expectedGenerationId: document.generationId,
    expectedDurableSeq: first.durableSeq,
  });
  assert.equal(namedVersion.status, "created");
  if (namedVersion.status !== "created") throw new Error("Failed to create the fixture version");

  const second = await repository.persistUpdate({
    documentId,
    generationId: document.generationId,
    tenantId: principal.tenantId,
    subjectId: principal.identityId,
    updateHash: `asset-reference-${token}-2`,
    updateBytes: new Uint8Array([2]),
    contentChanged: true,
    content: imageContent,
    assetReferences: [{ assetId, blockId: "block_asset_smoke", mediaType: "image/png" }],
  });
  assert.equal(second.durableSeq, 2);
  const historicalReference = await app.db
    .select({ durableSeq: assetReferences.durableSeq })
    .from(assetReferences)
    .where(
      and(
        eq(assetReferences.documentId, documentId),
        eq(assetReferences.generationId, document.generationId),
        eq(assetReferences.durableSeq, first.durableSeq),
      ),
    );
  assert.equal(historicalReference.length, 1, "A saved version must retain its asset reference");

  const restored = await repository.restoreVersion({
    tenantId: principal.tenantId,
    documentId,
    versionId: namedVersion.version.id,
    identityId: principal.identityId,
    expectedGenerationId: document.generationId,
    expectedDurableSeq: second.durableSeq,
    content: imageContent,
    stateBytes: versionStateBytes,
  });
  assert.equal(restored.status, "restored");
  if (restored.status !== "restored") throw new Error("Failed to restore the fixture version");
  const newGenerationId = restored.document.generationId;
  const restoredReference = await app.db
    .select({ durableSeq: assetReferences.durableSeq })
    .from(assetReferences)
    .where(
      and(
        eq(assetReferences.documentId, documentId),
        eq(assetReferences.generationId, newGenerationId),
        eq(assetReferences.durableSeq, first.durableSeq),
      ),
    );
  assert.equal(
    restoredReference.length,
    1,
    "A restored generation must inherit its asset reference",
  );

  await assert.rejects(
    repository.persistUpdate({
      documentId,
      generationId: newGenerationId,
      tenantId: principal.tenantId,
      subjectId: principal.identityId,
      updateHash: `asset-reference-${token}-invalid`,
      updateBytes: new Uint8Array([3]),
      contentChanged: true,
      content: {
        type: "doc",
        content: [
          {
            type: "image",
            attrs: {
              assetId: `asset_missing_${token}`,
              mediaType: "image/png",
              alt: "missing",
              blockId: "block_missing_asset",
            },
          },
        ],
      },
      assetReferences: [
        {
          assetId: `asset_missing_${token}`,
          blockId: "block_missing_asset",
          mediaType: "image/png",
        },
      ],
    }),
    /unavailable or foreign asset/,
  );
  const [unchangedGeneration] = await app.db
    .select({ durableSeq: documentGenerations.durableSeq })
    .from(documentGenerations)
    .where(eq(documentGenerations.id, newGenerationId));
  assert.equal(
    unchangedGeneration?.durableSeq,
    first.durableSeq,
    "A rejected ref must roll back the sequence",
  );

  await repository.persistUpdate({
    documentId,
    generationId: newGenerationId,
    tenantId: principal.tenantId,
    subjectId: principal.identityId,
    updateHash: `asset-reference-${token}-3`,
    updateBytes: new Uint8Array([4]),
    contentChanged: true,
    content: { type: "doc", content: [] },
    assetReferences: [],
  });
  const removedReference = await app.db
    .select({ assetId: assetReferences.assetId })
    .from(assetReferences)
    .where(
      and(
        eq(assetReferences.documentId, documentId),
        eq(assetReferences.generationId, newGenerationId),
      ),
    );
  assert.equal(
    removedReference.length,
    0,
    "Removed current content must release its asset reference",
  );
  console.log(
    "Asset reference persistence, version retention, restore, rollback, and pruning passed.",
  );
} finally {
  if (assetId) await app.db.delete(assets).where(eq(assets.id, assetId));
  if (documentId) await app.db.delete(documents).where(eq(documents.id, documentId));
  await app.close();
}
