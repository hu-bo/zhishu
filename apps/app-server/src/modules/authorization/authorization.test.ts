import { workspacesModule } from "../workspaces/index.js";
import { catalogsModule } from "../catalogs/index.js";
import { knowledgeModule } from "../knowledge/index.js";
import { AssetRepository } from "../assets/asset.repository.js";
import { CURRENT_DOCUMENT_SCHEMA_VERSION } from "@zhishu/document-contracts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { AuthorizationEventWorker } from "./authorization-events.js";
import { createServer } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { createCollaborationServer } from "../collaboration/hocuspocus.server.js";
import { registerIdentityGuard } from "../identity/index.js";
import { rememberIdentities } from "../identity/identity-directory.js";
import { and, eq, sql } from "drizzle-orm";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Database } from "../../../database/index.js";
import * as schema from "../../../database/schema/index.js";
import { documentsModule } from "../documents/index.js";
import { documentActionSql, hasDocumentPermission } from "./permissions.js";
import { registerErrorHandlers } from "../../plugins/errors.js";
import { loadConfig } from "../../config.js";
import type { Principal } from "../identity/identity.types.js";
import { authorizationModule } from "./index.js";
import {
  accessRoles,
  actionsForResource,
  defaultActions,
  permissionActions,
  policyEnforcer,
  resourceTypes,
} from "./policy.js";

test("Casbin denies unknown roles/actions and respects explicit policy snapshots without leaking grants", async () => {
  const engine = await policyEnforcer();
  for (const kind of resourceTypes)
    for (const role of ["owner", ...accessRoles, ...permissionActions, "unknown"])
      for (const action of permissionActions)
        assert.equal(
          await engine.enforce([role], kind, action),
          defaultActions(kind, role).includes(action),
          `${kind}/${role}/${action}`,
        );
  assert.equal(await engine.enforce([], "document", "read"), false);
  assert.equal(await engine.enforce(["admin"], "document", "unknown"), false);
  const customized = await policyEnforcer([
    { resourceType: "document", role: "editor", actions: ["read"] },
  ]);
  assert.equal(await customized.enforce(["editor"], "document", "write"), false);
  assert.equal(await engine.enforce(["editor"], "document", "write"), true);
});

test(
  "real PostgreSQL migrations, SQL/Casbin parity, direct API requests, roles and permission administration",
  { timeout: 120_000 },
  async (t) => {
    const testUrl = process.env.AUTHORIZATION_TEST_DATABASE_URL;
    if (
      testUrl &&
      (!/^\/zhishu_permission_test_[a-z0-9_]+$/.test(new URL(testUrl).pathname) ||
        !["127.0.0.1", "localhost"].includes(new URL(testUrl).hostname))
    )
      throw new Error("Authorization integration tests require an isolated local test database");
    const pool = testUrl ? new Pool({ connectionString: testUrl, max: 12 }) : undefined;
    const memory = pool ? undefined : new PGlite();
    const pg = {
      exec: async (query: string) => {
        if (memory) await memory.exec(query);
        else await pool!.query(query);
      },
      query: async <T extends Record<string, unknown>>(query: string): Promise<{ rows: T[] }> =>
        memory ? memory.query<T>(query) : pool!.query<T>(query),
      close: () => (memory ? memory.close() : pool!.end()),
    };
    const db = (pool
      ? postgresDrizzle(pool, { schema })
      : drizzle(memory!, { schema })) as unknown as Database;
    const app = Fastify({ logger: false });
    try {
      const journal = JSON.parse(
        await readFile("database/migrations/meta/_journal.json", "utf8"),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries) {
        if (tag.startsWith("0039")) {
          await pg.exec(`insert into documents (tenant_id,id,workspace_id,catalog_id,title,created_by,access_mode) values ('migration','doc_inherited','ws_old','cat_old','团队文档','reader','workspace-inherited');
            insert into workspaces (tenant_id,id,name,kind,created_by) values ('migration','ws_system','旧系统空间','team','system');
            insert into catalogs (tenant_id,id,workspace_id,name,position,created_by) values ('migration','cat_system','ws_system','根目录',0,'system');
            insert into documents (tenant_id,id,workspace_id,catalog_id,title,created_by,access_mode) values ('migration','doc_system','ws_system','cat_system','旧无所有者空间文档','reader','workspace-inherited');`);
        }
        if (tag.startsWith("0038")) {
          await pg.exec(`insert into workspaces (tenant_id,id,name,kind,created_by) values ('migration','ws_old','旧空间','team','owner');
          insert into catalogs (tenant_id,id,workspace_id,name,position,created_by) values ('migration','cat_old','ws_old','根目录',0,'owner');
          insert into documents (tenant_id,id,workspace_id,catalog_id,title,created_by) values ('migration','doc_old','ws_old','cat_old','旧文档','owner');
          insert into workspace_members (tenant_id,workspace_id,identity_id,display_name,role,created_at) values ('migration','ws_old','reader','读者','viewer','2025-01-02');
          insert into document_acl (tenant_id,document_id,identity_id,action,granted_by,granted_at) values ('migration','doc_old','reader','export','owner','2025-01-03');`);
        }
        await pg.exec(await readFile(`database/migrations/${tag}.sql`, "utf8"));
      }
      const migrated = await pg.query<{ role: string; created_by: string; year: number }>(
        "select role,created_by,extract(year from created_at)::int as year from resource_acl where tenant_id='migration' and identity_id='reader' and created_by <> 'migration:explicit-document-managers' order by role",
      );
      assert.deepEqual(
        migrated.rows.map((r) => [r.role, r.year]),
        [
          ["export", 2025],
          ["viewer", 2025],
        ],
      );
      assert.equal(
        (await pg.query<{ old: null }>("select to_regclass('workspace_members') as old")).rows[0]
          ?.old,
        null,
      );
      assert.equal(
        await hasDocumentPermission(
          db,
          { tenantId: "migration", identityId: "owner" },
          "doc_old",
          "manage",
        ),
        true,
      );
      assert.equal(
        await hasDocumentPermission(
          db,
          { tenantId: "migration", identityId: "reader" },
          "doc_inherited",
          "write",
        ),
        false,
      );
      assert.equal(
        await hasDocumentPermission(
          db,
          { tenantId: "migration", identityId: "reader" },
          "doc_system",
          "manage",
        ),
        true,
      );
      assert.equal(
        (await pg.query<{ old: null }>("select to_regclass('document_acl') as old")).rows[0]?.old,
        null,
      );
      await assert.rejects(
        pg.exec(
          "insert into resource_acl(tenant_id,identity_id,role,created_by) values ('migration','x','viewer','owner')",
        ),
      );
      await assert.rejects(
        pg.exec(
          "insert into resource_acl(tenant_id,workspace_id,identity_id,role,created_by) values ('other','ws_old','x','viewer','owner')",
        ),
      );

      const principals = new Map(
        ["owner", "admin", "editor", "viewer", "guest", "other"].map((identityId) => [
          identityId,
          {
            identityId,
            tenantId: identityId === "other" ? "other" : "test",
            username: identityId,
            displayName: identityId,
            email: `${identityId}@example.test`,
            active: true,
            globalRoles: [],
          } satisfies Principal,
        ]),
      );
      await db.insert(schema.identityProfiles).values(
        [...principals.values()].map((p) => ({
          tenantId: p.tenantId,
          identityId: p.identityId,
          displayName: p.displayName,
          email: p.email,
        })),
      );
      app.decorate("db", db);
      app.decorateRequest("principal", null);
      app.addHook("onRequest", async (request) => {
        request.principal = principals.get(request.headers.authorization ?? "") ?? null;
      });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      registerErrorHandlers(app);
      const revoked: string[] = [];
      let liveRoom: ReturnType<typeof createCollaborationServer> | undefined;
      const revoker = {
        revokeDocumentSessions(id: string, generationId: string, identityId?: string) {
          revoked.push(id);
          liveRoom?.revokeDocumentSessions(id, generationId, identityId);
        },
      };
      await app.register(
        async (api) => {
          await authorizationModule(api, revoker);
          await workspacesModule(api, revoker);
          await catalogsModule(api, revoker);
          await knowledgeModule(
            api,
            loadConfig({
              NODE_ENV: "test",
              AUTH_MODE: "external",
              DATABASE_URL: "postgresql://unused/test",
              LOG_LEVEL: "silent",
            }),
            revoker,
          );
          await documentsModule(
            api,
            loadConfig({
              NODE_ENV: "test",
              AUTH_MODE: "external",
              DATABASE_URL: "postgresql://unused/test",
              LOG_LEVEL: "silent",
            }),
            revoker,
            true,
          );
        },
        { prefix: "/api" },
      );
      async function call(
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: string,
        body?: object,
        identity = "owner",
        expected = 200,
      ) {
        const response = await app.inject({
          method,
          url: `/api${path}`,
          headers: { authorization: identity },
          ...(body ? { payload: body } : {}),
        });
        assert.equal(
          response.statusCode,
          expected,
          `${identity} ${method} ${path}: ${response.body}`,
        );
        return response;
      }
      const space = (
        await call(
          "POST",
          "/knowledge/workspaces",
          { name: "权限空间", kind: "team" },
          "owner",
          201,
        )
      ).json<{ id: string; rootCatalogId: string }>();
      for (const role of accessRoles)
        await call("PUT", `/knowledge/workspaces/${space.id}/members/${role}`, {
          role,
          displayName: role,
        });
      const doc = (
        await call(
          "POST",
          "/documents",
          { title: "受保护文档", workspaceId: space.id },
          "owner",
          201,
        )
      ).json<{ id: string; metadataRevision: number }>();
      const path = `/documents/${doc.id}`;
      await db
        .insert(schema.resourceAcl)
        .values({
          tenantId: "test",
          workspaceId: "ws_default",
          identityId: "owner",
          role: "admin",
          createdBy: "owner",
        })
        .onConflictDoNothing();
      await t.test(
        "workspace and catalog receipts replay safely across operation, actor and tenant scopes",
        async () => {
          const key = "shared-create-receipt";
          async function create(url: string, payload: object, identity = "owner", expected = 201) {
            const response = await app.inject({
              method: "POST",
              url: `/api${url}`,
              headers: { authorization: identity, "idempotency-key": key },
              payload,
            });
            assert.equal(response.statusCode, expected, response.body);
            return response.json<{ id: string }>();
          }
          const input = { name: "幂等空间", kind: "team" };
          const created = await create("/knowledge/workspaces", input);
          assert.deepEqual(await create("/knowledge/workspaces", input), created);
          await create("/knowledge/workspaces", { ...input, name: "不同请求" }, "owner", 409);
          for (const identity of ["admin", "other"])
            assert.notEqual(
              (await create("/knowledge/workspaces", input, identity)).id,
              created.id,
            );

          const catalogs = `/knowledge/workspaces/${created.id}/catalogs`;
          const catalog = await create(catalogs, { name: "幂等目录" });
          assert.deepEqual(await create(catalogs, { name: "幂等目录" }), catalog);
          await create(catalogs, { name: "不同目录" }, "owner", 409);
          assert.equal(
            (await app.inject({ method: "GET", url: "/api/knowledge/workspaces" })).statusCode,
            401,
          );
        },
      );
      await t.test(
        "template copy and cross-workspace transfer require export and a current permission preview",
        async () => {
          const source = (
            await call(
              "POST",
              "/documents",
              { title: "数据搬运验收", workspaceId: space.id },
              "owner",
              201,
            )
          ).json<{ id: string; metadataRevision: number }>();
          await call("PUT", `/documents/${source.id}/acl/guest`, { actions: ["read"] });
          await call("POST", `/documents/${source.id}/copy`, {}, "guest", 404);
          const destination = (
            await call(
              "POST",
              "/knowledge/workspaces",
              { name: "搬运目标", kind: "team" },
              "owner",
              201,
            )
          ).json<{ id: string; rootCatalogId: string }>();
          const input = {
            workspaceId: destination.id,
            catalogId: destination.rootCatalogId,
            metadataRevision: source.metadataRevision,
          };
          await call("PATCH", `/knowledge/documents/${source.id}/location`, input, "owner", 409);
          const preview = (
            await call("POST", "/knowledge/transfer-preview", {
              kind: "document",
              resourceId: source.id,
              targetCatalogId: destination.rootCatalogId,
            })
          ).json<{ token: string; preservedDirectSubjectCount: number }>();
          assert.equal(preview.preservedDirectSubjectCount, 1);
          await call("PUT", `/documents/${source.id}/acl/guest`, { actions: ["read", "comment"] });
          await call(
            "PATCH",
            `/knowledge/documents/${source.id}/location`,
            { ...input, authorizationPreview: preview.token },
            "owner",
            409,
          );
          const refreshed = (
            await call("POST", "/knowledge/transfer-preview", {
              kind: "document",
              resourceId: source.id,
              targetCatalogId: destination.rootCatalogId,
            })
          ).json<{ token: string }>();
          await call("PATCH", `/knowledge/documents/${source.id}/location`, {
            ...input,
            authorizationPreview: refreshed.token,
          });
          await call("GET", `/documents/${source.id}`, undefined, "guest");
          const branch = (
            await call(
              "POST",
              `/knowledge/workspaces/${space.id}/catalogs`,
              { name: "子树搬运", parentId: space.rootCatalogId },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const child = (
            await call(
              "POST",
              `/knowledge/workspaces/${space.id}/catalogs`,
              { name: "嵌套目录", parentId: branch.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const nested = (
            await call(
              "POST",
              "/documents",
              { title: "子树文档", workspaceId: space.id, catalogId: child.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await db.insert(schema.resourceAcl).values({
            tenantId: "test",
            catalogId: branch.id,
            identityId: "guest",
            role: "move",
            createdBy: "owner",
          });
          const transfer = {
            kind: "catalog",
            resourceId: branch.id,
            targetCatalogId: destination.rootCatalogId,
          };
          await call("POST", "/knowledge/transfer-preview", transfer, "guest", 404);
          const links: string[] = [];
          for (const kind of ["invite", "access"] as const) {
            const link = (
              await call(
                "POST",
                `/documents/${nested.id}/shares`,
                {
                  kind,
                  permission: kind === "access" ? "edit" : "read",
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                },
                "owner",
                201,
              )
            ).json<{ id: string }>();
            links.push(link.id);
            await call("POST", `/shares/${link.id}/join`, undefined, "guest");
          }
          await call(
            "PATCH",
            `/knowledge/catalogs/${branch.id}/location`,
            { parentId: destination.rootCatalogId },
            "owner",
            409,
          );
          const impact = (await call("POST", "/knowledge/transfer-preview", transfer)).json<{
            token: string;
            documentCount: number;
          }>();
          assert.equal(impact.documentCount, 1);
          await call("PATCH", `/knowledge/catalogs/${branch.id}/location`, {
            parentId: destination.rootCatalogId,
            authorizationPreview: impact.token,
          });
          const [moved] = await db
            .select()
            .from(schema.documents)
            .where(eq(schema.documents.id, nested.id));
          const [movedChild] = await db
            .select()
            .from(schema.catalogs)
            .where(eq(schema.catalogs.id, child.id));
          assert.equal(moved?.workspaceId, destination.id);
          assert.equal(movedChild?.workspaceId, destination.id);
          for (const id of links) {
            const [link] = await db
              .select()
              .from(schema.documentShares)
              .where(eq(schema.documentShares.id, id));
            assert.ok(link?.revokedAt);
          }
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, nested.id, "write"),
            false,
          );
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, nested.id, "read"),
            true,
          );
        },
      );
      if (pool) {
        const waitForBlocked = async (count: number) => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const result = await pool.query<{ count: number }>(
              "select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event='advisory'",
            );
            if ((result.rows[0]?.count ?? 0) >= count) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.fail("Expected concurrent PostgreSQL advisory lock waiters");
        };
        await t.test(
          "real multi-connection revoke wins before a queued join and member removal before a queued write",
          async () => {
            const link = (
              await call(
                "POST",
                `${path}/shares`,
                {
                  kind: "access",
                  permission: "edit",
                  expiresAt: new Date(Date.now() + 3600000).toISOString(),
                },
                "owner",
                201,
              )
            ).json<{ id: string }>();
            const blocker = await pool.connect();
            try {
              await blocker.query("begin");
              await blocker.query(
                "select pg_advisory_xact_lock(hashtextextended('knowledge-tree:test',718268))",
              );
              const revoke = call("DELETE", `${path}/shares/${link.id}`, undefined, "owner", 204);
              await waitForBlocked(1);
              const join = call("POST", `/shares/${link.id}/join`, undefined, "guest", 404);
              await waitForBlocked(2);
              await blocker.query("commit");
              await Promise.all([revoke, join]);
              assert.equal(
                (
                  await db
                    .select()
                    .from(schema.resourceAcl)
                    .where(eq(schema.resourceAcl.sourceShareId, link.id))
                ).length,
                0,
              );
              const editable = (
                await call(
                  "POST",
                  "/documents",
                  { title: "并发成员撤权", workspaceId: space.id },
                  "editor",
                  201,
                )
              ).json<{ id: string; metadataRevision: number }>();
              await blocker.query("begin");
              await blocker.query(
                "select pg_advisory_xact_lock(hashtextextended('knowledge-tree:test',718268))",
              );
              const write = call(
                "PATCH",
                `/documents/${editable.id}`,
                { title: "不应提交", metadataRevision: editable.metadataRevision },
                "editor",
                404,
              );
              await waitForBlocked(1);
              await blocker.query(
                "delete from resource_acl where tenant_id=$1 and workspace_id=$2 and identity_id=$3",
                ["test", space.id, "editor"],
              );
              await blocker.query("commit");
              await write;
              assert.equal(
                (
                  await db
                    .select()
                    .from(schema.documents)
                    .where(eq(schema.documents.id, editable.id))
                )[0]?.title,
                "并发成员撤权",
              );
              await call("PUT", `/knowledge/workspaces/${space.id}/members/editor`, {
                role: "editor",
                displayName: "editor",
              });
            } finally {
              await blocker.query("rollback");
              blocker.release();
            }
          },
        );
        await t.test(
          "real WebSocket writes get durable acknowledgement, revoked and read-only writes do not",
          async () => {
            const port = await new Promise<number>((resolve, reject) => {
              const server = createServer();
              server.on("error", reject);
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") throw new Error("Missing port");
                server.close(() => resolve(address.port));
              });
            });
            const config = loadConfig({
              NODE_ENV: "test",
              AUTH_MODE: "external",
              DATABASE_URL: testUrl!,
              LOG_LEVEL: "silent",
              COLLABORATION_PORT: String(port),
              COLLABORATION_HOST: "127.0.0.1",
            });
            liveRoom = createCollaborationServer(config, db, pool);
            await liveRoom.listen();
            const providers: HocuspocusProvider[] = [];
            const outbox = new AuthorizationEventWorker(db, liveRoom, () => undefined);
            await outbox.start();
            const payload = {
              type: "doc" as const,
              content: [
                {
                  type: "paragraph" as const,
                  attrs: { blockId: "block_permission_ws", align: "left" },
                  content: [{ type: "text" as const, text: "已授权的正文" }],
                },
              ],
            };
            try {
              const imported = (
                await call("POST", "/documents/import", {
                  format: "zhishu.document",
                  formatVersion: 1,
                  title: "真实协同验收",
                  schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
                  extensions: [],
                  content: payload,
                })
              ).json<{ document: { id: string; generationId: string } }>();
              const created = imported.document;
              assert.ok(created, JSON.stringify(imported));
              await call("PUT", `/documents/${created.id}/acl/guest`, { role: "editor" });
              await call("PUT", `/documents/${created.id}/acl/viewer`, { role: "viewer" });
              const seq = async () =>
                Number(
                  (
                    await pool.query<{ durable_seq: string }>(
                      "select durable_seq from document_generations where id=$1",
                      [created.generationId],
                    )
                  ).rows[0]?.durable_seq ?? 0,
                );
              const connect = async (identity: string) => {
                const ticket = (
                  await call(
                    "POST",
                    `/documents/${created.id}/collaboration-session`,
                    {},
                    identity,
                    201,
                  )
                ).json<{ documentName: string; token: string }>();
                const doc = new Y.Doc();
                let provider: HocuspocusProvider;
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(
                    () => reject(new Error("WebSocket sync timed out")),
                    8000,
                  );
                  provider = new HocuspocusProvider({
                    url: `ws://127.0.0.1:${port}`,
                    name: ticket.documentName,
                    document: doc,
                    token: ticket.token,
                    onSynced: ({ state }) => {
                      if (state) {
                        clearTimeout(timer);
                        resolve();
                      }
                    },
                    onAuthenticationFailed: () => {
                      clearTimeout(timer);
                      reject(new Error("WebSocket auth failed"));
                    },
                  });
                  providers.push(provider);
                });
                return { doc, provider: provider! };
              };
              const writer = await connect("guest");
              let receipts = 0;
              writer.provider.on("stateless", ({ payload }: { payload: string }) => {
                if (JSON.parse(payload).type === "persisted") receipts++;
              });
              const initialSeq = await seq();
              const paragraph = writer.doc.getXmlFragment("content").get(0) as Y.XmlElement;
              const text = paragraph.get(0) as Y.XmlText;
              text.insert(text.length, " 合法追加");
              const deadline = Date.now() + 8000;
              while ((await seq()) <= initialSeq && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 25));
              assert.ok((await seq()) > initialSeq);
              await new Promise((resolve) => setTimeout(resolve, 100));
              assert.ok(receipts > 0);
              const before = await seq();
              const beforeReceipts = receipts;
              await db.transaction(async (tx) => {
                await tx.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended('knowledge-tree:test',718268))`,
                );
                await tx
                  .delete(schema.resourceAcl)
                  .where(
                    and(
                      eq(schema.resourceAcl.tenantId, "test"),
                      eq(schema.resourceAcl.documentId, created.id),
                      eq(schema.resourceAcl.identityId, "guest"),
                    ),
                  );
              });
              text.insert(text.length, " 撤权后的写入");
              await outbox.poll();
              await new Promise((resolve) => setTimeout(resolve, 400));
              assert.equal(await seq(), before);
              assert.equal(receipts, beforeReceipts);
              const reader = await connect("viewer");
              let readerReceipts = 0;
              reader.provider.on("stateless", ({ payload }: { payload: string }) => {
                if (JSON.parse(payload).type === "persisted") readerReceipts++;
              });
              const readerText = (reader.doc.getXmlFragment("content").get(0) as Y.XmlElement).get(
                0,
              ) as Y.XmlText;
              readerText.insert(readerText.length, " 只读伪造");
              await new Promise((resolve) => setTimeout(resolve, 400));
              assert.equal(await seq(), before);
              assert.equal(readerReceipts, 0);
            } finally {
              for (const provider of providers) provider.destroy();
              await outbox.stop();
              await liveRoom.close();
              liveRoom = undefined;
            }
          },
        );
      }
      await t.test(
        "access links retain separate sources, expire live, and never erase manual or invitation grants",
        async () => {
          const created = (
            await call(
              "POST",
              "/documents",
              { title: "分享来源验收", workspaceId: space.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const sourcePath = `/documents/${created.id}`;
          const expiry = new Date(Date.now() + 3600000).toISOString();
          const edit = (
            await call(
              "POST",
              `${sourcePath}/shares`,
              { kind: "access", permission: "edit", expiresAt: expiry },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const read = (
            await call(
              "POST",
              `${sourcePath}/shares`,
              { kind: "access", permission: "read", expiresAt: expiry },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await call("POST", `/shares/${edit.id}/join`, undefined, "guest");
          await call("POST", `/shares/${read.id}/join`, undefined, "guest");
          await call("PUT", `${sourcePath}/acl/guest`, { actions: ["read"] });
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "write"),
            true,
          );
          await call("DELETE", `${sourcePath}/shares/${edit.id}`, undefined, "owner", 204);
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "write"),
            false,
          );
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "read"),
            true,
          );
          await db
            .update(schema.documentShares)
            .set({
              createdAt: new Date(Date.now() - 120000),
              expiresAt: new Date(Date.now() - 60000),
            })
            .where(eq(schema.documentShares.id, read.id));
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "read"),
            true,
          );
          await call("DELETE", `${sourcePath}/acl/guest`, undefined, "owner", 204);
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "read"),
            false,
          );
          const invited = (
            await call(
              "POST",
              `${sourcePath}/shares`,
              { kind: "invite", permission: "edit", expiresAt: expiry },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await call("POST", `/shares/${invited.id}/join`, undefined, "guest");
          await call("DELETE", `${sourcePath}/shares/${invited.id}`, undefined, "owner", 204);
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "write"),
            true,
          );
          await call("DELETE", `${sourcePath}/acl/guest`, undefined, "owner", 204);
          const delegated = (
            await call(
              "POST",
              `${sourcePath}/shares`,
              { kind: "access", permission: "edit", expiresAt: expiry },
              "admin",
              201,
            )
          ).json<{ id: string }>();
          await call("POST", `/shares/${delegated.id}/join`, undefined, "guest");
          await call("PUT", `${sourcePath}/acl/guest`, { actions: ["read", "share"] });
          await call(
            "POST",
            `${sourcePath}/shares`,
            { kind: "access", permission: "edit", expiresAt: expiry },
            "guest",
            404,
          );
          await call("PUT", `/knowledge/workspaces/${space.id}/members/admin`, {
            role: "viewer",
            displayName: "admin",
          });
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "write"),
            false,
          );
          await call("PUT", `/knowledge/workspaces/${space.id}/members/admin`, {
            role: "admin",
            displayName: "admin",
          });
          await call("DELETE", `${sourcePath}/acl/guest`, undefined, "owner", 204);
        },
      );
      await t.test(
        "ownership, explicit recovery, security configuration and audit preserve independent governance",
        async () => {
          const scope = (
            await call(
              "POST",
              "/knowledge/workspaces",
              { name: "治理验收", kind: "team" },
              "owner",
              201,
            )
          ).json<{ id: string; authorizationRevision: number }>();
          await call("PUT", `/knowledge/workspaces/${scope.id}/members/admin`, {
            role: "editor",
            displayName: "admin",
          });
          const privateDoc = (
            await call(
              "POST",
              "/documents",
              { title: "受限治理验收", workspaceId: scope.id },
              "owner",
              201,
            )
          ).json<{ id: string; metadataRevision: number }>();
          await call("PUT", `/documents/${privateDoc.id}/acl/guest`, { role: "admin" });
          await call("PATCH", `/documents/${privateDoc.id}/access`, {
            accessMode: "restricted",
            metadataRevision: privateDoc.metadataRevision,
          });
          await call("GET", `/documents/${privateDoc.id}`, undefined, "owner", 404);
          await call(
            "POST",
            `/documents/${privateDoc.id}/governance-recovery`,
            { reason: "团队管理员紧急恢复管理" },
            "admin",
            404,
          );
          await call("POST", `/documents/${privateDoc.id}/governance-recovery`, {
            reason: "团队所有者紧急恢复管理",
          });
          await call("GET", `/documents/${privateDoc.id}`);
          const state = () =>
            call("GET", "/knowledge/authorization-state").then((r) =>
              r
                .json<{ workspaceId: string; revision: number }[]>()
                .find((s) => s.workspaceId === scope.id)!,
            );
          await call(
            "POST",
            `/knowledge/workspaces/${scope.id}/ownership`,
            { identityId: "admin", revision: scope.authorizationRevision },
            "owner",
            409,
          );
          await call("POST", `/knowledge/workspaces/${scope.id}/ownership`, {
            identityId: "admin",
            revision: (await state()).revision,
          });
          const [stored] = await db
            .select()
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, scope.id));
          assert.equal(stored?.createdBy, "owner");
          assert.equal(stored?.ownerIdentityId, "admin");
          await call(
            "PUT",
            `/knowledge/workspaces/${scope.id}/permissions/document/editor`,
            { actions: ["read"] },
            "owner",
            404,
          );
          const scopes = (
            await call("GET", "/knowledge/authorization-state", undefined, "admin")
          ).json<{ workspaceId: string; revision: number }[]>();
          await call(
            "PUT",
            `/knowledge/workspaces/${scope.id}/security`,
            {
              revision: scopes.find((s) => s.workspaceId === scope.id)!.revision,
              offlineCacheAllowed: false,
            },
            "admin",
          );
          assert.equal(
            (await call("GET", `/documents/${privateDoc.id}`)).json<{
              offlineCacheAllowed: boolean;
            }>().offlineCacheAllowed,
            false,
          );
          const audit = (
            await call(
              "GET",
              `/knowledge/workspaces/${scope.id}/authorization-audit`,
              undefined,
              "admin",
            )
          ).json<{ items: { operation: string }[] }>();
          assert.ok(audit.items.some((e) => e.operation === "document.governance-recovery"));
          await call(
            "GET",
            `/knowledge/workspaces/${scope.id}/authorization-audit`,
            undefined,
            "viewer",
            404,
          );
          await call("GET", `/documents/${privateDoc.id}/authorization`);
        },
      );
      await t.test(
        "trusted inactive identity invalidates stored permissions and broadcasts lifecycle changes",
        async () => {
          const principal = principals.get("editor")!;
          assert.equal(await hasDocumentPermission(db, principal, doc.id, "write"), true);
          const invalidated: string[] = [];
          const worker = new AuthorizationEventWorker(
            db,
            { revokeDocumentSessions: (id) => invalidated.push(id) },
            () => undefined,
          );
          const guarded = Fastify({ logger: false });
          guarded.decorate("db", db);
          registerErrorHandlers(guarded);
          registerIdentityGuard(guarded, { authenticate: () => ({ ...principal, active: false }) });
          guarded.get("/protected", async () => ({ ok: true }));
          await worker.start();
          try {
            const response = await guarded.inject({ url: "/protected" });
            assert.equal(response.statusCode, 401);
            assert.equal(await hasDocumentPermission(db, principal, doc.id, "read"), false);
            await call("GET", path, undefined, "editor", 404);
            await worker.poll();
            assert.ok(invalidated.includes(doc.id));
            await rememberIdentities(db, [principal]);
            assert.equal(await hasDocumentPermission(db, principal, doc.id, "write"), true);
          } finally {
            await guarded.close();
            await rememberIdentities(db, [principal]);
            await worker.stop();
          }
        },
      );
      await t.test(
        "access link expiry invalidates live rooms without a subsequent database mutation",
        async () => {
          const created = (
            await call(
              "POST",
              "/documents",
              { title: "自然过期", workspaceId: space.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await call("PUT", `${path}/acl/guest`, { actions: ["read"] });
          const expiresAt = new Date(Date.now() + 2500);
          const share = (
            await call(
              "POST",
              `/documents/${created.id}/shares`,
              { kind: "access", permission: "read", expiresAt: expiresAt.toISOString() },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await call("POST", `/shares/${share.id}/join`, undefined, "guest");
          type Scope = {
            workspaceId: string;
            revision: number;
            expiryRevision: string;
            nextExpiryAt: string | null;
          };
          const before = (await call("GET", "/knowledge/authorization-state", undefined, "guest"))
            .json<Scope[]>()
            .find((s) => s.workspaceId === space.id)!;
          assert.equal(new Date(before.nextExpiryAt!).getTime(), expiresAt.getTime());
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, created.id, "read"),
            true,
          );
          const invalidated: string[] = [];
          const worker = new AuthorizationEventWorker(
            db,
            { revokeDocumentSessions: (id) => invalidated.push(id) },
            () => undefined,
          );
          await worker.start();
          try {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 100)),
            );
            await worker.poll();
            assert.ok(invalidated.includes(created.id));
            assert.equal(
              await hasDocumentPermission(db, principals.get("guest")!, created.id, "read"),
              false,
            );
            const acl = (await call("GET", `/documents/${created.id}/acl`)).json<
              { identityId: string }[]
            >();
            assert.equal(
              acl.some((entry) => entry.identityId === "guest"),
              false,
            );
            const after = (await call("GET", "/knowledge/authorization-state", undefined, "guest"))
              .json<Scope[]>()
              .find((s) => s.workspaceId === space.id)!;
            assert.equal(after.revision, before.revision);
            assert.notEqual(after.expiryRevision, before.expiryRevision);
            assert.equal(after.nextExpiryAt, null);
          } finally {
            await worker.stop();
            await call("DELETE", `${path}/acl/guest`, undefined, "owner", 204);
          }
        },
      );
      await t.test(
        "independent outbox consumers each invalidate permissions after commit",
        async () => {
          const a: string[] = [],
            b: string[] = [];
          const first = new AuthorizationEventWorker(
            db,
            { revokeDocumentSessions: (id) => a.push(id) },
            () => undefined,
          );
          const second = new AuthorizationEventWorker(
            db,
            { revokeDocumentSessions: (id) => b.push(id) },
            () => undefined,
          );
          await first.start();
          await second.start();
          try {
            await call("PUT", `${path}/acl/guest`, { role: "viewer" });
            await first.poll();
            await second.poll();
            assert.ok(a.includes(doc.id));
            assert.ok(b.includes(doc.id));
            await call("DELETE", `${path}/acl/guest`, undefined, "owner", 204);
            const doomed = (
              await call(
                "POST",
                "/documents",
                { title: "代次与删除广播", workspaceId: space.id },
                "owner",
                201,
              )
            ).json<{ id: string }>();
            await db
              .update(schema.documentGenerations)
              .set({ status: "retired" })
              .where(eq(schema.documentGenerations.documentId, doomed.id));
            await first.poll();
            await second.poll();
            assert.ok(a.includes(doomed.id), "retired generations must still be closed");
            assert.ok(b.includes(doomed.id));
            await db
              .update(schema.documentGenerations)
              .set({ status: "active" })
              .where(eq(schema.documentGenerations.documentId, doomed.id));
            await first.poll();
            await second.poll();
            a.length = 0;
            b.length = 0;
            await db.delete(schema.documents).where(eq(schema.documents.id, doomed.id));
            await first.poll();
            await second.poll();
            assert.ok(
              a.includes(doomed.id),
              "deleted document generation ids must survive in the outbox",
            );
            assert.ok(b.includes(doomed.id));
          } finally {
            await first.stop();
            await second.stop();
          }
        },
      );
      await t.test(
        "sharing a private document discloses no workspace or ancestor metadata across discovery endpoints",
        async () => {
          const privateSpace = (
            await call(
              "POST",
              "/knowledge/workspaces",
              { name: "保密个人空间", description: "机密空间描述", icon: "🔒", kind: "personal" },
              "owner",
              201,
            )
          ).json<{ id: string; rootCatalogId: string }>();
          const folder = (
            await call(
              "POST",
              `/knowledge/workspaces/${privateSpace.id}/catalogs`,
              { name: "机密项目名称", parentId: privateSpace.rootCatalogId },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const shared = (
            await call(
              "POST",
              "/documents",
              { title: "边界验收共享内容", workspaceId: privateSpace.id, catalogId: folder.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await call(
            "POST",
            "/documents",
            { title: "边界验收未共享内容", workspaceId: privateSpace.id, catalogId: folder.id },
            "owner",
            201,
          );
          await call("PUT", `/documents/${shared.id}/acl/guest`, { role: "viewer" });
          await call("GET", `/documents/${shared.id}`, undefined, "guest");
          await call("PUT", `/documents/${shared.id}/favorite`, undefined, "guest", 204);
          const spaces = (await call("GET", "/knowledge/workspaces", undefined, "guest")).json<
            { id: string }[]
          >();
          assert.equal(
            spaces.some((s) => s.id === privateSpace.id),
            false,
          );
          const located = (
            await call("GET", `/knowledge/documents/${shared.id}/locate`, undefined, "guest")
          ).json<{
            catalogId: string | null;
            catalogPath: unknown[];
            workspaceName: string;
            workspaceIcon: string | null;
          }>();
          assert.equal(located.catalogId, null);
          assert.deepEqual(located.catalogPath, []);
          assert.equal(located.workspaceName, "与我共享");
          assert.equal(located.workspaceIcon, null);
          for (const view of ["all", "recent", "favorites"]) {
            const result = (
              await call(
                "GET",
                `/documents?view=${view}&workspaceId=${privateSpace.id}&limit=1`,
                undefined,
                "guest",
              )
            ).json<{ hasMore: boolean; items: { id: string; workspaceName: string }[] }>();
            assert.deepEqual(
              result.items.map((item) => item.id),
              [shared.id],
            );
            assert.equal(result.items[0]?.workspaceName, "与我共享");
            assert.equal(result.hasMore, false);
          }
          const search = (
            await call(
              "GET",
              `/knowledge/search?q=${encodeURIComponent("边界验收")}&limit=1`,
              undefined,
              "guest",
            )
          ).json<{
            hasMore: boolean;
            items: { id: string; workspaceName: string; path: string[] }[];
          }>();
          assert.deepEqual(
            search.items.map((item) => item.id),
            [shared.id],
          );
          assert.equal(search.hasMore, false);
          assert.equal(search.items[0]?.workspaceName, "与我共享");
          assert.deepEqual(search.items[0]?.path, []);
          for (const catalogId of [privateSpace.rootCatalogId, folder.id])
            await call(
              "GET",
              `/knowledge/workspaces/${privateSpace.id}/catalogs/${catalogId}/children`,
              undefined,
              "guest",
              404,
            );
          await call("GET", `/knowledge/documents/${shared.id}/locate`, undefined, "other", 404);
          const ownerLocation = (
            await call("GET", `/knowledge/documents/${shared.id}/locate`)
          ).json<{ catalogPath: { id: string }[]; workspaceName: string }>();
          assert.deepEqual(
            ownerLocation.catalogPath.map((segment) => segment.id),
            [privateSpace.rootCatalogId, folder.id],
          );
          assert.equal(ownerLocation.workspaceName, "保密个人空间");
          await call("DELETE", `/documents/${shared.id}/acl/guest`, undefined, "owner", 204);
          for (const view of ["all", "recent", "favorites"])
            assert.deepEqual(
              (
                await call(
                  "GET",
                  `/documents?view=${view}&workspaceId=${privateSpace.id}`,
                  undefined,
                  "guest",
                )
              ).json<{ items: unknown[] }>().items,
              [],
            );
        },
      );
      await t.test(
        "a visible child path omits restricted ancestors without granting tree traversal",
        async () => {
          const parent = (
            await call(
              "POST",
              `/knowledge/workspaces/${space.id}/catalogs`,
              { name: "隐藏父目录", parentId: space.rootCatalogId },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const child = (
            await call(
              "POST",
              `/knowledge/workspaces/${space.id}/catalogs`,
              { name: "可见子目录", parentId: parent.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const visibleDoc = (
            await call(
              "POST",
              "/documents",
              { title: "目录边界验收", workspaceId: space.id, catalogId: child.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await db.insert(schema.resourceAcl).values([
            {
              tenantId: "test",
              catalogId: parent.id,
              identityId: "owner",
              role: "admin",
              createdBy: "owner",
            },
            {
              tenantId: "test",
              catalogId: child.id,
              identityId: "viewer",
              role: "viewer",
              createdBy: "owner",
            },
          ]);
          await db
            .update(schema.catalogs)
            .set({ accessMode: "restricted" })
            .where(eq(schema.catalogs.id, parent.id));
          const location = (
            await call("GET", `/knowledge/documents/${visibleDoc.id}/locate`, undefined, "viewer")
          ).json<{
            catalogId: string | null;
            catalogPath: { id: string }[];
            workspaceName: string;
          }>();
          assert.deepEqual(
            location.catalogPath.map((segment) => segment.id),
            [space.rootCatalogId, child.id],
          );
          assert.equal(location.catalogId, child.id);
          assert.equal(location.workspaceName, "权限空间");
          const searched = (
            await call(
              "GET",
              `/knowledge/search?q=${encodeURIComponent("目录边界验收")}`,
              undefined,
              "viewer",
            )
          ).json<{ items: { path: string[] }[] }>();
          assert.deepEqual(searched.items[0]?.path, ["可见子目录"]);
          const root = (
            await call(
              "GET",
              `/knowledge/workspaces/${space.id}/catalogs/${space.rootCatalogId}/children`,
              undefined,
              "viewer",
            )
          ).json<{ catalogs: { id: string }[] }>();
          assert.equal(
            root.catalogs.some((entry) => entry.id === parent.id),
            false,
          );
          await call(
            "GET",
            `/knowledge/workspaces/${space.id}/catalogs/${parent.id}/children`,
            undefined,
            "viewer",
            404,
          );
          await call(
            "GET",
            `/knowledge/workspaces/${space.id}/catalogs/${child.id}/children`,
            undefined,
            "viewer",
          );
          const container = (
            await call(
              "POST",
              `/knowledge/workspaces/${space.id}/catalogs`,
              { name: "空目录边界", parentId: space.rootCatalogId },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          const concealed = (
            await call(
              "POST",
              `/knowledge/workspaces/${space.id}/catalogs`,
              { name: "不可见子树", parentId: container.id },
              "owner",
              201,
            )
          ).json<{ id: string }>();
          await db
            .update(schema.catalogs)
            .set({ accessMode: "restricted" })
            .where(eq(schema.catalogs.id, concealed.id));
          const tree = (
            await call(
              "GET",
              `/knowledge/workspaces/${space.id}/catalogs/${space.rootCatalogId}/children`,
              undefined,
              "viewer",
            )
          ).json<{ catalogs: { id: string; hasChildren: boolean }[] }>();
          assert.equal(
            tree.catalogs.find((entry) => entry.id === container.id)?.hasChildren,
            false,
          );
        },
      );
      await t.test(
        "team creators follow current membership and explicit grants remain independently revocable",
        async () => {
          const created = (
            await call(
              "POST",
              "/documents",
              { title: "编辑成员创建", workspaceId: space.id },
              "editor",
              201,
            )
          ).json<{ id: string; canManage: boolean; canWrite: boolean }>();
          assert.equal(created.canManage, false);
          assert.equal(created.canWrite, true);
          const createdPath = `/documents/${created.id}`;
          await call("PUT", `/knowledge/workspaces/${space.id}/members/editor`, {
            role: "viewer",
            displayName: "editor",
          });
          assert.equal(
            (await call("GET", createdPath, undefined, "editor")).json<{ canWrite: boolean }>()
              .canWrite,
            false,
          );
          await call("PUT", `${createdPath}/acl/editor`, { actions: ["read"] });
          await call(
            "DELETE",
            `/knowledge/workspaces/${space.id}/members/editor`,
            undefined,
            "owner",
            204,
          );
          await call("GET", createdPath, undefined, "editor");
          await call("DELETE", `${createdPath}/acl/editor`, undefined, "owner", 204);
          for (const suffix of ["", "/content", "/versions", "/comments"])
            await call("GET", `${createdPath}${suffix}`, undefined, "editor", 404);
          await call("GET", `/knowledge/documents/${created.id}/locate`, undefined, "editor", 404);
          await call("POST", `${createdPath}/collaboration-session`, {}, "editor", 404);
          for (const action of permissionActions)
            assert.equal(
              await hasDocumentPermission(db, principals.get("editor")!, created.id, action),
              false,
            );
          for (const view of ["all", "mine", "recent", "favorites", "archived", "trash"]) {
            const list = (
              await call(
                "GET",
                `/documents?view=${view}&workspaceId=${space.id}`,
                undefined,
                "editor",
              )
            ).json<{ items: { id: string }[] }>();
            assert.equal(
              list.items.some((item) => item.id === created.id),
              false,
            );
          }
          await call("PUT", `/knowledge/workspaces/${space.id}/members/editor`, {
            role: "editor",
            displayName: "editor",
          });
        },
      );
      await t.test(
        "breaking inheritance and deleting or demoting the last manager roll back",
        async () => {
          const created = (
            await call(
              "POST",
              "/documents",
              { title: "管理连续性", workspaceId: space.id },
              "owner",
              201,
            )
          ).json<{ id: string; metadataRevision: number }>();
          const restrictedPath = `/documents/${created.id}`;
          await call(
            "PATCH",
            `${restrictedPath}/access`,
            { accessMode: "restricted", metadataRevision: created.metadataRevision },
            "owner",
            409,
          );
          assert.equal(
            (await call("GET", restrictedPath)).json<{ metadataRevision: number }>()
              .metadataRevision,
            created.metadataRevision,
          );
          await call("PUT", `${restrictedPath}/acl/guest`, { role: "admin" });
          await call("PATCH", `${restrictedPath}/access`, {
            accessMode: "restricted",
            metadataRevision: created.metadataRevision,
          });
          await call("GET", restrictedPath, undefined, "owner", 404);
          await call("DELETE", `${restrictedPath}/acl/guest`, undefined, "guest", 409);
          await call("PUT", `${restrictedPath}/acl/guest`, { role: "viewer" }, "guest", 409);
          assert.equal(
            (await call("GET", restrictedPath, undefined, "guest")).json<{ canManage: boolean }>()
              .canManage,
            true,
          );
          await call("PUT", `${restrictedPath}/acl/admin`, { role: "admin" }, "guest");
          await call("DELETE", `${restrictedPath}/acl/guest`, undefined, "guest", 204);
          await call("GET", restrictedPath, undefined, "guest", 404);
          await call("GET", restrictedPath, undefined, "admin");
          await call(
            "PUT",
            `/knowledge/workspaces/${space.id}/permissions/document/admin`,
            { actions: ["read"] },
            "owner",
            409,
          );
          assert.equal(
            (await call("GET", restrictedPath, undefined, "admin")).json<{ canManage: boolean }>()
              .canManage,
            true,
          );
        },
      );
      await t.test(
        "share delegation is bounded, upgrades viewers, and stops when the grantor loses authority",
        async () => {
          const expiresAt = new Date(Date.now() + 3600000).toISOString();
          await call("PUT", `${path}/acl/guest`, { actions: ["share"] });
          await call("POST", `${path}/shares`, { permission: "read", expiresAt }, "guest", 404);
          await call("POST", `${path}/shares`, { permission: "edit", expiresAt }, "guest", 404);
          await call("PUT", `${path}/acl/guest`, { actions: ["read", "share"] });
          await call("POST", `${path}/shares`, { permission: "edit", expiresAt }, "guest", 404);
          const readLink = (
            await call("POST", `${path}/shares`, { permission: "read", expiresAt }, "guest", 201)
          ).json<{ id: string }>();
          assert.equal(
            (await call("POST", `/shares/${readLink.id}/join`, undefined, "guest")).json<{
              joined: boolean;
            }>().joined,
            false,
          );
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, doc.id, "write"),
            false,
          );
          await call("PUT", `${path}/acl/guest`, { actions: ["read", "share", "write"] });
          const editLink = (
            await call("POST", `${path}/shares`, { permission: "edit", expiresAt }, "guest", 201)
          ).json<{ id: string }>();
          const publicPath = `/public/shares/${editLink.id}`;
          assert.equal(
            (await call("GET", publicPath, undefined, "")).json<{ state: string }>().state,
            "active",
          );
          await call("GET", `${publicPath}/content`, undefined, "");
          await call("POST", `/shares/${editLink.id}/join`, undefined, "other", 404);
          assert.equal(
            (await call("POST", `/shares/${editLink.id}/join`, undefined, "viewer")).json<{
              joined: boolean;
            }>().joined,
            true,
          );
          assert.equal(
            await hasDocumentPermission(db, principals.get("viewer")!, doc.id, "write"),
            true,
          );
          assert.equal(
            await hasDocumentPermission(db, principals.get("viewer")!, doc.id, "ai"),
            false,
          );
          assert.equal(
            (await call("POST", `/shares/${editLink.id}/join`, undefined, "viewer")).json<{
              joined: boolean;
            }>().joined,
            false,
          );
          const [share] = await db
            .select()
            .from(schema.documentShares)
            .where(eq(schema.documentShares.id, editLink.id));
          assert.equal(share?.joinCount, 1);
          await call("PUT", `${path}/acl/guest`, { actions: ["read", "share"] });
          assert.equal(
            (await call("GET", publicPath, undefined, "")).json<{ state: string }>().state,
            "unknown",
          );
          await call("GET", `${publicPath}/content`, undefined, "", 404);
          await call("POST", `/shares/${editLink.id}/join`, undefined, "editor", 404);
          // The retained invitation policy keeps already accepted membership independent.
          assert.equal(
            await hasDocumentPermission(db, principals.get("viewer")!, doc.id, "write"),
            true,
          );
          await call("DELETE", `${path}/shares/${editLink.id}`, undefined, "owner", 204);
          await call("DELETE", `${path}/shares/${editLink.id}`, undefined, "owner", 204);
          await call("DELETE", `${path}/acl/viewer`, undefined, "owner", 204);
          await call("DELETE", `${path}/acl/guest`, undefined, "owner", 204);
          const revokedLink = (
            await call("POST", `${path}/shares`, { permission: "read", expiresAt }, "owner", 201)
          ).json<{ id: string }>();
          await call("DELETE", `${path}/shares/${revokedLink.id}`, undefined, "owner", 204);
          assert.equal(
            (await call("GET", `/public/shares/${revokedLink.id}`, undefined, "")).json<{
              state: string;
            }>().state,
            "revoked",
          );
          await call("POST", `/shares/${revokedLink.id}/join`, undefined, "guest", 404);
          const expiredLink = (
            await call("POST", `${path}/shares`, { permission: "read", expiresAt }, "owner", 201)
          ).json<{ id: string }>();
          await db
            .update(schema.documentShares)
            .set({
              createdAt: new Date(Date.now() - 120000),
              expiresAt: new Date(Date.now() - 60000),
            })
            .where(eq(schema.documentShares.id, expiredLink.id));
          assert.equal(
            (await call("GET", `/public/shares/${expiredLink.id}`, undefined, "")).json<{
              state: string;
            }>().state,
            "expired",
          );
          await call("POST", `/shares/${expiredLink.id}/join`, undefined, "guest", 404);
        },
      );
      await t.test(
        "share creation and joining commit audit, grant and counter atomically",
        async () => {
          const expiresAt = new Date(Date.now() + 3600000).toISOString();
          const link = (
            await call("POST", `${path}/shares`, { permission: "edit", expiresAt }, "owner", 201)
          ).json<{ id: string }>();
          const before = (await db.select().from(schema.documentShares)).length;
          await pg.exec(`create function reject_share_audit() returns trigger language plpgsql as $$ begin
          if new.action = 'document.share-created' or new.details->>'operation' = 'share-join' then raise exception 'injected audit failure'; end if;
          return new; end $$;
          create trigger reject_share_audit before insert on document_audit_events for each row execute function reject_share_audit();`);
          await call("POST", `${path}/shares`, { permission: "read", expiresAt }, "owner", 500);
          assert.equal((await db.select().from(schema.documentShares)).length, before);
          await call("POST", `/shares/${link.id}/join`, undefined, "guest", 500);
          assert.equal(
            await hasDocumentPermission(db, principals.get("guest")!, doc.id, "read"),
            false,
          );
          assert.equal(
            (
              await db
                .select()
                .from(schema.documentShares)
                .where(eq(schema.documentShares.id, link.id))
            )[0]?.joinCount,
            0,
          );
          await pg.exec(
            "drop trigger reject_share_audit on document_audit_events; drop function reject_share_audit();",
          );
        },
      );
      const copied = (
        await call("POST", `${path}/copy`, { title: "权限响应副本" }, "owner", 201)
      ).json<{ canWrite: boolean; canManage: boolean }>();
      assert.equal(copied.canWrite, true);
      assert.equal(copied.canManage, true);
      await db
        .insert(schema.resourceAcl)
        .values({
          tenantId: "test",
          workspaceId: "ws_default",
          identityId: "owner",
          role: "admin",
          createdBy: "owner",
        })
        .onConflictDoNothing();
      const imported = (
        await call("POST", "/documents/import", {
          format: "zhishu.document",
          formatVersion: 1,
          title: "权限响应导入",
          schemaVersion: CURRENT_DOCUMENT_SCHEMA_VERSION,
          extensions: [],
          content: { type: "doc", content: [] },
        })
      ).json<{ status: string; document: { canWrite: boolean; canManage: boolean } }>();
      assert.equal(imported.status, "completed");
      assert.equal(imported.document.canWrite, true);
      assert.equal(imported.document.canManage, true);
      const assetRepository = new AssetRepository(db);
      const uploadInput = {
        documentId: doc.id,
        objectKey: "test/permission.png",
        file: { fileName: "permission.png", mediaType: "image/png" as const, size: 1 },
        maxBytes: 1024,
        maxTenantBytes: 10240,
        expiresAt: new Date(Date.now() + 60000),
      };
      assert.equal(
        await assetRepository.createUpload({
          ...uploadInput,
          principal: principals.get("viewer")!,
        }),
        null,
      );
      const upload = await assetRepository.createUpload({
        ...uploadInput,
        principal: principals.get("editor")!,
      });
      assert.ok(upload);

      await call("GET", path, undefined, "guest", 404);
      await call("GET", `${path}/content`, undefined, "other", 404);
      await call("GET", path, undefined, "", 401);
      await call(
        "PATCH",
        path,
        { title: "不允许", metadataRevision: doc.metadataRevision },
        "viewer",
        404,
      );
      await call("DELETE", path, undefined, "editor", 404);
      const session = (
        await call("POST", `${path}/collaboration-session`, {}, "viewer", 201)
      ).json<{ readOnly: boolean }>();
      assert.equal(session.readOnly, true);
      const childrenPath = `/knowledge/workspaces/${space.id}/catalogs/${space.rootCatalogId}/children`;
      await call("GET", childrenPath, undefined, "guest", 404);
      const editorView = (await call("GET", path, undefined, "editor")).json<{
        canWrite: boolean;
        canManage: boolean;
      }>();
      assert.equal(editorView.canWrite, true);
      assert.equal(editorView.canManage, false);
      const adminTree = (await call("GET", childrenPath, undefined, "admin")).json<{
        documents: { canManage: boolean; canMove: boolean }[];
      }>();
      assert.equal(adminTree.documents[0]?.canManage, true);
      assert.equal(adminTree.documents[0]?.canMove, true);
      for (const principal of principals.values())
        for (const action of permissionActions) {
          const [row] = await db
            .select({ allowed: documentActionSql(principal, action) })
            .from(schema.documents)
            .where(eq(schema.documents.id, doc.id));
          assert.equal(
            row?.allowed,
            await hasDocumentPermission(db, principal, doc.id, action),
            `${principal.identityId}/${action}`,
          );
        }
      await call("PUT", `${path}/acl/guest`, { role: "editor" });
      const sharedSpaces = (await call("GET", "/knowledge/workspaces", undefined, "guest")).json<
        { id: string; canManage: boolean }[]
      >();
      assert.equal(
        sharedSpaces.some((s) => s.id === space.id),
        false,
      );
      assert.equal(
        (await call("GET", path, undefined, "guest")).json<{ canWrite: boolean }>().canWrite,
        true,
      );
      const listAcl = (await call("GET", `${path}/acl`)).json<
        { identityId: string; role?: string; actions: string[] }[]
      >();
      assert.equal(listAcl.find((r) => r.identityId === "guest")?.role, "editor");
      await call(
        "PUT",
        `/knowledge/workspaces/${space.id}/permissions/document/editor`,
        { actions: ["read"] },
        "admin",
        404,
      );
      await call(
        "PUT",
        `/knowledge/workspaces/${space.id}/permissions/document/editor`,
        { actions: ["read"] },
        "owner",
        204,
      );
      assert.ok(revoked.includes(doc.id));
      assert.equal(await assetRepository.beginUpload(principals.get("editor")!, upload.id), null);
      assert.equal(
        (await call("GET", path, undefined, "editor")).json<{ canWrite: boolean }>().canWrite,
        false,
      );
      assert.equal(
        (await call("GET", path, undefined, "guest")).json<{ canWrite: boolean }>().canWrite,
        false,
      );
      await call("PUT", `${path}/acl/guest`, { actions: ["write"] });
      assert.equal(
        (await call("GET", path, undefined, "guest")).json<{ canWrite: boolean }>().canWrite,
        true,
      );
      await call("PUT", `${path}/acl/guest`, { actions: ["move"] });
      assert.equal(
        (await call("GET", path, undefined, "guest")).json<{
          canMove: boolean;
          canWrite: boolean;
        }>().canMove,
        true,
      );
      assert.equal(
        await hasDocumentPermission(db, principals.get("guest")!, doc.id, "write"),
        false,
      );
      await call("PUT", `${path}/acl/guest`, { role: "admin" });
      await call(
        "PATCH",
        `${path}/access`,
        {
          accessMode: "restricted",
          metadataRevision: (await call("GET", path)).json<{ metadataRevision: number }>()
            .metadataRevision,
        },
        "owner",
        200,
      );
      // Validate scoped roles and inheritance directly, independent of transport.
      await db
        .update(schema.documents)
        .set({ accessMode: "restricted" })
        .where(eq(schema.documents.id, doc.id));
      assert.equal(
        await hasDocumentPermission(db, principals.get("admin")!, doc.id, "read"),
        false,
      );
      assert.equal(
        await hasDocumentPermission(db, principals.get("guest")!, doc.id, "manage"),
        true,
      );
      await db.delete(schema.resourceAcl).where(eq(schema.resourceAcl.documentId, doc.id));
      assert.equal(
        await hasDocumentPermission(db, principals.get("guest")!, doc.id, "read"),
        false,
      );
      // Directory bindings use the same policy and resource table, and restricted stops ancestors.
      await db.insert(schema.resourceAcl).values({
        tenantId: "test",
        catalogId: space.rootCatalogId,
        identityId: "guest",
        role: "viewer",
        createdBy: "owner",
      });
      await db
        .update(schema.documents)
        .set({ accessMode: "workspace-inherited" })
        .where(eq(schema.documents.id, doc.id));
      assert.equal(await hasDocumentPermission(db, principals.get("guest")!, doc.id, "read"), true);
      await db
        .update(schema.catalogs)
        .set({ accessMode: "restricted" })
        .where(eq(schema.catalogs.id, space.rootCatalogId));
      assert.equal(
        await hasDocumentPermission(db, principals.get("admin")!, doc.id, "read"),
        false,
      );
      assert.equal(await hasDocumentPermission(db, principals.get("guest")!, doc.id, "read"), true);
      await db.delete(schema.documents).where(eq(schema.documents.id, doc.id));
      assert.equal(
        await hasDocumentPermission(db, principals.get("guest")!, doc.id, "read"),
        false,
      );
      for (const kind of resourceTypes) assert.ok(actionsForResource[kind].includes("read"));
    } finally {
      await app.close();
      await pg.close();
    }
  },
);
