import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  CALLOUT_DOCUMENT_SCHEMA_VERSION,
  collectDocumentMentions,
  validateDocumentContent,
  validateDocumentContentForSchemaVersion,
  type DocumentContent,
} from "@zhishu/document-contracts";
import {
  createEditorSchema,
  validateContentForEditor,
  calculateDocumentStatistics,
  exportDocumentMarkdown,
  exportPlainText,
} from "@zhishu/editor-core";
import { AssetRepository } from "../modules/assets/asset.repository.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createDatabase, createPool } from "../../database/index.js";
import {
  assets,
  documents,
  documentGenerations,
  workspaceInvitations,
} from "../../database/schema/index.js";
import {
  DocumentRepository,
  DocumentProjectionRepository,
  AiDocumentAccess,
  createCollaborationStateFromContent,
} from "../modules/documents/index.js";
import type { Principal } from "../modules/identity/identity.types.js";

const mentionFixture: DocumentContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "block_mention_fixture" },
      content: [{ type: "mention", attrs: { identityId: "viewer", label: "林小知" } }],
    },
  ],
};
assert.equal(CURRENT_DOCUMENT_SCHEMA_VERSION, 6);
assert.ok(validateDocumentContent(mentionFixture).success);
assert.ok(validateContentForEditor(mentionFixture, createEditorSchema()).success);
assert.equal(
  validateDocumentContentForSchemaVersion(mentionFixture, CALLOUT_DOCUMENT_SCHEMA_VERSION).success,
  false,
);
assert.equal(
  validateDocumentContent({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_invalid_mention" },
        content: [{ type: "mention", attrs: { label: "伪造" } }],
      },
    ],
  }).success,
  false,
);
assert.equal(collectDocumentMentions(mentionFixture).length, 1);
const mentionMarkdown = exportDocumentMarkdown(mentionFixture);
assert.ok(
  mentionMarkdown.success &&
    mentionMarkdown.value.includes("@林小知") &&
    mentionMarkdown.report.degraded.some((issue) => issue.code === "markdown-mention"),
);
const mentionText = exportPlainText(mentionFixture);
assert.ok(mentionText.success && mentionText.value.includes("@林小知"));
assert.equal(calculateDocumentStatistics(mentionFixture).characterCount, 4);

assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable smoke/test database");
assert.match(new URL(process.env.DATABASE_URL).pathname, /(?:smoke|test|qa)/u);
const pool = createPool({ connectionString: process.env.DATABASE_URL });
try {
  await migrate(createDatabase(pool), { migrationsFolder: "database/migrations" });
} finally {
  await pool.end();
}
const tenantId = `community-smoke-${randomUUID()}`;
const identities = new Map<string, Principal>(
  ["owner", "admin", "editor", "viewer", "guest", "guest2", "other"].map((id) => [
    id,
    {
      identityId: id,
      tenantId: id === "other" ? `${tenantId}-other` : tenantId,
      username: id,
      displayName: id === "viewer" ? "林小知" : id,
      email: `${id}@example.test`,
      active: true,
      globalRoles: [],
    },
  ]),
);
const revoked: string[] = [];
const app = await buildApp(
  loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "external",
    LOG_LEVEL: "silent",
    DATABASE_URL: process.env.DATABASE_URL,
  }),
  {
    identityAuthenticator: {
      authenticate: (authorization) =>
        identities.get(authorization?.replace(/^Bearer /u, "") ?? "") ?? null,
    },
    sessionRevoker: {
      revokeDocumentSessions: (id) => {
        revoked.push(id);
      },
    },
  },
);
let checks = 0;
async function call(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: object,
  status = 200,
  identity = "owner",
) {
  const result = await app.inject({
    method,
    url: `/api${url}`,
    headers: identity ? { authorization: `Bearer ${identity}` } : {},
    ...(payload ? { payload } : {}),
  });
  assert.equal(result.statusCode, status, `${method} ${url} (${identity}): ${result.body}`);
  checks++;
  return result;
}
const listNotifications = async (identity: string) =>
  (await call("GET", "/notifications?limit=50", undefined, 200, identity)).json<{
    items: {
      id: string;
      type: string;
      message: string;
      documentId: string | null;
      available: boolean;
      readAt: string | null;
    }[];
    unreadCount: number;
    nextCursor: string | null;
  }>();
try {
  for (const id of identities.keys()) await call("GET", "/auth/me", undefined, 200, id);
  await call("GET", "/notifications", undefined, 401, "");
  const team = (
    await call("POST", "/knowledge/workspaces", { name: "权限与协作验收", kind: "team" }, 201)
  ).json<{ id: string; rootCatalogId: string }>();
  const personal = (
    await call("POST", "/knowledge/workspaces", { name: "个人", kind: "personal" }, 201)
  ).json<{ id: string; rootCatalogId: string }>();
  for (const role of ["admin", "editor", "viewer"])
    await call("PUT", `/knowledge/workspaces/${team.id}/members/${role}`, {
      role,
      displayName: "untrusted name",
    });
  const members = (await call("GET", `/knowledge/workspaces/${team.id}/members`)).json<
    { identityId: string; displayName: string; email: string }[]
  >();
  assert.equal(members.find((m) => m.identityId === "viewer")?.displayName, "林小知");
  assert.equal(members.find((m) => m.identityId === "viewer")?.email, "viewer@example.test");
  await call("GET", `/knowledge/workspaces/${team.id}/members`, undefined, 404, "guest");
  await call(
    "PUT",
    `/knowledge/workspaces/${team.id}/members/ghost`,
    { role: "viewer", displayName: "ghost" },
    400,
  );
  await call(
    "PUT",
    `/knowledge/workspaces/${personal.id}/members/viewer`,
    { role: "viewer", displayName: "viewer" },
    400,
  );
  const directory = (await call("GET", "/auth/directory?q=viewer%40example.test")).json<
    { identityId: string }[]
  >();
  assert.deepEqual(
    directory.map((i) => i.identityId),
    ["viewer"],
  );
  assert.equal(
    (await call("GET", "/auth/directory?q=%E6%9E%97%E5%B0%8F%E7%9F%A5")).json<unknown[]>().length,
    1,
  );
  const doc = (
    await call("POST", "/documents/", { title: "继承权限验收", workspaceId: team.id }, 201)
  ).json<{ id: string; generationId: string; accessMode: string; metadataRevision: number }>();
  assert.equal(doc.accessMode, "workspace-inherited");
  const pd = (
    await call("POST", "/documents/", { title: "个人文档", workspaceId: personal.id }, 201)
  ).json<{ id: string; accessMode: string }>();
  assert.equal(pd.accessMode, "personal");
  const assetRepository = new AssetRepository(app.db);
  const asset = await assetRepository.createUpload({
    principal: identities.get("editor")!,
    documentId: doc.id,
    objectKey: `test/${randomUUID()}`,
    file: { fileName: "image.png", mediaType: "image/png", size: 1024 },
    maxBytes: 2048,
    maxTenantBytes: 10_000_000,
    expiresAt: new Date(Date.now() + 3600000),
  });
  assert.ok(asset, "Inherited editors can upload document assets");
  assert.ok(await assetRepository.getForAction(identities.get("viewer")!, asset.id, "read"));
  assert.equal(
    await assetRepository.getForAction(identities.get("viewer")!, asset.id, "write"),
    null,
  );
  assert.equal(
    await assetRepository.getForAction(identities.get("other")!, asset.id, "read"),
    null,
  );
  const path = `/documents/${doc.id}`;
  const session = `${path}/collaboration-session`;
  for (const id of ["owner", "admin", "editor", "viewer"])
    await call("GET", path, undefined, 200, id);
  assert.equal(
    (await call("GET", path, undefined, 200, "admin")).json<{ canManage: boolean }>().canManage,
    true,
  );
  await call("GET", path, undefined, 404, "guest");
  await call("GET", path, undefined, 404, "other");
  assert.equal(
    (await call("POST", session, {}, 201, "viewer")).json<{ readOnly: boolean }>().readOnly,
    true,
  );
  assert.equal(
    (await call("POST", session, {}, 201, "editor")).json<{ readOnly: boolean }>().readOnly,
    false,
  );
  await call(
    "PATCH",
    path,
    { title: "继承权限验收更新", metadataRevision: doc.metadataRevision },
    200,
    "editor",
  );
  let head = (await call("GET", path)).json<{ metadataRevision: number }>();
  await call(
    "PATCH",
    `${path}/access`,
    { accessMode: "personal", metadataRevision: head.metadataRevision },
    400,
  );
  await call(
    "PATCH",
    `${path}/access`,
    { accessMode: "restricted", metadataRevision: head.metadataRevision - 1 },
    409,
  );
  await call("PATCH", `${path}/access`, {
    accessMode: "restricted",
    metadataRevision: head.metadataRevision,
  });
  for (const id of ["admin", "editor", "viewer"]) await call("GET", path, undefined, 404, id);
  await call("POST", session, {}, 404, "viewer");
  const hidden = (
    await call("GET", `/documents?view=all&workspaceId=${team.id}`, undefined, 200, "viewer")
  ).json<{ items: { id: string }[] }>();
  assert.ok(!hidden.items.some((item) => item.id === doc.id));
  const searchHidden = (
    await call(
      "GET",
      `/knowledge/search?q=${encodeURIComponent("继承权限")}`,
      undefined,
      200,
      "viewer",
    )
  ).json<{ items: unknown[] }>();
  assert.equal(searchHidden.items.length, 0);
  const acl = `${path}/acl/viewer`;
  await call("PUT", acl, { actions: ["read"] });
  const granted = (await call("GET", `${path}/acl`)).json<
    { identityId: string; grantedAt: string }[]
  >();
  assert.ok(granted[0]?.grantedAt);
  await call("PUT", acl, { actions: ["read", "comment"] });
  const changed = (await call("GET", `${path}/acl`)).json<
    { identityId: string; grantedAt: string }[]
  >();
  assert.equal(changed[0]?.grantedAt, granted[0]?.grantedAt);
  const countBefore = (await listNotifications("viewer")).items.length;
  await call("PUT", acl, { actions: ["comment", "read"] });
  assert.equal((await listNotifications("viewer")).items.length, countBefore);
  const commentId = randomUUID();
  await call(
    "POST",
    `${path}/comments`,
    { id: commentId, body: "评论 @owner", mentionIds: ["owner"] },
    201,
    "viewer",
  );
  await call(
    "POST",
    `${path}/comments`,
    { id: commentId, body: "评论 @owner", mentionIds: ["owner"] },
    201,
    "viewer",
  );
  assert.equal(
    (await listNotifications("owner")).items.filter((n) => n.type === "mention").length,
    1,
  );
  await call(
    "POST",
    `${path}/comments`,
    { id: randomUUID(), body: "不能提及无权限用户", mentionIds: ["guest"] },
    400,
    "viewer",
  );
  await call("POST", `${path}/comments`, { id: randomUUID(), body: "普通评论" }, 201);
  assert.ok((await listNotifications("viewer")).items.some((n) => n.type === "comment"));
  await call("DELETE", `${path}/comments/${commentId}`, undefined, 404, "guest");
  await call("DELETE", `${path}/comments/${commentId}`, undefined, 204, "viewer");
  await call("DELETE", acl, undefined, 204);
  await call("GET", path, undefined, 404, "viewer");
  head = (await call("GET", path)).json<{ metadataRevision: number }>();
  await call("PATCH", `${path}/access`, {
    accessMode: "workspace-inherited",
    metadataRevision: head.metadataRevision,
  });
  await call("GET", path, undefined, 200, "viewer");
  const ai = new AiDocumentAccess(app.db, {
    snapshot: async () => {
      throw new Error("not needed");
    },
    apply: async () => {
      throw new Error("not needed");
    },
  });
  assert.ok(
    (await ai.readableHeads(identities.get("editor")!)).some((h) => h.documentId === doc.id),
  );
  assert.ok(
    !(await ai.readableHeads(identities.get("viewer")!)).some((h) => h.documentId === doc.id),
  );
  const content = { type: "doc" as const, content: [] };
  const updateBytes = createCollaborationStateFromContent(content);
  const updateHash = createHash("sha256").update(updateBytes).digest("hex");
  const repository = new DocumentRepository(app.db);
  const projections = new DocumentProjectionRepository(app.db);
  await repository.persistUpdate({
    tenantId,
    documentId: doc.id,
    generationId: doc.generationId,
    subjectId: "editor",
    updateHash,
    updateBytes,
    contentChanged: true,
    content,
  });
  // The body notification path operates on exact durable snapshots, even when projection lags.
  const bodyNoticeCount = async () =>
    (await listNotifications("viewer")).items.filter(
      (n) => n.type === "mention" && n.message.includes("正文"),
    ).length;
  const saveBody = async (body: DocumentContent, record?: () => Promise<void>) => {
    const bytes = createCollaborationStateFromContent(body);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const input = {
      tenantId,
      documentId: doc.id,
      generationId: doc.generationId,
      subjectId: "editor",
      updateHash: hash,
      updateBytes: bytes,
      contentChanged: true,
      content: body,
      record,
    };
    await repository.persistUpdate(input);
    return input;
  };
  const bodyMention: DocumentContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_body_mention" },
        content: [
          { type: "text", text: "正文审阅 " },
          { type: "mention", attrs: { identityId: "viewer", label: "林小知" } },
        ],
      },
    ],
  };
  const firstMentionUpdate = await saveBody(bodyMention);
  assert.equal(await bodyNoticeCount(), 1);
  await repository.persistUpdate(firstMentionUpdate);
  assert.equal(await bodyNoticeCount(), 1, "Replayed durable updates do not notify twice");
  // Finish projections to exercise the published-snapshot fallback as well as the outbox path.
  for (let i = 0; i < 20; i++) {
    const job = await projections.claimProjectionJob();
    if (!job) break;
    await projections.processProjectionJob(job);
  }
  const renamedMention = structuredClone(bodyMention);
  const inline = renamedMention.content[0] as {
    content?: { type: string; attrs?: { label?: string }; text?: string }[];
  };
  inline.content!.find((node) => node.type === "mention")!.attrs!.label = "新名称";
  await saveBody(renamedMention);
  assert.equal(await bodyNoticeCount(), 1, "Changing labels does not create a new mention");
  const twoBlocks = structuredClone(renamedMention);
  twoBlocks.content.push({
    type: "paragraph",
    attrs: { blockId: "block_body_second" },
    content: [{ type: "mention", attrs: { identityId: "viewer", label: "林小知" } }],
  });
  await assert.rejects(() =>
    saveBody(twoBlocks, async () => {
      throw new Error("rollback fixture");
    }),
  );
  assert.equal(await bodyNoticeCount(), 1, "Rolled-back saves do not deliver notifications");
  await saveBody(twoBlocks);
  assert.equal(await bodyNoticeCount(), 2);
  const invisible = structuredClone(twoBlocks);
  invisible.content.push({
    type: "paragraph",
    attrs: { blockId: "block_hidden_mentions" },
    content: [
      { type: "mention", attrs: { identityId: "guest", label: "无权限" } },
      { type: "mention", attrs: { identityId: "other", label: "其他租户" } },
      { type: "mention", attrs: { identityId: "editor", label: "自己" } },
    ],
  });
  await saveBody(invisible);
  assert.ok(!(await listNotifications("guest")).items.some((n) => n.message.includes("正文")));
  assert.ok(!(await listNotifications("other")).items.some((n) => n.message.includes("正文")));
  assert.ok(!(await listNotifications("editor")).items.some((n) => n.message.includes("正文")));
  const mentionSearch = (
    await call(
      "GET",
      `/knowledge/search?q=${encodeURIComponent("新名称")}`,
      undefined,
      200,
      "viewer",
    )
  ).json<{ items: { id: string }[] }>();
  // Search uses asynchronous projection; publish this revision before checking its text.
  for (let i = 0; i < 20; i++) {
    const job = await projections.claimProjectionJob();
    if (!job) break;
    await projections.processProjectionJob(job);
  }
  const projectedSearch = (
    await call(
      "GET",
      `/knowledge/search?q=${encodeURIComponent("新名称")}`,
      undefined,
      200,
      "viewer",
    )
  ).json<{ items: { id: string }[] }>();
  assert.ok(
    projectedSearch.items.some((item) => item.id === doc.id),
    JSON.stringify(mentionSearch),
  );
  const old = (
    await call("POST", "/documents/", { title: "v5 升级", workspaceId: team.id }, 201)
  ).json<{ id: string; generationId: string }>();
  await app.db
    .update(documentGenerations)
    .set({ schemaVersion: CALLOUT_DOCUMENT_SCHEMA_VERSION })
    .where(eq(documentGenerations.id, old.generationId));
  await call(
    "POST",
    `/documents/${old.id}/collaboration-session`,
    { schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION, extensions: [] },
    201,
  );
  assert.equal(
    (await call("GET", `/documents/${old.id}`)).json<{ schemaVersion: number }>().schemaVersion,
    CURRENT_DOCUMENT_SCHEMA_VERSION,
  );
  await call(
    "POST",
    `/documents/${old.id}/collaboration-session`,
    { schemaVersion: CALLOUT_DOCUMENT_SCHEMA_VERSION, extensions: [] },
    409,
  );

  revoked.length = 0;
  await call("DELETE", `/knowledge/workspaces/${team.id}/members/editor`, undefined, 204);
  assert.ok(revoked.includes(doc.id));
  await call("GET", path, undefined, 404, "editor");
  await call("POST", session, {}, 404, "editor");
  assert.equal((await ai.readableHeads(identities.get("editor")!)).length, 0);
  assert.equal(
    await assetRepository.getForAction(identities.get("editor")!, asset.id, "read"),
    null,
  );
  await assert.rejects(() =>
    repository.persistUpdate({
      tenantId,
      documentId: doc.id,
      generationId: doc.generationId,
      subjectId: "editor",
      updateHash,
      updateBytes,
      contentChanged: true,
      content,
    }),
  );
  // Removing a member does not erase independent document grants.
  await call("PUT", acl, { actions: ["read"] });
  await call("DELETE", `/knowledge/workspaces/${team.id}/members/viewer`, undefined, 204);
  await call("GET", path, undefined, 200, "viewer");
  await call(
    "POST",
    `${path}/comments`,
    { id: randomUUID(), body: "read is not comment" },
    404,
    "viewer",
  );
  const invPath = `/knowledge/workspaces/${team.id}/invitations`;
  await call("POST", invPath, { role: "admin" }, 400);
  await call("POST", invPath, {}, 404, "viewer");
  const invite = (await call("POST", invPath, {}, 201)).json<{
    id: string;
    token: string;
    role: string;
  }>();
  assert.equal(invite.role, "viewer");
  const [stored] = await app.db
    .select()
    .from(workspaceInvitations)
    .where(eq(workspaceInvitations.id, invite.id));
  assert.notEqual(stored?.tokenHash, invite.token);
  assert.equal(stored?.tokenHash, createHash("sha256").update(invite.token).digest("hex"));
  const listed = (await call("GET", invPath)).json<Record<string, unknown>[]>();
  assert.ok(listed.every((r) => !("token" in r) && !("tokenHash" in r)));
  await call("POST", "/invitations/inspect", { token: invite.token }, 404, "other");
  await call("POST", "/invitations/accept", { token: invite.token }, 401, "");
  const race = await Promise.all(
    ["guest", "guest2"].map((identity) =>
      app.inject({
        method: "POST",
        url: "/api/invitations/accept",
        headers: { authorization: `Bearer ${identity}` },
        payload: { token: invite.token },
      }),
    ),
  );
  assert.deepEqual(race.map((r) => r.statusCode).sort(), [200, 409]);
  const winner = race[0]?.statusCode === 200 ? "guest" : "guest2";
  await call("POST", "/invitations/accept", { token: invite.token }, 200, winner);
  await call("GET", path, undefined, 200, winner);
  await call("DELETE", `/knowledge/workspaces/${team.id}/members/${winner}`, undefined, 204);
  await call("POST", "/invitations/accept", { token: invite.token }, 409, winner);
  const revokedInvite = (await call("POST", invPath, { role: "editor" }, 201)).json<{
    id: string;
    token: string;
  }>();
  await call("DELETE", `${invPath}/${revokedInvite.id}`, undefined, 204);
  await call("POST", "/invitations/accept", { token: revokedInvite.token }, 404, "guest");
  const expiredInvite = (await call("POST", invPath, {}, 201)).json<{
    id: string;
    token: string;
  }>();
  await app.db
    .update(workspaceInvitations)
    .set({ expiresAt: new Date(0) })
    .where(eq(workspaceInvitations.id, expiredInvite.id));
  await call("POST", "/invitations/accept", { token: expiredInvite.token }, 404, "guest");
  const adminInvite = (await call("POST", invPath, {}, 201, "admin")).json<{ token: string }>();
  await call("DELETE", `/knowledge/workspaces/${team.id}/members/admin`, undefined, 204);
  await call("POST", "/invitations/accept", { token: adminInvite.token }, 404, "guest");
  // Notifications remain private, paginated, and safe after a document is gone.
  const notices = await listNotifications("viewer");
  assert.ok(notices.items.some((n) => n.type === "share"));
  assert.ok(notices.items.some((n) => n.type === "permission"));
  assert.ok(notices.unreadCount > 0);
  const notificationId = notices.items[0]!.id;
  await call("POST", `/notifications/${notificationId}/read`, undefined, 404, "guest");
  await call("POST", `/notifications/${notificationId}/read`, undefined, 204, "viewer");
  await call("POST", `/notifications/${notificationId}/read`, undefined, 204, "viewer");
  const first = (await call("GET", "/notifications?limit=1", undefined, 200, "viewer")).json<{
    items: { id: string }[];
    nextCursor: string;
  }>();
  const next = (
    await call("GET", `/notifications?limit=1&before=${first.nextCursor}`, undefined, 200, "viewer")
  ).json<{ items: { id: string }[] }>();
  assert.notEqual(first.items[0]?.id, next.items[0]?.id);
  await call("GET", "/notifications?before=invalid", undefined, 400, "viewer");
  await call("DELETE", path, undefined, 204);
  await call("DELETE", `${path}/permanent`, undefined, 204);
  const deletedNotices = await listNotifications("viewer");
  assert.ok(deletedNotices.items.some((n) => n.type === "deleted"));
  assert.ok(deletedNotices.items.filter((n) => n.documentId === doc.id).every((n) => !n.available));
  await call("POST", "/notifications/read-all", undefined, 204, "viewer");
  assert.equal((await listNotifications("viewer")).unreadCount, 0);
  assert.equal((await listNotifications("other")).items.length, 0);
  // Raw inserts and all existing documents default to restricted, never silently broadened.
  const legacyId = `doc_${randomUUID()}`;
  await app.db.insert(documents).values({
    id: legacyId,
    tenantId,
    createdBy: "owner",
    title: "旧文档",
    workspaceId: team.id,
    catalogId: team.rootCatalogId,
  });
  const [legacy] = await app.db
    .select({ mode: documents.accessMode })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), eq(documents.id, legacyId)));
  assert.equal(legacy?.mode, "restricted");
  console.log(
    `Community smoke passed: ${checks} HTTP checks plus inheritance, persistence, invitation races, notification isolation, and migration assertions.`,
  );
} finally {
  await app.db.delete(assets).where(eq(assets.tenantId, tenantId));
  await app.db.execute(
    sql`delete from documents where tenant_id in (${tenantId}, ${tenantId + "-other"})`,
  );
  await app.db.execute(
    sql`delete from catalogs where tenant_id in (${tenantId}, ${tenantId + "-other"})`,
  );
  await app.db.execute(
    sql`delete from workspaces where tenant_id in (${tenantId}, ${tenantId + "-other"})`,
  );
  await app.db.execute(
    sql`delete from notifications where tenant_id in (${tenantId}, ${tenantId + "-other"})`,
  );
  await app.db.execute(
    sql`delete from identity_profiles where tenant_id in (${tenantId}, ${tenantId + "-other"})`,
  );
  await app.db.execute(
    sql`delete from api_idempotency_records where tenant_id in (${tenantId}, ${tenantId + "-other"})`,
  );
  await app.close();
}
