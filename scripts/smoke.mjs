import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { sql } from "../apps/app-server/dist/database/index.js";
import { buildApp } from "../apps/app-server/dist/src/app.js";
import { loadConfig } from "../apps/app-server/dist/src/config.js";

// Use a disposable database: this check creates and removes a project and document.
assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable database");
const app = await buildApp(
  loadConfig({ ...process.env, NODE_ENV: "test", AUTH_MODE: "mock", LOG_LEVEL: "silent" }),
  {
    sessionRevoker: {
      revokeDocumentSessions(documentId, generationId) {
        revokedSessions.push({ documentId, generationId });
      },
    },
  },
);
const revokedSessions = [];
let qaConversationId;
let documentId;
let copiedDocumentId;
let authorization;
let externalApp;
try {
  await app.ready();
  for (const url of ["/health/live", "/health/ready", "/documentation/json"]) {
    assert.equal((await app.inject({ url })).statusCode, 200, url);
  }
  assert.equal((await app.inject({ url: "/api/ai/qa/capabilities" })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/auth/mock/login" });
  assert.equal(login.statusCode, 200);
  authorization = { authorization: `Bearer ${login.json().accessToken}` };
  const currentUser = await app.inject({ url: "/api/auth/me", headers: authorization });
  assert.equal(currentUser.statusCode, 200);
  assert.equal(currentUser.json().identityId, "mock-user-001");
  assert.equal(currentUser.json().tenantId, "local");
  // Retired legacy AI routes must be gone (404), replaced by the two purpose namespaces.
  for (const legacy of [
    "/api/ai/chat",
    "/api/ai/authoring",
    "/api/writing/conversations",
    "/api/projects/",
  ]) {
    const response = await app.inject({ method: "GET", url: legacy, headers: authorization });
    assert.equal(response.statusCode, 404, `legacy ${legacy} should be retired`);
  }
  const qaCapabilities = await app.inject({
    url: "/api/ai/qa/capabilities",
    headers: authorization,
  });
  assert.equal(qaCapabilities.statusCode, 200);
  assert.equal(typeof qaCapabilities.json().enabled, "boolean");
  const writingCapabilities = await app.inject({
    url: "/api/ai/writing/capabilities",
    headers: authorization,
  });
  assert.equal(writingCapabilities.statusCode, 200);
  assert.equal(writingCapabilities.json().engine, "dsh-native-v1");
  // A qa conversation may be created and listed even before the model is configured.
  const qaConversation = await app.inject({
    method: "POST",
    url: "/api/ai/qa/conversations",
    headers: authorization,
    payload: {},
  });
  assert.equal(qaConversation.statusCode, 201);
  qaConversationId = qaConversation.json().id;
  assert.equal(qaConversation.json().purpose, "qa");
  const qaList = await app.inject({ url: "/api/ai/qa/conversations", headers: authorization });
  assert.ok(qaList.json().some((item) => item.id === qaConversationId));

  const document = await app.inject({
    method: "POST",
    url: "/api/documents/",
    headers: authorization,
    payload: { title: "Access control smoke" },
  });
  assert.equal(document.statusCode, 201);
  documentId = document.json().id;
  const recentDocuments = await app.inject({
    url: "/api/documents/?view=recent",
    headers: authorization,
  });
  assert.equal(recentDocuments.statusCode, 200);
  assert.ok(recentDocuments.json().items.some((item) => item.id === documentId));
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/favorite`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  const favorites = await app.inject({
    url: "/api/documents/?view=favorites",
    headers: authorization,
  });
  assert.ok(favorites.json().items.some((item) => item.id === documentId && item.isFavorite));
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/documents/${documentId}`,
    headers: authorization,
    payload: { title: "Renamed document", metadataRevision: 1 },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().metadataRevision, 2);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/documents/${documentId}`,
        headers: authorization,
        payload: { title: "Stale rename", metadataRevision: 1 },
      })
    ).statusCode,
    409,
  );
  const copied = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}/copy`,
    headers: authorization,
    payload: { title: "Template copy" },
  });
  assert.equal(copied.statusCode, 201, copied.body);
  copiedDocumentId = copied.json().id;
  assert.notEqual(copiedDocumentId, documentId);
  assert.notEqual(copied.json().generationId, document.json().generationId);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/archive`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  const archived = await app.inject({
    url: "/api/documents/?view=archived",
    headers: authorization,
  });
  assert.ok(archived.json().items.some((item) => item.id === documentId));
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/restore`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/documents/${documentId}`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  const trash = await app.inject({ url: "/api/documents/?view=trash", headers: authorization });
  const trashedDocument = trash.json().items.find((item) => item.id === documentId);
  assert.ok(trashedDocument);
  assert.equal(typeof trashedDocument.deletedAt, "string");
  assert.ok(Number.isFinite(Date.parse(trashedDocument.deletedAt)));
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/restore`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  const restoredDocuments = await app.inject({
    url: "/api/documents/?view=mine",
    headers: authorization,
  });
  assert.equal(
    restoredDocuments.json().items.find((item) => item.id === documentId)?.deletedAt,
    null,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/documents/${copiedDocumentId}`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/documents/${copiedDocumentId}/permanent`,
        headers: authorization,
      })
    ).statusCode,
    204,
  );
  copiedDocumentId = undefined;
  const beforeVersion = await app.inject({
    url: `/api/documents/${documentId}`,
    headers: authorization,
  });
  const namedVersion = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}/versions`,
    headers: authorization,
    payload: {
      name: "Baseline",
      expectedGenerationId: beforeVersion.json().generationId,
      expectedDurableSeq: beforeVersion.json().durableSeq,
    },
  });
  assert.equal(namedVersion.statusCode, 201, namedVersion.body);
  assert.equal(namedVersion.json().durableSeq, 0);
  assert.equal(
    (
      await app.inject({ url: `/api/documents/${documentId}/versions`, headers: authorization })
    ).json().length,
    1,
  );
  const restoredVersion = await app.inject({
    method: "POST",
    url: `/api/documents/${documentId}/versions/${namedVersion.json().id}/restore`,
    headers: authorization,
    payload: {
      expectedGenerationId: beforeVersion.json().generationId,
      expectedDurableSeq: beforeVersion.json().durableSeq,
    },
  });
  assert.equal(restoredVersion.statusCode, 200);
  assert.notEqual(restoredVersion.json().generationId, beforeVersion.json().generationId);
  assert.equal(restoredVersion.json().durableSeq, namedVersion.json().durableSeq);
  assert.ok(
    revokedSessions.some(
      (entry) =>
        entry.documentId === documentId && entry.generationId === beforeVersion.json().generationId,
    ),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/versions/${namedVersion.json().id}/restore`,
        headers: authorization,
        payload: {
          expectedGenerationId: beforeVersion.json().generationId,
          expectedDurableSeq: beforeVersion.json().durableSeq,
        },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ url: `/api/documents/${documentId}`, headers: authorization })).statusCode,
    200,
  );
  const reader = {
    identityId: "reader-001",
    tenantId: "local",
    username: "reader",
    displayName: "Reader",
    email: "reader@example.test",
    globalRoles: ["user"],
    active: true,
  };
  const foreignReader = { ...reader, tenantId: "foreign" };
  const externalPrincipals = new Map([
    ["reader-token", reader],
    ["foreign-token", foreignReader],
  ]);
  externalApp = await buildApp(
    loadConfig({ ...process.env, NODE_ENV: "test", AUTH_MODE: "external", LOG_LEVEL: "silent" }),
    {
      identityAuthenticator: {
        authenticate(header) {
          const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "")?.[1];
          return token ? (externalPrincipals.get(token) ?? null) : null;
        },
      },
    },
  );
  assert.equal(
    (
      await externalApp.inject({
        url: `/api/documents/${documentId}`,
        headers: { authorization: "Bearer reader-token" },
      })
    ).statusCode,
    404,
  );
  const readGrant = await app.inject({
    method: "PUT",
    url: `/api/documents/${documentId}/acl/reader-001`,
    headers: authorization,
    payload: { actions: ["read"] },
  });
  assert.equal(readGrant.statusCode, 200);
  assert.deepEqual(readGrant.json().actions, ["read"]);
  assert.equal(
    (
      await externalApp.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/acl/another-user`,
        headers: { authorization: "Bearer reader-token" },
        payload: { actions: ["read"] },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await externalApp.inject({
        url: `/api/documents/${documentId}`,
        headers: { authorization: "Bearer reader-token" },
      })
    ).statusCode,
    200,
  );
  const readOnlySession = await externalApp.inject({
    url: `/api/documents/${documentId}/collaboration-session`,
    method: "POST",
    headers: { authorization: "Bearer reader-token" },
    payload: { schemaVersion: 1, extensions: [] },
  });
  assert.equal(readOnlySession.statusCode, 201);
  assert.equal(readOnlySession.json().readOnly, true);
  assert.deepEqual(readOnlySession.json().compatibility, { readable: true, writable: false });
  assert.equal(
    (
      await externalApp.inject({
        url: `/api/documents/${documentId}`,
        headers: { authorization: "Bearer foreign-token" },
      })
    ).statusCode,
    404,
  );
  const writeGrant = await app.inject({
    method: "PUT",
    url: `/api/documents/${documentId}/acl/reader-001`,
    headers: authorization,
    payload: { actions: ["read", "write"] },
  });
  assert.equal(writeGrant.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/acl/reader-001`,
        headers: authorization,
        payload: { actions: ["read", "read"] },
      })
    ).statusCode,
    400,
  );
  const readerSession = await externalApp.inject({
    method: "POST",
    url: `/api/documents/${documentId}/collaboration-session`,
    headers: { authorization: "Bearer reader-token" },
    payload: { schemaVersion: 1, extensions: [] },
  });
  assert.equal(readerSession.statusCode, 201);
  assert.equal(readerSession.json().readOnly, false);
  const removedGrant = await app.inject({
    method: "DELETE",
    url: `/api/documents/${documentId}/acl/reader-001`,
    headers: authorization,
  });
  assert.equal(removedGrant.statusCode, 204);
  assert.ok(
    revokedSessions.some(
      (entry) =>
        entry.documentId === documentId && entry.generationId === readerSession.json().generationId,
    ),
  );
  assert.equal(
    (
      await externalApp.inject({
        url: `/api/documents/${documentId}`,
        headers: { authorization: "Bearer reader-token" },
      })
    ).statusCode,
    404,
  );

  assert.equal(
    (await app.inject({ method: "POST", url: "/api/auth/logout", headers: authorization }))
      .statusCode,
    204,
  );
  assert.equal((await app.inject({ url: "/api/auth/me", headers: authorization })).statusCode, 401);
  assert.equal((await app.inject({ url: "/missing" })).json().code, "NOT_FOUND");
  console.log(
    "Smoke passed: health, auth modes, tenant-scoped ACL, document lifecycle/versions, CRUD, validation, and OpenAPI.",
  );
} finally {
  try {
    if (externalApp) await externalApp.close();

    if (copiedDocumentId)
      await app.db.execute(sql`delete from documents where id = ${copiedDocumentId}`);
    if (documentId) await app.db.execute(sql`delete from documents where id = ${documentId}`);
  } finally {
    await app.close();
  }
}
