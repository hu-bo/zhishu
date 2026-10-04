import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { sql } from "../../database/index.js";
import { documentSchema } from "../modules/documents/document.schema.js";
import { createKnowledgePresets } from "@zhishu/document-contracts/examples";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  validateDocumentContent,
  validateDocumentContentForSchemaVersion,
  applyOperationBatch,
} from "@zhishu/document-contracts";
import { exportDocumentMarkdown } from "@zhishu/editor-core/conversions";
import type { Principal } from "../modules/identity/identity.types.js";
import type { z } from "zod";
import { sameDocumentContent } from "../modules/collaboration/structure-operations.js";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to a disposable database");
assert.match(
  new URL(process.env.DATABASE_URL).pathname,
  /(?:qa|test|smoke)/u,
  "Use a disposable qa/test/smoke database",
);
const tenantId = `knowledge-qa-${randomUUID()}`;
const tableFixture = {
  type: "doc",
  content: [
    {
      type: "table",
      attrs: { blockId: "block_equality_table" },
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  attrs: { blockId: "block_equality_paragraph" },
                  content: [{ type: "text", text: "中文单元格" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const tableWithDefaults = structuredClone(tableFixture);
Object.assign(tableWithDefaults.content[0]!.content[0]!.content[0]!, {
  attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
});
const tableValidation = validateDocumentContent(tableFixture),
  defaultsValidation = validateDocumentContent(tableWithDefaults);
assert.ok(tableValidation.success);
assert.ok(defaultsValidation.success);
assert.ok(
  sameDocumentContent(tableValidation.data, defaultsValidation.data),
  "Table defaults must match omitted attributes",
);
const reversedKeys = JSON.parse(JSON.stringify(tableFixture), (_key: string, value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).reverse());
}) as unknown;
const reorderedValidation = validateDocumentContent(reversedKeys);
assert.ok(reorderedValidation.success);
assert.ok(
  sameDocumentContent(tableValidation.data, reorderedValidation.data),
  "JSONB key order must not cause projection conflict",
);
tableWithDefaults.content[0]!.content[0]!.content[0]!.content[0]!.content[0]!.text =
  "新的中文单元格";
const changedValidation = validateDocumentContent(tableWithDefaults);
assert.ok(changedValidation.success);
assert.equal(
  sameDocumentContent(tableValidation.data, changedValidation.data),
  false,
  "Changed cell text must remain a content change",
);
const principal = (identityId: string, tenant = tenantId): Principal => ({
  identityId,
  tenantId: tenant,
  username: identityId,
  displayName: identityId,
  email: `${identityId}@example.test`,
  active: true,
  globalRoles: [],
});
const principals = new Map([
  ["owner", principal("owner")],
  ["reader", principal("reader")],
  ["outsider", principal("outsider")],
  ["other-tenant", principal("owner", `${tenantId}-other`)],
]);
const app = await buildApp(
  loadConfig({
    ...process.env,
    NODE_ENV: "test",
    AUTH_MODE: "external",
    LOG_LEVEL: "silent",
    ASSET_STORAGE_ENDPOINT: undefined,
    ASSET_STORAGE_PUBLIC_ENDPOINT: undefined,
    ASSET_STORAGE_ACCESS_KEY_ID: undefined,
    ASSET_STORAGE_SECRET_ACCESS_KEY: undefined,
  }),
  {
    identityAuthenticator: {
      authenticate: (authorization) =>
        principals.get(authorization?.replace(/^Bearer /u, "") ?? "") ?? null,
    },
  },
);
type Document = z.infer<typeof documentSchema>;
type Catalog = {
  id: string;
  name: string;
  icon: string | null;
  parentId: string | null;
  workspaceId: string;
  position: number;
  canManage: boolean;
};
type CatalogChildren = {
  catalog: {
    id: string;
    name: string;
    icon: string | null;
    parentId: string | null;
    isRoot: boolean;
    canManage: boolean;
  };
  catalogs: Array<{ id: string; name: string; hasChildren: boolean }>;
  documents: Array<{ id: string; title: string }>;
};
const call = async (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: object,
  status = 200,
  identity = "owner",
  headers: Record<string, string> = {},
) => {
  const response = await app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${identity}`, ...headers },
  });
  assert.equal(
    response.statusCode,
    status,
    `${method} ${url}: ${response.statusCode >= 400 ? response.body : "Unexpected response status"}`,
  );
  return response;
};
const create = async (
  title: string,
  workspaceId = "ws_default",
  catalogId: string | null = null,
  identity = "owner",
) =>
  (
    await call(
      "POST",
      "/api/documents/",
      { title, workspaceId, catalogId, mode: "standard" },
      201,
      identity,
    )
  ).json<Document>();
const createCatalog = async (
  workspaceId: string,
  body: { name: string; parentId?: string | null },
  status = 201,
  identity = "owner",
  headers: Record<string, string> = {},
) =>
  (
    await call(
      "POST",
      `/api/knowledge/workspaces/${workspaceId}/catalogs`,
      body,
      status,
      identity,
      headers,
    )
  ).json<Catalog>();
const move = (
  document: Document,
  workspaceId: string,
  catalogId: string,
  status = 200,
  beforeId: string | null = null,
) =>
  call(
    "PATCH",
    `/api/knowledge/documents/${document.id}/location`,
    { workspaceId, catalogId, beforeId, metadataRevision: document.metadataRevision },
    status,
  );
const children = (workspaceId: string, catalogId: string, identity = "owner") =>
  call(
    "GET",
    `/api/knowledge/workspaces/${workspaceId}/catalogs/${catalogId}/children`,
    undefined,
    200,
    identity,
  ).then((response) => response.json<CatalogChildren>());

try {
  await app.ready();
  await call("GET", "/api/knowledge/workspaces", undefined, 401, "missing");
  const workspaceList = (await call("GET", "/api/knowledge/workspaces")).json<
    Array<{ id: string; name: string; rootCatalogId: string; documentCount: number }>
  >();
  const defaultWorkspace = workspaceList.find((row) => row.id === "ws_default");
  assert.ok(defaultWorkspace, "ws_default must be auto-provisioned");
  assert.equal(
    defaultWorkspace.rootCatalogId,
    "cat_root_ws_default",
    "Every workspace must expose a root catalog",
  );
  const workspace = (
    await call(
      "POST",
      "/api/knowledge/workspaces",
      { name: "第二工作区", icon: "🧪", description: "冒烟测试空间" },
      201,
    )
  ).json<{ id: string; icon: string | null; description: string; rootCatalogId: string }>();
  assert.equal(workspace.rootCatalogId, `cat_root_${workspace.id}`);
  assert.equal(workspace.icon, "🧪");
  assert.equal(workspace.description, "冒烟测试空间");

  // Catalog CRUD with idempotent create + replay divergence detection.
  const catalogKey = `catalog-create-${randomUUID()}`;
  const catalogA = await createCatalog("ws_default", { name: "研发专区" }, 201, "owner", {
    "idempotency-key": catalogKey,
  });
  assert.equal(catalogA.parentId, "cat_root_ws_default");
  const replayedCatalog = await createCatalog("ws_default", { name: "研发专区" }, 201, "owner", {
    "idempotency-key": catalogKey,
  });
  assert.equal(replayedCatalog.id, catalogA.id, "Replayed create must return the same catalog");
  await createCatalog("ws_default", { name: "键复用" }, 409, "owner", {
    "idempotency-key": catalogKey,
  });
  const catalogB = await createCatalog("ws_default", {
    name: "文档专区",
    parentId: catalogA.id,
  });
  const renamedCatalog = (
    await call("PATCH", `/api/knowledge/catalogs/${catalogB.id}`, { name: "产品文档" })
  ).json<Catalog>();
  assert.equal(renamedCatalog.name, "产品文档");
  await call("PATCH", `/api/knowledge/catalogs/${catalogB.id}`, {}, 400);
  // The owner-created workspace root rejects rename/delete; a system-owned root stays 404 for non-owners.
  await call(
    "PATCH",
    `/api/knowledge/catalogs/${workspace.rootCatalogId}`,
    { name: "改名根目录" },
    400,
  );
  await call("DELETE", `/api/knowledge/catalogs/${workspace.rootCatalogId}`, undefined, 400);
  await call("PATCH", `/api/knowledge/catalogs/cat_root_ws_default`, { name: "改名根目录" }, 404);
  await call("PATCH", `/api/knowledge/catalogs/${catalogB.id}`, { name: "抢占" }, 404, "reader");
  await call(
    "PATCH",
    `/api/knowledge/catalogs/${catalogA.id}/location`,
    { parentId: catalogB.id },
    400,
  );

  const parent = await create("测试父页");
  assert.equal(parent.catalogId, "cat_root_ws_default");
  const child = await create("测试子页", "ws_default", catalogA.id);
  const leaf = await create("测试孙页", "ws_default", catalogB.id);
  await create("普通目录过滤对照");
  await call(
    "POST",
    "/api/documents/",
    { title: "无效目录页", workspaceId: workspace.id, catalogId: catalogA.id, mode: "standard" },
    404,
  );

  // Lazy children: catalogs report hasChildren, documents are readable-filtered.
  const rootChildren = await children("ws_default", "cat_root_ws_default");
  // The response self-describes the queried catalog so the browse panel header
  // can render name/icon and gate management without a second round-trip.
  assert.equal(rootChildren.catalog.id, "cat_root_ws_default", "children must self-describe root");
  assert.equal(rootChildren.catalog.isRoot, true, "root must report isRoot");
  assert.equal(rootChildren.catalog.parentId, null, "root has no parent");
  assert.equal(rootChildren.catalog.canManage, false, "root is never manageable");
  assert.ok(
    rootChildren.catalogs.some((row) => row.id === catalogA.id && row.hasChildren),
    "catalogA must report children",
  );
  assert.ok(rootChildren.documents.some((row) => row.id === parent.id));
  const catalogAChildren = await children("ws_default", catalogA.id);
  assert.equal(catalogAChildren.catalog.id, catalogA.id, "children must self-describe catalogA");
  assert.equal(catalogAChildren.catalog.isRoot, false, "catalogA is not root");
  assert.equal(catalogAChildren.catalog.parentId, "cat_root_ws_default", "catalogA parent is root");
  assert.equal(catalogAChildren.catalog.canManage, true, "owner manages catalogA");
  assert.deepEqual(
    catalogAChildren.documents.map((row) => row.id),
    [child.id],
  );
  assert.ok(catalogAChildren.catalogs.some((row) => row.id === catalogB.id && row.hasChildren));
  await call(
    "GET",
    `/api/knowledge/workspaces/${workspace.id}/catalogs/${catalogA.id}/children`,
    undefined,
    404,
  );
  await call(
    "GET",
    `/api/knowledge/workspaces/ws_default/catalogs/cat_root_ws_default/children`,
    undefined,
    404,
    "other-tenant",
  );

  // Locate returns the full root-first catalog path.
  const located = (await call("GET", `/api/knowledge/documents/${leaf.id}/locate`)).json<{
    workspaceId: string;
    catalogId: string;
    catalogPath: Array<{ id: string; name: string }>;
  }>();
  assert.equal(located.workspaceId, "ws_default");
  assert.equal(located.catalogId, catalogB.id);
  assert.deepEqual(
    located.catalogPath.map((row) => row.id),
    ["cat_root_ws_default", catalogA.id, catalogB.id],
  );
  await call("GET", `/api/knowledge/documents/${leaf.id}/locate`, undefined, 404, "reader");

  // Document moves: intra-workspace reorder, cross-workspace relocation, stale revision.
  await move(child, "ws_default", catalogB.id, 200, leaf.id);
  const reordered = await children("ws_default", catalogB.id);
  assert.deepEqual(
    reordered.documents.map((row) => row.id),
    [child.id, leaf.id],
    "beforeId must insert ahead of the drop target",
  );
  await move(child, "ws_default", catalogA.id, 409);
  const relocatedChild = (await call("GET", `/api/documents/${child.id}`)).json<Document>();
  await move(relocatedChild, workspace.id, workspace.rootCatalogId);
  const migrated = (await call("GET", `/api/documents/${child.id}`)).json<Document>();
  assert.equal(migrated.workspaceId, workspace.id);
  assert.equal(migrated.catalogId, workspace.rootCatalogId);
  await move(migrated, "ws_default", catalogB.id);

  const filtered = (await call("GET", "/api/documents/?view=all&q=普通目录过滤对照")).json<{
    items: Document[];
  }>();
  assert.equal(filtered.items.length, 1);
  const currentChild = (await call("GET", `/api/documents/${child.id}`)).json<Document>();
  const decorated = (
    await call("PATCH", `/api/documents/${child.id}`, {
      icon: "📚",
      tags: [{ label: "研发", color: "violet" }],
      metadataRevision: currentChild.metadataRevision,
    })
  ).json<Document>();
  assert.equal(decorated.title, child.title);
  assert.equal(decorated.icon, "📚");
  await call(
    "PATCH",
    `/api/documents/${child.id}`,
    { icon: "not-emoji", metadataRevision: decorated.metadataRevision },
    400,
  );
  await call(
    "PATCH",
    `/api/documents/${child.id}`,
    {
      tags: [
        { label: "重复", color: "indigo" },
        { label: "重复", color: "rose" },
      ],
      metadataRevision: decorated.metadataRevision,
    },
    400,
  );
  await call(
    "PATCH",
    `/api/documents/${child.id}`,
    { icon: "🧠", metadataRevision: currentChild.metadataRevision },
    409,
  );
  const content = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "block_search_smoke", align: "center" },
        content: [
          {
            type: "text",
            text: "知识检索针needle 与 100%literal",
            marks: [{ type: "underline" }, { type: "highlight", attrs: { color: "purple" } }],
          },
        ],
      },
    ],
  };
  await call("PUT", `/api/documents/${child.id}/content`, { expectedSnapshotRevision: 1, content });
  const reopened = (await call("GET", `/api/documents/${child.id}/content`)).json<{
    content: unknown;
    snapshotRevision: number;
  }>();
  assert.deepEqual(reopened.content, content);
  await call(
    "PUT",
    `/api/documents/${child.id}/content`,
    {
      expectedSnapshotRevision: 1,
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "block_stale_draft" },
            content: [{ type: "text", text: "不应覆盖较新正文" }],
          },
        ],
      },
    },
    409,
  );
  const version = (
    await call(
      "POST",
      `/api/documents/${child.id}/versions`,
      {
        mode: "standard",
        name: "格式历史版本",
        expectedSnapshotRevision: reopened.snapshotRevision,
      },
      201,
    )
  ).json<{ id: string }>();
  const historical = (
    await call("GET", `/api/documents/${child.id}/versions/${version.id}/content`)
  ).json<{ content: unknown }>();
  assert.deepEqual(historical.content, content);
  const legacy = await create("旧内容契约升级验证");
  await app.db.execute(sql`
    update document_generations set schema_version = 3
    where document_id = ${legacy.id} and status = 'active'
  `);
  const legacyVersion = (
    await call(
      "POST",
      `/api/documents/${legacy.id}/versions`,
      {
        mode: "standard",
        name: "升级前",
        expectedSnapshotRevision: 1,
      },
      201,
    )
  ).json<{ id: string; generationId: string }>();
  const formattedLegacy = structuredClone(content);
  formattedLegacy.content[0]!.content[0]!.text = "旧文档采用新版格式";
  const upgraded = (
    await call("PUT", `/api/documents/${legacy.id}/content`, {
      expectedSnapshotRevision: 1,
      content: formattedLegacy,
    })
  ).json<{ schemaVersion: number; snapshotRevision: number }>();
  assert.equal(upgraded.schemaVersion, CURRENT_DOCUMENT_SCHEMA_VERSION);
  assert.equal(upgraded.snapshotRevision, 2);
  await call("PUT", `/api/documents/${legacy.id}/content`, {
    expectedSnapshotRevision: 1,
    content: formattedLegacy,
  });
  const oldHistorical = (
    await call("GET", `/api/documents/${legacy.id}/versions/${legacyVersion.id}/content`)
  ).json<{ schemaVersion: number; content: { type: string; content: unknown[] } }>();
  assert.equal(oldHistorical.schemaVersion, 3);
  assert.deepEqual(oldHistorical.content, { type: "doc", content: [] });
  const exportedLegacy = (await call("GET", `/api/documents/${legacy.id}/export`)).json<{
    schemaVersion: number;
    content: unknown;
  }>();
  assert.equal(exportedLegacy.schemaVersion, CURRENT_DOCUMENT_SCHEMA_VERSION);
  assert.deepEqual(exportedLegacy.content, formattedLegacy);
  const modernVersion = (
    await call(
      "POST",
      `/api/documents/${legacy.id}/versions`,
      {
        mode: "standard",
        name: "升级后",
        expectedSnapshotRevision: 2,
      },
      201,
    )
  ).json<{ id: string; generationId: string }>();
  assert.notEqual(modernVersion.generationId, legacyVersion.generationId);
  const restoreKey = `restore-${randomUUID()}`;
  const restoredLegacy = (
    await call(
      "POST",
      `/api/documents/${legacy.id}/versions/${legacyVersion.id}/restore`,
      {
        mode: "standard",
        expectedSnapshotRevision: 2,
      },
      200,
      "owner",
      { "idempotency-key": restoreKey },
    )
  ).json<Document>();
  assert.equal(restoredLegacy.schemaVersion, 3);
  assert.notEqual(restoredLegacy.generationId, modernVersion.generationId);
  const replayedRestore = (
    await call(
      "POST",
      `/api/documents/${legacy.id}/versions/${legacyVersion.id}/restore`,
      {
        mode: "standard",
        expectedSnapshotRevision: 2,
      },
      200,
      "owner",
      { "idempotency-key": restoreKey },
    )
  ).json<Document>();
  assert.equal(replayedRestore.generationId, restoredLegacy.generationId);
  const restoredModern = (
    await call("POST", `/api/documents/${legacy.id}/versions/${modernVersion.id}/restore`, {
      mode: "standard",
      expectedSnapshotRevision: 3,
    })
  ).json<Document>();
  assert.equal(restoredModern.schemaVersion, CURRENT_DOCUMENT_SCHEMA_VERSION);
  await call("GET", `/api/documents/${legacy.id}/export`);
  await call(
    "POST",
    `/api/documents/${legacy.id}/collaboration-session`,
    {
      schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
      extensions: [],
    },
    201,
  );
  assert.equal(
    (await call("GET", `/api/documents/${legacy.id}`)).json<Document>().mode,
    "collaborative",
  );
  const extended = await create("通用内容扩展验证");
  const extendedContent = {
    type: "doc",
    content: [
      {
        type: "callout",
        attrs: { blockId: "block_callout_qa", theme: "warning" },
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "block_callout_text_qa" },
            content: [
              { type: "text", text: "发布检查：" },
              { type: "statusTag", attrs: { status: "in-review" } },
            ],
          },
        ],
      },
      { type: "horizontalRule", attrs: { blockId: "block_divider_qa", label: "交付后的维护" } },
    ],
  };
  const extendedValidation = validateDocumentContent(extendedContent);
  assert.ok(extendedValidation.success);
  assert.equal(validateDocumentContentForSchemaVersion(extendedContent, 4).success, false);
  assert.equal(
    validateDocumentContent({
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { blockId: "block_invalid_theme", theme: "arbitrary" },
          content: [],
        },
      ],
    }).success,
    false,
  );
  const unwrapResult = applyOperationBatch(
    extendedValidation.data,
    {
      documentId: extended.id,
      operationId: "op_unwrap_callout",
      origin: "user",
      operations: [
        {
          type: "move-block",
          targetBlockId: "block_callout_text_qa",
          parentBlockId: null,
          beforeBlockId: "block_callout_qa",
        },
        { type: "delete-block", targetBlockId: "block_callout_qa" },
      ],
    },
    { documentId: extended.id },
  );
  assert.ok(unwrapResult.success);
  assert.equal(unwrapResult.content.content[0]!.attrs.blockId, "block_callout_text_qa");
  const wrappedAgain = applyOperationBatch(
    unwrapResult.content,
    {
      documentId: extended.id,
      operationId: "op_wrap_callout",
      origin: "user",
      operations: [
        {
          type: "wrap-block",
          targetBlockId: "block_callout_text_qa",
          wrapper: {
            type: "callout",
            attrs: { blockId: "block_new_callout_qa", theme: "success" },
            content: [],
          },
        },
      ],
    },
    { documentId: extended.id },
  );
  assert.ok(wrappedAgain.success);
  assert.equal(wrappedAgain.content.content[0]!.type, "callout");
  await call("PUT", `/api/documents/${extended.id}/content`, {
    expectedSnapshotRevision: 1,
    content: extendedContent,
  });
  assert.deepEqual(
    (await call("GET", `/api/documents/${extended.id}/content`)).json<{ content: unknown }>()
      .content,
    extendedContent,
  );
  const extendedVersion = (
    await call(
      "POST",
      `/api/documents/${extended.id}/versions`,
      {
        mode: "standard",
        name: "提示块状态分隔线",
        expectedSnapshotRevision: 2,
      },
      201,
    )
  ).json<{ id: string }>();
  assert.deepEqual(
    (
      await call("GET", `/api/documents/${extended.id}/versions/${extendedVersion.id}/content`)
    ).json<{ content: unknown }>().content,
    extendedContent,
  );
  assert.deepEqual(
    (await call("GET", `/api/documents/${extended.id}/export`)).json<{ content: unknown }>()
      .content,
    extendedContent,
  );
  const extendedMarkdown = exportDocumentMarkdown(extendedContent);
  assert.ok(extendedMarkdown.success);
  assert.equal(extendedMarkdown.report.degraded.length, 3);
  assert.match(extendedMarkdown.value, /评审中/u);
  assert.match(extendedMarkdown.value, /交付后的维护/u);
  for (const query of ["评审中", "交付后的维护"]) {
    const matches = (
      await call("GET", `/api/knowledge/search?q=${encodeURIComponent(query)}`)
    ).json<{ items: Array<{ id: string }> }>();
    assert.ok(matches.items.some((item) => item.id === extended.id));
  }
  await call(
    "POST",
    `/api/documents/${extended.id}/collaboration-session`,
    { schemaVersion: 4, extensions: [] },
    409,
  );
  await call(
    "POST",
    `/api/documents/${extended.id}/collaboration-session`,
    { schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION, extensions: [] },
    201,
  );
  const search = (
    await call("GET", `/api/knowledge/search?q=${encodeURIComponent("检索针needle")}`)
  ).json<{ items: Array<{ id: string; excerpt: string; match: string; path: string[] }> }>();
  assert.deepEqual(
    search.items.map((item) => item.id),
    [child.id],
  );
  assert.equal(search.items[0]?.match, "content");
  assert.match(search.items[0]!.excerpt, /知识检索针needle/u);
  assert.deepEqual(search.items[0]!.path, ["研发专区", "产品文档"]);
  const literalSearch = (
    await call("GET", `/api/knowledge/search?q=${encodeURIComponent("100%literal")}`)
  ).json<{ items: Array<{ id: string }> }>();
  assert.equal(literalSearch.items.length, 1);
  assert.equal(
    (await call("GET", "/api/knowledge/search?q=_", undefined, 200, "owner")).json<{
      items: unknown[];
    }>().items.length,
    0,
  );
  await call("PUT", `/api/documents/${child.id}/acl/reader`, { actions: ["read"] });
  const readerChildren = await children("ws_default", catalogB.id, "reader");
  assert.equal(
    readerChildren.catalog.canManage,
    false,
    "non-creator reader cannot manage catalogB",
  );
  assert.deepEqual(
    readerChildren.documents.map((row) => row.id),
    [child.id],
    "Unreadable documents must be filtered out of children",
  );
  const readerSearch = (
    await call("GET", "/api/knowledge/search?q=needle", undefined, 200, "reader")
  ).json<{ items: Array<{ path: string[] }> }>();
  assert.deepEqual(
    readerSearch.items[0]?.path,
    ["研发专区", "产品文档"],
    "Catalog structure is tenant-visible by design",
  );
  assert.equal(
    (await call("GET", `/api/knowledge/search?q=needle`, undefined, 200, "reader")).json<{
      items: unknown[];
    }>().items.length,
    1,
  );
  assert.equal(
    (await call("GET", `/api/knowledge/search?q=needle`, undefined, 200, "outsider")).json<{
      items: unknown[];
    }>().items.length,
    0,
  );
  assert.equal(
    (await call("GET", `/api/knowledge/search?q=needle`, undefined, 200, "other-tenant")).json<{
      items: unknown[];
    }>().items.length,
    0,
  );
  await call(
    "PATCH",
    `/api/knowledge/documents/${child.id}/location`,
    {
      workspaceId: workspace.id,
      catalogId: workspace.rootCatalogId,
      beforeId: null,
      metadataRevision: decorated.metadataRevision,
    },
    404,
    "reader",
  );
  await call("DELETE", `/api/documents/${parent.id}`, undefined, 204);
  const afterDelete = await children("ws_default", "cat_root_ws_default");
  assert.ok(
    !afterDelete.documents.some((row) => row.id === parent.id),
    "Trashed documents must leave the tree",
  );
  const restored = (
    await call("POST", `/api/documents/${child.id}/versions/${version.id}/restore`, {
      mode: "standard",
      expectedSnapshotRevision: reopened.snapshotRevision,
    })
  ).json<Document>();
  assert.equal(restored.icon, "📚");
  assert.deepEqual(restored.tags, decorated.tags);
  await call(
    "POST",
    `/api/documents/${child.id}/versions/${version.id}/restore`,
    { mode: "standard", expectedSnapshotRevision: reopened.snapshotRevision },
    409,
  );
  const firstPresets = (
    await call("POST", `/api/knowledge/workspaces/${workspace.id}/presets`)
  ).json<{ items: Array<{ documentId: string; status: string }> }>();
  assert.equal(firstPresets.items.filter((item) => item.status === "created").length, 3);
  for (const installed of firstPresets.items) {
    const snapshot = (await call("GET", `/api/documents/${installed.documentId}/content`)).json<{
      content: object;
      snapshotRevision: number;
    }>();
    await call("PUT", `/api/documents/${installed.documentId}/content`, {
      expectedSnapshotRevision: snapshot.snapshotRevision,
      content: snapshot.content,
    });
    await call("GET", `/api/documents/${installed.documentId}/export`);
  }
  const repeated = (await call("POST", `/api/knowledge/workspaces/${workspace.id}/presets`)).json<
    typeof firstPresets
  >();
  assert.deepEqual(
    repeated.items.map((item) => item.documentId),
    firstPresets.items.map((item) => item.documentId),
  );
  assert.equal(repeated.items.filter((item) => item.status === "existing").length, 3);
  const removedPreset = firstPresets.items[0]!.documentId;
  await call("DELETE", `/api/documents/${removedPreset}`, undefined, 204);
  await call("DELETE", `/api/documents/${removedPreset}/permanent`, undefined, 204);
  const afterPresetDelete = (
    await call("POST", `/api/knowledge/workspaces/${workspace.id}/presets`)
  ).json<typeof firstPresets>();
  assert.equal(afterPresetDelete.items.filter((item) => item.status === "removed").length, 1);
  assert.equal(afterPresetDelete.items.filter((item) => item.status === "created").length, 0);

  // Cascading catalog delete: sub-catalog removed, documents land in the trash at the root.
  const doomed = await createCatalog("ws_default", { name: "待删除" });
  const doomedChild = await createCatalog("ws_default", {
    name: "待删除子目录",
    parentId: doomed.id,
  });
  const doomedDocument = await create("待删除目录内文档", "ws_default", doomedChild.id);
  const impact = (await call("GET", `/api/knowledge/catalogs/${doomed.id}/deletion-impact`)).json<{
    catalogCount: number;
    documentCount: number;
  }>();
  assert.deepEqual(impact, { catalogCount: 1, documentCount: 1 });
  await call("DELETE", `/api/knowledge/catalogs/${doomed.id}`, undefined, 204);
  await call(
    "GET",
    `/api/knowledge/workspaces/ws_default/catalogs/${doomed.id}/children`,
    undefined,
    404,
  );
  const trashList = (await call("GET", "/api/documents/?view=trash&q=待删除目录内文档")).json<{
    items: Document[];
  }>();
  assert.equal(trashList.items.length, 1);
  assert.equal(trashList.items[0]!.id, doomedDocument.id);
  assert.equal(trashList.items[0]!.catalogId, "cat_root_ws_default");

  // Catalog depth ceiling: 16 edges below the implicit root, the 17th is rejected.
  let deepCatalog = catalogA;
  for (let level = 1; level <= 15; level++)
    deepCatalog = await createCatalog("ws_default", {
      name: `层级 ${level}`,
      parentId: deepCatalog.id,
    });
  await createCatalog("ws_default", { name: "不允许第 17 层", parentId: deepCatalog.id }, 400);
  await call(
    "PATCH",
    `/api/knowledge/catalogs/${catalogB.id}/location`,
    { parentId: deepCatalog.id },
    400,
  );
  for (const preset of createKnowledgePresets()) {
    const markdown = exportDocumentMarkdown(preset.content);
    assert.ok(markdown.success);
    assert.match(markdown.value, /^# /u);
    assert.match(markdown.value, /- \[ \]/u);
    assert.match(markdown.value, /\| --- \|/u);
  }
  const losses = exportDocumentMarkdown(content);
  assert.ok(losses.success);
  assert.equal(losses.report.degraded.length, 3);

  // ---- Public share lifecycle: mint -> anonymous read -> join -> revoke/expire ----
  type Share = {
    id: string;
    documentId: string;
    permission: "read" | "edit";
    expiresAt: string;
    revokedAt: string | null;
    joinCount: number;
  };
  type PublicDetail = {
    shareId: string;
    state: "active" | "expired" | "revoked" | "unknown";
    permission: "read" | "edit" | null;
    expiresAt: string | null;
    document: { id: string; title: string; mode: string } | null;
  };
  type JoinResult = {
    joined: boolean;
    documentId: string;
    workspaceId: string;
    catalogId: string;
    catalogPath: Array<{ id: string; name: string }>;
  };
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  await call(
    "POST",
    `/api/documents/${child.id}/shares`,
    { permission: "read", expiresAt: new Date().toISOString() },
    400,
  );
  await call(
    "POST",
    `/api/documents/${child.id}/shares`,
    {
      permission: "read",
      expiresAt: new Date(Date.now() + 400 * 24 * 60 * 60 * 1_000).toISOString(),
    },
    400,
  );
  await call(
    "POST",
    `/api/documents/${child.id}/shares`,
    { permission: "read", expiresAt: tomorrow },
    404,
    "reader",
  );
  const readShare = (
    await call(
      "POST",
      `/api/documents/${child.id}/shares`,
      { permission: "read", expiresAt: tomorrow },
      201,
    )
  ).json<Share>();
  assert.match(readShare.id, /^shr_/u);
  const editShare = (
    await call(
      "POST",
      `/api/documents/${child.id}/shares`,
      { permission: "edit", expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString() },
      201,
    )
  ).json<Share>();
  const shareList = (await call("GET", `/api/documents/${child.id}/shares`)).json<Share[]>();
  assert.deepEqual(
    shareList.map((row) => row.id),
    [editShare.id, readShare.id],
    "Shares list newest first",
  );
  await call("GET", `/api/documents/${child.id}/shares`, undefined, 404, "reader");

  // Anonymous capability endpoints: no authorization required, states render in the body.
  const anonymousDetail = (
    await call("GET", `/api/public/shares/${readShare.id}`, undefined, 200, "missing")
  ).json<PublicDetail>();
  assert.equal(anonymousDetail.state, "active");
  assert.equal(anonymousDetail.permission, "read");
  assert.equal(anonymousDetail.document?.id, child.id);
  const missingDetail = (
    await call("GET", "/api/public/shares/shr_does_not_exist", undefined, 200, "missing")
  ).json<PublicDetail>();
  assert.equal(missingDetail.state, "unknown");
  assert.equal(missingDetail.document, null);
  const ownerContent = (await call("GET", `/api/documents/${child.id}/content`)).json<{
    content: unknown;
  }>();
  const publicContent = (
    await call("GET", `/api/public/shares/${readShare.id}/content`, undefined, 200, "missing")
  ).json<{ readOnly: boolean; mode: string; content: unknown }>();
  assert.equal(publicContent.readOnly, true);
  assert.equal(publicContent.mode, "standard");
  assert.deepEqual(publicContent.content, ownerContent.content);
  // No object storage in smoke: asset access must degrade to 503, not leak.
  await call(
    "GET",
    `/api/public/shares/${readShare.id}/assets/asset_smoke_missing/access`,
    undefined,
    503,
    "missing",
  );

  // Join: first time grants ACL per tier, second time is a no-op flag.
  const joined = (
    await call("POST", `/api/shares/${editShare.id}/join`, undefined, 200, "outsider")
  ).json<JoinResult>();
  assert.equal(joined.joined, true);
  assert.equal(joined.documentId, child.id);
  assert.equal(joined.workspaceId, "ws_default");
  assert.equal(joined.catalogId, catalogB.id);
  assert.deepEqual(
    joined.catalogPath.map((row) => row.id),
    ["cat_root_ws_default", catalogA.id, catalogB.id],
  );
  const outsiderContent = (
    await call("GET", `/api/documents/${child.id}/content`, undefined, 200, "outsider")
  ).json<{ readOnly: boolean }>();
  assert.equal(outsiderContent.readOnly, false, "Edit-tier join must grant write");
  const rejoined = (
    await call("POST", `/api/shares/${editShare.id}/join`, undefined, 200, "outsider")
  ).json<JoinResult>();
  assert.equal(rejoined.joined, false);
  const readerJoin = (
    await call("POST", `/api/shares/${editShare.id}/join`, undefined, 200, "reader")
  ).json<JoinResult>();
  assert.equal(readerJoin.joined, false, "Existing readers must not re-join");
  await call("POST", `/api/shares/${editShare.id}/join`, undefined, 404, "other-tenant");
  const afterJoins = (await call("GET", `/api/documents/${child.id}/shares`)).json<Share[]>();
  assert.equal(
    afterJoins.find((row) => row.id === editShare.id)?.joinCount,
    1,
    "joinCount only increments on first grant",
  );

  // Revoke: idempotent 204, anonymous access collapses, granted ACLs survive.
  await call("DELETE", `/api/documents/${child.id}/shares/${readShare.id}`, undefined, 204);
  await call("DELETE", `/api/documents/${child.id}/shares/${readShare.id}`, undefined, 204);
  await call(
    "DELETE",
    `/api/documents/${child.id}/shares/${editShare.id}`,
    undefined,
    404,
    "reader",
  );
  const revokedDetail = (
    await call("GET", `/api/public/shares/${readShare.id}`, undefined, 200, "missing")
  ).json<PublicDetail>();
  assert.equal(revokedDetail.state, "revoked");
  assert.equal(revokedDetail.document, null);
  assert.ok(revokedDetail.expiresAt, "Revoked shares still expose their expiry");
  await call("GET", `/api/public/shares/${readShare.id}/content`, undefined, 404, "missing");
  await call("POST", `/api/shares/${readShare.id}/join`, undefined, 404, "outsider");
  await call("GET", `/api/documents/${child.id}`, undefined, 200, "outsider");

  // Expiry: backdate the edit share (created_at too, the check constraint binds updates).
  await app.db.execute(sql`
    update document_shares
    set expires_at = now() - interval '1 hour', created_at = now() - interval '2 hours'
    where tenant_id = ${tenantId} and id = ${editShare.id}
  `);
  const expiredDetail = (
    await call("GET", `/api/public/shares/${editShare.id}`, undefined, 200, "missing")
  ).json<PublicDetail>();
  assert.equal(expiredDetail.state, "expired");
  await call("GET", `/api/public/shares/${editShare.id}/content`, undefined, 404, "missing");
  await call("POST", `/api/shares/${editShare.id}/join`, undefined, 404, "reader");
  await call("POST", `/api/shares/${editShare.id}/join`, undefined, 401, "missing");
  // Trashing the document collapses even a live share to "unknown".
  const doomedShareDoc = await create("分享回收验证");
  const doomedShare = (
    await call(
      "POST",
      `/api/documents/${doomedShareDoc.id}/shares`,
      { permission: "read", expiresAt: tomorrow },
      201,
    )
  ).json<Share>();
  await call("DELETE", `/api/documents/${doomedShareDoc.id}`, undefined, 204);
  const trashedDetail = (
    await call("GET", `/api/public/shares/${doomedShare.id}`, undefined, 200, "missing")
  ).json<PublicDetail>();
  assert.equal(trashedDetail.state, "unknown");

  process.stdout.write(
    "Knowledge smoke passed: catalogs (CRUD, lazy children, depth ceiling, cascade delete), document moves, locate paths, ACL/tenant isolation, metadata/revision, formats/history, literal body search, idempotent presets, and the full share lifecycle (mint, anonymous read, tiered join, revoke, expiry). MinIO was not contacted.\n",
  );
} finally {
  await app.db.execute(
    sql`delete from documents where tenant_id in (${tenantId}, ${`${tenantId}-other`})`,
  );
  await app.db.execute(
    sql`delete from knowledge_preset_installations where tenant_id = ${tenantId}`,
  );
  await app.db.execute(sql`delete from document_audit_events where tenant_id = ${tenantId}`);
  await app.db.execute(
    sql`delete from catalogs where tenant_id in (${tenantId}, ${`${tenantId}-other`})`,
  );
  await app.db.execute(
    sql`delete from workspaces where tenant_id in (${tenantId}, ${`${tenantId}-other`})`,
  );
  await app.close();
}
