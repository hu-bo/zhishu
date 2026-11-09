import "../environment.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashContent } from "@zhishu/ai-runtime/policy";
import { createDatabase, createPool } from "../../database/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { serverRoot, workspaceRoot } from "../paths.js";
import { createCollaborationServer } from "../modules/collaboration/hocuspocus.server.js";
import { createRagClients } from "../modules/rag/rag.config.js";
import type { AiTaskView } from "../modules/ai/ai.schema.js";
import { startKnowledgeProviderFixture } from "./knowledge-provider-fixture.js";
import { mockUser } from "../modules/identity/mock-user.js";
import { request as httpRequest } from "node:http";

const args = process.argv.slice(2).filter((a) => a !== "--");
if (args.includes("--help")) {
  console.log(
    "AI_TEST_ADMIN_DATABASE_URL=<disposable PostgreSQL> QDRANT_TEST_URL=<isolated Qdrant> pnpm smoke:ai-knowledge [--fixtures | --writing-only] [--serve]",
  );
  process.exit(0);
}
assert(
  args.every((a) => ["--fixtures", "--writing-only", "--serve"].includes(a)),
  "Unknown argument",
);
assert(
  process.env.AI_TEST_ADMIN_DATABASE_URL,
  "Set AI_TEST_ADMIN_DATABASE_URL explicitly; DATABASE_URL is never used",
);
const fixture = args.includes("--fixtures") ? await startKnowledgeProviderFixture() : undefined;
const writingOnly = args.includes("--writing-only");
if (!writingOnly)
  assert(process.env.QDRANT_TEST_URL, "Set QDRANT_TEST_URL to an isolated Qdrant instance");
const admin = createPool({ connectionString: process.env.AI_TEST_ADMIN_DATABASE_URL, max: 2 });
const databaseName = `zhishu_ai_test_${randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(process.env.AI_TEST_ADMIN_DATABASE_URL);
testUrl.pathname = `/${databaseName}`;
await admin.query(`create database "${databaseName}"`);
const pool = createPool({ connectionString: testUrl.href, max: 10 });
const config = loadConfig({
  ...process.env,
  DATABASE_URL: testUrl.href,
  NODE_ENV: "test",
  AUTH_MODE: "mock",
  LOG_LEVEL: "silent",
  PORT: writingOnly ? "3314" : "3312",
  COLLABORATION_PORT: writingOnly ? "3315" : "3313",
  COLLABORATION_PUBLIC_URL: writingOnly ? "ws://127.0.0.1:3315" : "ws://127.0.0.1:3313",
  COLLABORATION_ALLOWED_ORIGINS: "http://127.0.0.1:5187,http://127.0.0.1:5173",
  QDRANT_URL: writingOnly ? undefined : process.env.QDRANT_TEST_URL,
  QDRANT_COLLECTION: `zhishu_live_test_${randomUUID().replaceAll("-", "")}`,
  RAG_POLL_INTERVAL_MS: "100",
  AI_IMAGE_MODEL: undefined,
  AI_IMAGE_API_KEY: undefined,
  ASSET_STORAGE_ACCESS_KEY_ID: undefined,
  ASSET_STORAGE_SECRET_ACCESS_KEY: undefined,
  ...(fixture
    ? {
        AI_MODEL: "fixture-writing",
        AI_API_KEY: "fixture-key",
        AI_BASE_URL: fixture.baseURL,
        AI_API_FORMAT: "openai",
        AI_THINKING: "disabled",
        AI_EMBEDDING_MODEL: "fixture-embedding",
        AI_EMBEDDING_BASE_URL: fixture.baseURL,
        AI_EMBEDDING_API_KEY: "fixture-key",
        AI_EMBEDDING_DIMENSIONS: "32",
      }
    : {}),
});
const clients = writingOnly ? null : createRagClients(config);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let collaboration: ReturnType<typeof createCollaborationServer> | undefined;
const report: {
  mode: string;
  writingModel?: string;
  embeddingModel?: string;
  dimensions: number;
  checks: { name: string; detail: unknown }[];
  outcome?: string;
  error?: string;
} = {
  mode: fixture
    ? "deterministic-provider-real-postgres-qdrant"
    : writingOnly
      ? "real-writing-only"
      : "real-models-postgres-qdrant",
  writingModel: config.AI_MODEL,
  embeddingModel: config.AI_EMBEDDING_MODEL,
  dimensions: config.AI_EMBEDDING_DIMENSIONS,
  checks: [],
};
const record = (name: string, detail: unknown) => {
  report.checks.push({ name, detail });
  console.log(`PASS ${name}`);
};
try {
  await migrate(createDatabase(pool), {
    migrationsFolder: resolve(serverRoot, "database/migrations"),
  });
  await pool.query("create schema ai_checkpoint");
  const saver = new PostgresSaver(pool, undefined, { schema: "ai_checkpoint" });
  await saver.setup();
  if (!writingOnly) {
    assert(clients, "Embedding endpoint, credentials and model are required");
    const setupEnvironment = Object.fromEntries(
      Object.entries(config)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : String(value)]),
    );
    await promisify(execFile)(process.execPath, ["--import", "tsx", "src/scripts/ai-setup.ts"], {
      cwd: serverRoot,
      env: { ...process.env, ...setupEnvironment },
      timeout: 30000,
    });
    record("显式 AI checkpoint 与向量集合初始化命令", { dimensions: clients.index.dimensions });
  }
  app = await buildApp(config, {
    collaborationOwner: {
      snapshot: (principal, id) => collaboration!.owner.snapshot(principal, id),
      apply: (input) => collaboration!.owner.apply(input),
    },
    sessionRevoker: {
      revokeDocumentSessions: (id, generation) =>
        collaboration?.revokeDocumentSessions(id, generation),
    },
  });
  collaboration = createCollaborationServer(config, app.db, app.dbPool);
  await collaboration.listen();
  await app.ready();
  const deniedUpgrade = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:${config.COLLABORATION_PORT}`,
      {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          Origin: "https://untrusted.example",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(deniedUpgrade, 403);
  record("拒绝未授权协同来源且服务保持可用", { status: deniedUpgrade });
  const token = (
    await app.inject({ method: "POST", url: "/api/auth/mock/login", payload: {} })
  ).json<{ accessToken: string }>().accessToken;
  const otherToken = (
    await app.inject({
      method: "POST",
      url: "/api/auth/mock/login",
      payload: { userId: "mock-viewer-001" },
    })
  ).json<{ accessToken: string }>().accessToken;
  const call = async (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    expected = 200,
    accessToken = token,
  ) => {
    const r = await app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${accessToken}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    assert.equal(r.statusCode, expected, `${method} ${url}: ${r.body.slice(0, 1000)}`);
    return r;
  };
  const workspace = (
    await call(
      "POST",
      "/api/knowledge/workspaces",
      { name: "AI 全流程独立验收", kind: "personal" },
      201,
    )
  ).json<{ id: string }>();
  const doc = (
    await call(
      "POST",
      "/api/documents",
      { title: "星舟计划上线规范", workspaceId: workspace.id },
      201,
    )
  ).json<{ id: string }>();
  const context = async () =>
    (await call("GET", `/api/ai/documents/${doc.id}/context`)).json<{
      version: {
        documentId: string;
        generationId: string;
        durableSeq: number;
        contentHash: string;
      };
      snapshot: { content: { content: { attrs: { blockId: string } }[] } };
      structureRevision: number;
    }>();
  const before = await context();
  const requestId = randomUUID();
  const instruction =
    "撰写一篇约600字的中文产品规范，标题为星舟计划上线规范，至少12个正文块。必须准确保留下列虚构验收事实，不要自行更改：星舟计划代号为ZK-7429；灰度比例为17%；灰度观察期为43小时；回滚负责人是林澈；验收口令是松塔蓝鲸。把回滚负责人和验收口令放在文章后半段。包括目标、灰度规则、异常回滚、验收四节，不生成图片。";
  const writing = await call("POST", "/api/ai/authoring", {
    protocolVersion: 1,
    sourceDocumentIds: [],
    previousRequestIds: [],
    request: {
      kind: "authoring",
      requestId,
      intent: "create",
      instruction,
      document: before.version,
      baseStructureRevision: before.structureRevision,
      target: {
        kind: "document-end",
        afterBlockId: before.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
      },
    },
  });
  const events = writing.body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; payload: unknown });
  assert.equal(events.at(-1)?.type, "completed", JSON.stringify(events.at(-1)));
  const task = (await call("GET", `/api/ai/requests/${requestId}`)).json<AiTaskView>();
  assert.equal(task.status, "completed");
  assert.equal(
    (await context()).version.durableSeq,
    before.version.durableSeq,
    "Proposal must not mutate the document before acceptance",
  );
  const accepted = (await call("POST", `/api/ai/requests/${requestId}/accept`)).json<AiTaskView>();
  assert.equal(accepted.application.state, "applied", JSON.stringify(accepted.application));
  const written = await context();
  const body = JSON.stringify(written.snapshot.content);
  for (const fact of ["ZK-7429", "17%", "43", "林澈", "松塔蓝鲸"])
    assert(body.includes(fact), `Written document missing ${fact}`);
  assert(written.version.durableSeq > before.version.durableSeq);
  await call("POST", `/api/ai/requests/${requestId}/accept`);
  assert.equal(
    (await context()).version.durableSeq,
    written.version.durableSeq,
    "Repeated acceptance must be idempotent",
  );
  record("真实写作、人工采纳、协同 durable ack 与幂等写入", {
    documentId: doc.id,
    blocks: written.snapshot.content.content.length,
    durableSeq: written.version.durableSeq,
    contentHash: hashContent(written.snapshot.content),
    usage: task.usage,
  });
  if (writingOnly) {
    const directId = randomUUID();
    const direct = await call("POST", "/api/ai/chat", {
      protocolVersion: 2,
      sourceDocumentIds: [doc.id],
      request: {
        kind: "chat",
        requestId: directId,
        message: "星舟计划的灰度比例和观察期分别是多少？请引用原文。",
        responseMode: "grounded",
        contextRef: "selected-documents",
        previousRequestIds: [],
      },
    });
    assert(direct.body.includes('"type":"completed"'), direct.body.slice(-1200));
    const answer = (await call("GET", `/api/ai/requests/${directId}`)).json<AiTaskView>().result;
    assert(answer && "text" in answer);
    assert(answer.text.includes("17%"));
    assert(answer.text.includes("43"));
    assert(answer.citations.length > 0);
    record("真实模型按正文问答（直接上下文，未走向量检索）", answer);
    report.outcome = "writing-and-direct-QA-passed; vector-retrieval-not-tested";
  } else {
    const waitIndex = async (recovering = false) => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        const status = (await call("GET", `/api/ai/indexes?workspaceId=${workspace.id}`)).json<{
          total: number;
          ready: number;
          failed: number;
          errors: string[];
        }>();
        if (status.total > 0 && status.ready === status.total) return status;
        if (status.failed && !recovering)
          throw new Error(`INDEX_FAILED: ${status.errors.join(",")}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("INDEX_WAIT_TIMEOUT");
    };
    await waitIndex();
    const otherWorkspace = (
      await call(
        "POST",
        "/api/knowledge/workspaces",
        { name: "范围隔离对照空间", kind: "personal" },
        201,
      )
    ).json<{ id: string }>();
    const decoy = (
      await call(
        "POST",
        "/api/documents",
        { title: "同名计划的隔离资料", workspaceId: otherWorkspace.id },
        201,
      )
    ).json<{ id: string }>();
    const decoyContext = await collaboration.owner.snapshot(mockUser, decoy.id);
    await collaboration.owner.apply({
      principal: mockUser,
      expectedDurableSeq: decoyContext.snapshot.durableSeq,
      baseStructureRevision: decoyContext.structureRevision,
      batch: {
        operationId: `op_${randomUUID()}`,
        documentId: decoy.id,
        generationId: decoyContext.snapshot.generationId,
        origin: "user",
        operations: [
          {
            type: "insert-block",
            parentBlockId: null,
            block: {
              type: "paragraph",
              attrs: { blockId: `block_${randomUUID()}` },
              content: [
                {
                  type: "text",
                  text: "这是另一个空间的星舟计划，验收口令是紫电玉兔，灰度观察期为99小时，仅供范围隔离测试。",
                },
              ],
            },
          },
        ],
      },
      guard: async () => undefined,
      record: async () => undefined,
    });
    const decoyDeadline = Date.now() + 120000;
    while (Date.now() < decoyDeadline) {
      const status = (await call("GET", `/api/ai/indexes?documentIds=${decoy.id}`)).json<{
        ready: number;
      }>();
      if (status.ready === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(
      (await call("GET", `/api/ai/indexes?documentIds=${decoy.id}`)).json<{ ready: number }>()
        .ready,
      1,
    );
    const count = await clients!.client.count(clients!.index.collectionName, { exact: true });
    assert(count.count > 0);
    record("自动向量化与真实 Qdrant 持久化", {
      points: count.count,
      dimensions: config.AI_EMBEDDING_DIMENSIONS,
    });
    const ask = async (
      message: string,
      sourceDocumentIds: string[],
      sourceWorkspaceId?: string,
      accessToken = token,
      previousRequestIds: string[] = [],
    ) => {
      const id = randomUUID(),
        started = Date.now();
      const response = await call(
        "POST",
        "/api/ai/chat",
        {
          protocolVersion: 2,
          sourceDocumentIds,
          ...(sourceWorkspaceId ? { sourceWorkspaceId } : {}),
          request: {
            kind: "chat",
            requestId: id,
            message,
            responseMode: "grounded",
            contextRef: "knowledge",
            previousRequestIds,
          },
        },
        200,
        accessToken,
      );
      assert(response.body.includes('"type":"completed"'), response.body.slice(-1200));
      const task = (
        await call("GET", `/api/ai/requests/${id}`, undefined, 200, accessToken)
      ).json<AiTaskView>();
      assert(task.result && "text" in task.result);
      return { id, answer: task.result, durationMs: Date.now() - started };
    };
    const docAnswer = await ask("星舟计划的代号、灰度比例和观察期分别是多少？", [doc.id]);
    for (const fact of ["ZK-7429", "17%", "43"])
      assert(docAnswer.answer.text.includes(fact), `Document answer missing ${fact}`);
    assert(docAnswer.answer.citations.length > 0);
    for (const c of docAnswer.answer.citations) {
      assert.equal(c.source.sourceId, doc.id);
      assert(body.includes(c.quote), "Citation must be verbatim persisted content");
    }
    record("指定文档问答与原文引用", docAnswer);
    const spaceAnswer = await ask("上线验收口令是什么，谁负责异常回退？", [], workspace.id);
    assert(spaceAnswer.answer.text.includes("松塔蓝鲸"));
    assert(spaceAnswer.answer.text.includes("林澈"));
    assert(spaceAnswer.answer.citations.length > 0);
    assert(
      !spaceAnswer.answer.text.includes("紫电玉兔"),
      "Workspace scope must exclude authorized documents in another space",
    );
    for (const citation of spaceAnswer.answer.citations)
      assert.equal(citation.source.sourceId, doc.id);
    for (const citation of docAnswer.answer.citations)
      assert.equal(citation.source.sourceId, doc.id);
    record("文档与空间范围排除其他可读空间的相似资料", { otherWorkspaceIndexed: true });
    record("空间检索覆盖文章后半段", spaceAnswer);
    const followup = await ask("观察期用多少小时？", [], workspace.id, token, [spaceAnswer.id]);
    assert(followup.answer.text.includes("43"));
    record("带历史的追问", followup);
    const noAnswer = await ask("星舟计划哪一年在火星上市？", [], workspace.id);
    assert.equal(noAnswer.answer.status, "insufficient-evidence");
    record("无依据问题不编造", noAnswer);
    const denied = await ask("验收口令是什么？", [], workspace.id, otherToken);
    assert.equal(denied.answer.status, "insufficient-evidence");
    assert(!denied.answer.text.includes("松塔蓝鲸"));
    await call("GET", `/api/ai/requests/${spaceAnswer.id}`, undefined, 404, otherToken);
    record("空间权限与私有问答隔离", { status: denied.answer.status });
    const vectorCountBeforeGrant = await clients!.client.count(clients!.index.collectionName, {
      exact: true,
    });
    const embeddingCountBeforeGrant = fixture?.controls.documentEmbeddings;
    await call("PUT", `/api/documents/${doc.id}/acl/mock-viewer-001`, { actions: ["read", "ai"] });
    const shared = await ask("验收口令是什么？", [doc.id], undefined, otherToken);
    assert(shared.answer.text.includes("松塔蓝鲸"));
    await call("DELETE", `/api/documents/${doc.id}/acl/mock-viewer-001`, undefined, 204);
    await call("GET", `/api/ai/requests/${shared.id}`, undefined, 403, otherToken);
    assert.equal(
      (await clients!.client.count(clients!.index.collectionName, { exact: true })).count,
      vectorCountBeforeGrant.count,
    );
    if (fixture)
      assert.equal(
        fixture.controls.documentEmbeddings,
        embeddingCountBeforeGrant,
        "ACL updates must not re-embed content",
      );
    record("单篇授权与撤权、成员变更不重建向量", { points: vectorCountBeforeGrant.count });
    assert.equal(
      (await context()).version.durableSeq,
      written.version.durableSeq,
      "Knowledge QA cannot modify the article",
    );
    const oldVersion = (
      await pool.query<{ active_index_version: string }>(
        "select active_index_version from document_indexes where document_id=$1",
        [doc.id],
      )
    ).rows[0]!.active_index_version;
    const latest = await collaboration.owner.snapshot(mockUser, doc.id);
    const passwordBlock = latest.snapshot.content.content.find((b) =>
      JSON.stringify(b).includes("松塔蓝鲸"),
    );
    assert(passwordBlock && passwordBlock.type === "paragraph");
    if (fixture) fixture.controls.embeddingFailure = true;
    await collaboration.owner.apply({
      principal: mockUser,
      expectedDurableSeq: latest.snapshot.durableSeq,
      baseStructureRevision: latest.structureRevision,
      batch: {
        operationId: `op_${randomUUID()}`,
        documentId: doc.id,
        generationId: latest.snapshot.generationId,
        origin: "user",
        operations: [
          {
            type: "replace-block",
            targetBlockId: passwordBlock.attrs.blockId,
            block: {
              type: "paragraph",
              attrs: passwordBlock.attrs,
              content: [{ type: "text", text: "验收口令已更新为银杏海豚，旧口令作废。" }],
            },
          },
        ],
      },
      guard: async () => undefined,
      record: async () => undefined,
    });
    if (fixture) {
      const deadline = Date.now() + 10000;
      let failed = false;
      while (Date.now() < deadline) {
        const status = (await call("GET", `/api/ai/indexes?documentIds=${doc.id}`)).json<{
          failed: number;
          errors: string[];
        }>();
        if (status.failed) {
          assert(status.errors.includes("EMBEDDING_AUTH_FAILED"));
          failed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(failed, "Embedding errors must be visible");
      await call(
        "POST",
        "/api/ai/chat",
        {
          protocolVersion: 2,
          sourceDocumentIds: [doc.id],
          request: {
            kind: "chat",
            requestId: randomUUID(),
            message: "验收口令是什么？",
            responseMode: "grounded",
            contextRef: "knowledge",
            previousRequestIds: [],
          },
        },
        503,
      );
      fixture.controls.embeddingFailure = false;
      record("Embedding 失败可见且拒绝使用旧索引", { status: "EMBEDDING_AUTH_FAILED" });
    }
    await waitIndex(true);
    const updated = await ask("最新验收口令是什么？", [doc.id]);
    assert(updated.answer.text.includes("银杏海豚"));
    assert(!updated.answer.text.includes("松塔蓝鲸"));
    const activeVersion = (
      await pool.query<{ active_index_version: string }>(
        "select active_index_version from document_indexes where document_id=$1",
        [doc.id],
      )
    ).rows[0]!.active_index_version;
    assert.notEqual(activeVersion, oldVersion);
    record("正文更新自动重建与失败自动恢复", updated);
    await call("DELETE", `/api/documents/${doc.id}`, undefined, 204);
    const removed = await ask("验收口令是什么？", [], workspace.id);
    assert.equal(removed.answer.status, "insufficient-evidence");
    record("删除后立即排除旧向量", { status: removed.answer.status });
    if (args.includes("--serve")) {
      await call("PUT", `/api/documents/${doc.id}/restore`, undefined, 204);
      await waitIndex(true);
      await app.listen({ port: 3312, host: "127.0.0.1" });
      await writeFile(
        resolve(workspaceRoot, "output/qa/ai-knowledge-browser.json"),
        JSON.stringify({ workspaceId: workspace.id, documentId: doc.id }),
      );
      console.log("BROWSER_READY http://127.0.0.1:3312 (Ctrl+C cleans up the disposable data)");
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
    report.outcome = "passed";
  }
} catch (error) {
  report.outcome = "failed";
  report.error = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await collaboration?.close();
  await app?.close();
  if (clients)
    await clients.client.deleteCollection(clients.index.collectionName).catch(() => undefined);
  await fixture?.close();
  await pool.end();
  await admin.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()",
    [databaseName],
  );
  await admin.query(`drop database "${databaseName}"`);
  await admin.end();
  const folder = resolve(workspaceRoot, "output/qa");
  await mkdir(folder, { recursive: true });
  const reportPath = resolve(
    folder,
    fixture
      ? "ai-knowledge-fixtures.json"
      : writingOnly
        ? "ai-writing-live.json"
        : "ai-knowledge-live.json",
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);
}
