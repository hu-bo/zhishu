import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap";
import { createEditorSchema } from "@zhishu/editor-core/schema";
import {
  CALLOUT_DOCUMENT_SCHEMA_VERSION,
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  MENTION_DOCUMENT_SCHEMA_VERSION,
  validateDocumentContentForSchemaVersion,
  type DocumentContent,
} from "@zhishu/document-contracts";
import type { Database } from "../../../database/index.js";
import * as schema from "../../../database/schema/index.js";
import { loadConfig } from "../../config.js";
import { stableJsonStringify } from "../../shared/stable-json.js";
import type { Principal } from "../identity/identity.types.js";
import {
  createCollaborationStateFromContent,
  readDocumentContent,
} from "../collaboration/document-state.js";
import {
  applyStructuredOperation,
  readStoredStructureState,
  sameDocumentContent,
} from "../collaboration/structure-operations.js";
import {
  collectAssetReferences,
  inspectDocumentContent,
  summarizeDocumentContent,
} from "./document-content.js";
import { createDocumentService } from "./index.js";
import { DocumentRepository } from "./document.repository.js";
import { DocumentHistoryRepository } from "./document-history.repository.js";
import { DocumentProjectionRepository } from "./document-projection.repository.js";

const content: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block_paragraph1" },
      content: [{ type: "text", text: "知书🙂" }],
    },
  ],
};

test("LaTeX nodes round-trip through collaborative state and require schema v7", () => {
  const formulas: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_with_formula" },
        content: [
          { type: "text", text: "面积 " },
          { type: "inlineMath", attrs: { latex: "A=\\pi r^2" } },
        ],
      },
      { type: "blockMath", attrs: { blockId: "block_formula", latex: "\\frac{a}{b}" } },
    ],
  };
  assert.equal(
    validateDocumentContentForSchemaVersion(formulas, MENTION_DOCUMENT_SCHEMA_VERSION).success,
    false,
  );
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, createCollaborationStateFromContent(formulas));
    assert.deepEqual(readDocumentContent(document), formulas);
    assert.deepEqual(readStoredStructureState(document)?.content, formulas);
  } finally {
    document.destroy();
  }
});

test("inserting a block formula preserves its empty continuation paragraph in the structure projection", () => {
  const initial: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_trigger" },
        content: [{ type: "text", text: "/latex" }],
      },
    ],
  };
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, createCollaborationStateFromContent(initial));
    const state = readStoredStructureState(document);
    assert.ok(state);
    const applied = applyStructuredOperation(state, {
      requestHash: "test-formula",
      baseRevision: state.revision,
      documentId: "doc_formula",
      generationId: "gen_formula",
      batch: {
        origin: "user",
        documentId: "doc_formula",
        generationId: "gen_formula",
        operationId: "op_formula",
        operations: [
          {
            type: "replace-block",
            targetBlockId: "block_trigger",
            block: { type: "blockMath", attrs: { blockId: "block_trigger", latex: "x^2" } },
          },
          {
            type: "insert-block",
            parentBlockId: null,
            afterBlockId: "block_trigger",
            block: { type: "paragraph", attrs: { blockId: "block_continuation" } },
          },
        ],
      },
    });
    assert.equal(applied.result.status, "accepted");
    prosemirrorJSONToYXmlFragment(
      createEditorSchema({ collaborative: true }),
      applied.state.content,
      document.getXmlFragment("content"),
    );
    const body = readDocumentContent(document) as DocumentContent;
    assert.deepEqual(body.content[1], {
      type: "paragraph",
      attrs: { blockId: "block_continuation" },
      content: [],
    });
    assert.ok(sameDocumentContent(body, applied.state.content));
  } finally {
    document.destroy();
  }
});

test("content inspection preserves ordered diagnostics, reverse durable references and fingerprints", () => {
  const withAssets = {
    type: "doc",
    content: [
      content.content[0],
      {
        type: "callout",
        attrs: { blockId: "outer" },
        content: [
          {
            type: "image",
            attrs: { blockId: "image", assetId: "asset_image", mediaType: "image/png" },
          },
          {
            type: "pdfAttachment",
            attrs: { blockId: "pdf", assetId: "asset_pdf", mediaType: "application/pdf" },
          },
        ],
      },
      { type: "image", attrs: { blockId: "invalid" } },
    ],
  } as DocumentContent;
  assert.deepEqual(summarizeDocumentContent(withAssets), {
    blockCount: 5,
    textLength: 3,
    assetCount: 3,
  });
  assert.deepEqual(inspectDocumentContent(withAssets).assetPaths, [
    "$/content/1/content/0/attrs",
    "$/content/1/content/1/attrs",
    "$/content/2/attrs",
  ]);
  assert.deepEqual(
    collectAssetReferences(withAssets).map(({ blockId }) => blockId),
    ["pdf", "image"],
  );
  assert.equal(
    stableJsonStringify({ b: 2, a: [{ d: 4, c: 3 }] }),
    stableJsonStringify({ a: [{ c: 3, d: 4 }], b: 2 }),
  );
  assert.notEqual(stableJsonStringify([1, 2]), stableJsonStringify([2, 1]));
  assert.deepEqual(inspectDocumentContent([null, { type: "image", attrs: null }]).assetPaths, [
    "$/1/attrs",
  ]);
});

test(
  "document history, projection and generation migration retain their persistence invariants",
  { timeout: 120_000 },
  async (t) => {
    const memory = new PGlite();
    try {
      const journal = JSON.parse(
        await readFile("database/migrations/meta/_journal.json", "utf8"),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries)
        await memory.exec(await readFile(`database/migrations/${tag}.sql`, "utf8"));
      const db = drizzle(memory, { schema }) as unknown as Database;
      const principal: Principal = {
        tenantId: "persistence",
        identityId: "owner",
        username: "owner",
        displayName: "Owner",
        email: "owner@example.test",
        active: true,
        globalRoles: [],
      };
      await db.insert(schema.identityProfiles).values({ ...principal });
      await db.insert(schema.workspaces).values({
        tenantId: principal.tenantId,
        id: "ws_persistence",
        name: "Persistence",
        kind: "personal",
        personalOwnerId: principal.identityId,
        ownerIdentityId: principal.identityId,
        createdBy: principal.identityId,
      });
      const documents = new DocumentRepository(db);
      const history = new DocumentHistoryRepository(db);
      const projection = new DocumentProjectionRepository(db);
      const bytes = createCollaborationStateFromContent(content);
      const checksum = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
      const create = (schemaVersion: number = CURRENT_DOCUMENT_SCHEMA_VERSION) =>
        documents.create(
          principal.tenantId,
          principal.identityId,
          "Persistence",
          { schemaVersion, extensions: [] },
          undefined,
          100,
          { updateBytes: bytes, updateHash: checksum(bytes), content },
          undefined,
          undefined,
          undefined,
          { workspaceId: "ws_persistence", catalogId: null },
        );

      await t.test(
        "schema migration writes a new generation whose body and structural state agree",
        async () => {
          const original = await create(CALLOUT_DOCUMENT_SCHEMA_VERSION);
          const revoked: string[] = [];
          const service = createDocumentService(
            db,
            loadConfig({
              NODE_ENV: "test",
              AUTH_MODE: "external",
              DATABASE_URL: "postgresql://unused/test",
              LOG_LEVEL: "silent",
            }),
            {
              revokeDocumentSessions: (_documentId, generationId) => {
                revoked.push(generationId);
              },
            },
          );
          const session = await service.createCollaborationSession(principal, original.id, {
            schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
            extensions: [],
          });
          assert.notEqual(session.generationId, original.generationId);
          assert.equal(session.schemaVersion, CURRENT_DOCUMENT_SCHEMA_VERSION);
          assert.deepEqual(revoked, [original.generationId]);
          const stored = await documents.findActiveForAction(
            original.id,
            principal.tenantId,
            principal.identityId,
            "read",
          );
          assert.ok(stored);
          const document = new Y.Doc();
          try {
            await history.replayYjsState(
              {
                documentId: stored.id,
                generationId: stored.generationId,
                targetSeq: stored.durableSeq,
              },
              (update) => Y.applyUpdate(document, update),
            );
            const body = readDocumentContent(document);
            const structure = readStoredStructureState(document);
            assert.ok(structure);
            assert.ok(sameDocumentContent(structure.content, body as DocumentContent));
            assert.ok(sameDocumentContent(structure.content, content));
            assert.equal(structure.content.content[0]?.attrs?.blockId, "block_paragraph1");
          } finally {
            document.destroy();
          }
        },
      );

      await t.test(
        "compaction protects version snapshots and validates replay checksums and gaps",
        async () => {
          const created = await create();
          const version = await documents.createVersion({
            tenantId: principal.tenantId,
            identityId: principal.identityId,
            documentId: created.id,
            name: "Checkpoint",
            expectedGenerationId: created.generationId,
            expectedDurableSeq: 1,
          });
          assert.ok(version.status === "created");
          assert.deepEqual(await history.listVersionsNeedingCheckpoint(created.generationId, 1), [
            { versionId: version.version.id, durableSeq: 1 },
          ]);
          const input = {
            documentId: created.id,
            generationId: created.generationId,
            durableSeq: 1,
            stateBytes: bytes,
            versionCheckpoints: [],
          };
          assert.equal((await history.commitYjsCheckpoints(input)).status, "stale");
          const compacted = await history.commitYjsCheckpoints({
            ...input,
            versionCheckpoints: [
              { versionId: version.version.id, durableSeq: 1, stateBytes: bytes },
            ],
          });
          assert.ok(compacted.status === "compacted");
          assert.equal(compacted.prunedUpdates, 1);
          assert.equal(compacted.versionSnapshots, 1);
          assert.deepEqual(
            await history.findUpdateReceipt(created.id, created.generationId, checksum(bytes)),
            { durableSeq: 1 },
          );
          await assert.rejects(
            history.loadUpdates(created.id, created.generationId),
            /Compacted Yjs history/,
          );
          for (const versionId of [undefined, version.version.id]) {
            const document = new Y.Doc();
            try {
              await history.replayYjsState(
                {
                  documentId: created.id,
                  generationId: created.generationId,
                  targetSeq: 1,
                  versionId,
                },
                (update) => Y.applyUpdate(document, update),
              );
              assert.ok(sameDocumentContent(readStoredStructureState(document)!.content, content));
            } finally {
              document.destroy();
            }
          }
          const scope = and(
            eq(schema.documentGenerationCheckpoints.documentId, created.id),
            eq(schema.documentGenerationCheckpoints.generationId, created.generationId),
          );
          await db
            .update(schema.documentGenerationCheckpoints)
            .set({ stateHash: "corrupt" })
            .where(scope);
          const replay = () =>
            history.replayYjsState(
              { documentId: created.id, generationId: created.generationId, targetSeq: 1 },
              () => {},
            );
          await assert.rejects(replay(), /checksum/);
          await db.delete(schema.documentGenerationCheckpoints).where(scope);
          await assert.rejects(replay(), /incomplete/);
        },
      );

      await t.test(
        "projection leases reject stale workers and late snapshots never overwrite newer content",
        async () => {
          const created = await create();
          const now = new Date(Date.now() + 1_000);
          const first = await projection.claimProjectionJob(now, created.id);
          assert.ok(first);
          assert.equal(await projection.claimProjectionJob(now, created.id), null);
          const later = new Date(now.getTime() + 31_000);
          const replacement = await projection.claimProjectionJob(later, created.id);
          assert.ok(replacement);
          assert.notEqual(first.leaseToken, replacement.leaseToken);
          assert.equal(await projection.processProjectionJob(first), false);
          assert.equal(await projection.failProjectionJob(first), "stale");
          assert.equal(await projection.processProjectionJob(replacement), true);
          const snapshot = {
            tenantId: principal.tenantId,
            documentId: created.id,
            generationId: created.generationId,
            durableSeq: 1,
            content,
          };
          assert.equal(await projection.backfillProjectionSnapshot(snapshot), false);
          const update = {
            ...snapshot,
            subjectId: principal.identityId,
            contentChanged: false,
            updateHash: "second",
            updateBytes: bytes,
          };
          assert.equal((await documents.persistUpdate(update)).durableSeq, 2);
          assert.equal((await documents.persistUpdate(update)).duplicate, true);
          const newest = await projection.claimProjectionJob(later, created.id);
          assert.ok(newest);
          assert.equal(newest.durableSeq, 2);
          assert.equal(await projection.failProjectionJob(newest, "transient", later), "retry");
          assert.equal(await projection.claimProjectionJob(later, created.id), null);
          const retry = await projection.claimProjectionJob(
            new Date(later.getTime() + 5_000),
            created.id,
          );
          assert.ok(retry);
          assert.equal(await projection.processProjectionJob(retry), true);
          assert.equal(await projection.backfillProjectionSnapshot(snapshot), false);
          assert.equal(
            (
              await documents.findProjectionContentSnapshot(
                principal.tenantId,
                created.id,
                created.generationId,
              )
            )?.durableSeq,
            2,
          );
          assert.deepEqual(await projection.getProjectionQueueStatus(created.id), {
            pending: 0,
            processing: 0,
            dead: 0,
          });
        },
      );
    } finally {
      await memory.close();
    }
  },
);
