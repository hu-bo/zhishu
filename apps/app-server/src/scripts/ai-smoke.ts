import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { LlmAdapter, ToolCallId, type GenerateOptions } from "@zhishu/ai-writing/kernel";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { RagService } from "../modules/rag/rag.service.js";
import type { EvidenceBundle } from "@zhishu/ai-contracts";
import * as schema from "../../database/schema/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCollaborationServer } from "../modules/collaboration/hocuspocus.server.js";
import { OperationsMetrics } from "../modules/health/operations-metrics.js";

/**
 * Scripted end-to-end smoke for the new AI platform (no external model traffic):
 * QA answer flow with citations and idempotency, QA→writing handoff with server-side
 * re-validation, proposal compile + durable apply through the collaboration channel,
 * cancellation, context revision isolation and cross-purpose access rejection.
 * Requires DATABASE_URL pointing at a disposable zhishu_ai_test_* database.
 */

const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/zhishu_ai_test_[a-z0-9_]+/.test(databaseUrl))
  throw new Error("ai-smoke requires DATABASE_URL of a disposable zhishu_ai_test_* database");

const evidence: EvidenceBundle = {
  freshness: "current",
  sources: [
    {
      sourceKind: "document",
      sourceId: "doc_smoke_source",
      snapshotId: "snap_smoke",
      title: "知书产品说明",
      workspaceId: "ws_smoke",
      documentId: "doc_smoke_source",
      generationId: "gen_smoke",
      durableSeq: "1",
      metadataRevision: "1",
      indexVersion: "iv_smoke",
      workspaceLabel: " smoke 空间",
    },
  ],
  items: [
    {
      evidenceId: "ev_smoke",
      sourceId: "doc_smoke_source",
      snapshotId: "snap_smoke",
      locator: { kind: "block", blockId: "block_smoke", start: 0, end: 16 },
      text: "知书是一款在线文档编辑与协作产品",
    },
  ],
};

const stubRag = {
  async retrieve() {
    return { evidence, coverage: { totalDocuments: 1, readyDocuments: 1 } };
  },
  async verifyStoredEvidence(_scope: unknown, items: readonly { evidenceId: string }[]) {
    return items.every((item) => item.evidenceId === "ev_smoke");
  },
  async coverage() {
    return { totalDocuments: 1, readyDocuments: 1 };
  },
  start() {},
  async close() {},
} as unknown as RagService;

const scriptedChatModel = {
  bindTools() {
    return {
      async invoke() {
        return {
          tool_calls: [
            {
              name: "chat_result",
              args: {
                status: "answered",
                text: "知书支持在线文档编辑与团队协作。",
                citations: [{ evidenceId: "ev_smoke", quote: "在线文档编辑" }],
              },
            },
          ],
          usage_metadata: { input_tokens: 20, output_tokens: 8 },
        };
      },
    };
  },
  async invoke() {
    return { tool_calls: [], content: "" };
  },
} as unknown as BaseChatModel;

class ScriptedDshModel extends LlmAdapter {
  calls = 0;
  async *stream(options: GenerateOptions) {
    this.calls++;
    const hasToolResult = options.messages.some((message) => message.role === "tool");
    const lastUser = options.messages.filter((m) => m.role === "user").at(-1);
    const content = lastUser?.content;
    const text = (Array.isArray(content) ? content : [])
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    if (text.includes("hold") && !hasToolResult) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 15_000);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("ABORT"));
          },
          { once: true },
        );
      });
    }
    if (!hasToolResult) {
      const block = {
        type: "tool-call" as const,
        id: ToolCallId("call-smoke-1"),
        name: "draft_document",
        arguments: JSON.stringify({
          blocks: [
            {
              type: "paragraph",
              text: "这是冒烟测试生成的新提案段落：知书提供在线文档编辑与团队协作能力。",
            },
          ],
          summary: "冒烟提案",
          citations: [{ evidenceId: "ev_smoke", quote: "在线文档编辑" }],
        }),
      };
      yield { type: "block-end" as const, index: 0, block };
      yield { type: "finish" as const, reason: { kind: "tool-calls" as const } };
      return;
    }
    const textBlock = { type: "text" as const, text: "提案已生成。" };
    yield { type: "block-start" as const, index: 0, blockType: "text" as const };
    yield { type: "text-delta" as const, index: 0, text: "提案已生成。" };
    yield { type: "block-end" as const, index: 0, block: textBlock };
    yield { type: "finish" as const, reason: { kind: "stop" as const } };
  }
}

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  AUTH_MODE: "mock",
  LOG_LEVEL: process.env.AI_SMOKE_VERBOSE === "1" ? "error" : "silent",
  DATABASE_URL: databaseUrl,
  PORT: "3390",
  COLLABORATION_PORT: "3391",
  AI_MODEL: "scripted",
  AI_API_KEY: "scripted-key",
  AI_EMBEDDING_MODEL: undefined,
  QDRANT_URL: undefined,
  TAVILY_API_KEY: undefined,
  APP_PUBLIC_URL: "http://localhost:5173",
});

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const migratorDb = drizzle(pool, { schema });
await migrate(migratorDb, {
  migrationsFolder: "database/migrations",
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
});

const metrics = new OperationsMetrics();
const collaborationRef: { current?: ReturnType<typeof createCollaborationServer> } = {};
const app = await buildApp(config, {
  operationsMetrics: metrics,
  sessionRevoker: { revokeDocumentSessions() {} },
  collaborationOwner: {
    snapshot: (principal, id) => collaborationRef.current!.owner.snapshot(principal, id),
    apply: (input) => collaborationRef.current!.owner.apply(input),
  },
  aiModel: scriptedChatModel,
  writingAdapter: new ScriptedDshModel(),
  ragStub: stubRag,
});
const collaboration = createCollaborationServer(
  config,
  app.db,
  app.dbPool,
  () => process.exit(1),
  metrics,
);
collaborationRef.current = collaboration;
await collaboration.listen();
await app.ready();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let authorization: Record<string, string> = {};

async function json(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
  extra: Record<string, string> = {},
) {
  const response = await app.inject({
    method,
    url,
    headers: { ...authorization, ...extra },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: response.statusCode,
    body: (() => {
      try {
        return response.json();
      } catch {
        return response.body;
      }
    })(),
  };
}

async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | undefined | null>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${what}`);
}

let failures = 0;
try {
  authorization = {
    authorization: "Bearer " + (await json("POST", "/api/auth/mock/login")).body.accessToken,
  };

  // 1. Capabilities: qa enabled with scripted model; web research unavailable without a key.
  const qaCaps = await json("GET", "/api/ai/qa/capabilities");
  assert.equal(qaCaps.status, 200);
  assert.equal(qaCaps.body.enabled, true);
  assert.equal(qaCaps.body.webSearch, false);
  const writingCaps = await json("GET", "/api/ai/writing/capabilities");
  assert.equal(writingCaps.status, 200);
  assert.equal(writingCaps.body.webSearchAvailable, false);

  // 2. Target document for writing; the stub evidence points at it so the durable-apply
  //    source re-check (a real server-side defense) can pass.
  const createdDoc = await json("POST", "/api/documents/", { title: "冒烟目标文档" });
  assert.equal(createdDoc.status, 201);
  const documentId = createdDoc.body.id as string;
  const smokeSource = evidence.sources[0];
  if (smokeSource.sourceKind === "document") {
    smokeSource.sourceId = documentId;
    smokeSource.documentId = documentId;
    evidence.items[0].sourceId = documentId;
  }

  // 3. QA conversation: submit, citation-valid answer, idempotent replay.
  const qaConv = await json("POST", "/api/ai/qa/conversations", {});
  assert.equal(qaConv.status, 201);
  const qaConversationId = qaConv.body.id as string;
  const submitBody = {
    clientMessageId: "cm-1",
    idempotencyKey: "ik-1",
    text: "知书是做什么的？",
    expectedContextRevision: qaConv.body.contextRevision,
  };
  const accepted = await json(
    "POST",
    `/api/ai/qa/conversations/${qaConversationId}/messages`,
    submitBody,
  );
  assert.equal(accepted.status, 202);
  const runId = accepted.body.runId as string;
  const replay = await json(
    "POST",
    `/api/ai/qa/conversations/${qaConversationId}/messages`,
    submitBody,
  );
  assert.equal(replay.status, 202);
  assert.equal(replay.body.runId, runId);
  const conflict = await json("POST", `/api/ai/qa/conversations/${qaConversationId}/messages`, {
    ...submitBody,
    text: "同一幂等键换问题",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
  const answered = await waitUntil("qa answer", async () => {
    const snap = await json("GET", `/api/ai/qa/conversations/${qaConversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === runId);
    if (!run) return undefined;
    if (run.status === "completed")
      return snap.body.messages.find(
        (m: { runId: string; role: string }) => m.runId === runId && m.role === "assistant",
      );
    if (["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("qa run terminated: " + run.status + " " + (run.errorCode ?? ""));
    return undefined;
  });
  const citationPart = answered.parts.find((p: { kind: string }) => p.kind === "citation");
  assert.ok(citationPart, "answered message must carry a citation part");
  assert.equal(citationPart.citation.quote, "在线文档编辑");
  const artifact = await json(
    "GET",
    `/api/ai/qa/artifacts/${citationPart.citation.evidenceArtifactId}?conversationId=${qaConversationId}`,
  );
  assert.equal(artifact.status, 200);
  assert.equal(artifact.body.sources[0].documentId, documentId);

  // 4. Cross-purpose access must be refused.
  const wrongPurpose = await json("GET", `/api/ai/writing/conversations/${qaConversationId}`);
  assert.ok(
    [404, 409].includes(wrongPurpose.status),
    "qa conversation is not reachable via writing",
  );

  // 5. Scope change bumps the single context revision; stale revisions are rejected.
  const scopeChange = await json("POST", `/api/ai/qa/conversations/${qaConversationId}/scope`, {
    scope: { kind: "documents", documentIds: ["doc_smoke_source"] },
    expectedContextRevision: 1,
  });
  assert.equal(scopeChange.status, 200);
  assert.equal(scopeChange.body.contextRevision, 2);
  const staleSubmit = await json("POST", `/api/ai/qa/conversations/${qaConversationId}/messages`, {
    clientMessageId: "cm-2",
    idempotencyKey: "ik-2",
    text: "旧修订提交",
    expectedContextRevision: 1,
  });
  assert.equal(staleSubmit.status, 409);

  // 6. Web search without a configured key is an explicit 503.
  const needWeb = await json("POST", `/api/ai/writing/conversations`, {
    targetDocumentId: documentId,
  });
  assert.equal(needWeb.status, 201);
  const webRejected = await json(
    "POST",
    `/api/ai/writing/conversations/${needWeb.body.id}/messages`,
    {
      clientMessageId: "cm-web",
      idempotencyKey: "ik-web",
      text: "请联网查一下",
      expectedContextRevision: needWeb.body.contextRevision,
      webSearch: true,
    },
  );
  assert.equal(webRejected.status, 503);

  // 7. QA → writing handoff: new purpose=writing session, idempotent by creationKey.
  const handoff = await json(
    "POST",
    `/api/ai/qa/conversations/${qaConversationId}/messages/${answered.id}/create-writing`,
    { instruction: "基于资料写一段介绍", creationKey: "handoff-1", targetDocumentId: documentId },
  );
  assert.equal(handoff.status, 201);
  const handoffReplay = await json(
    "POST",
    `/api/ai/qa/conversations/${qaConversationId}/messages/${answered.id}/create-writing`,
    { instruction: "基于资料写一段介绍", creationKey: "handoff-1", targetDocumentId: documentId },
  );
  assert.equal(handoffReplay.status, 201);
  assert.equal(handoffReplay.body.replayed, true);
  const handoffConversationId = handoff.body.conversationId as string;

  // 8. The handoff run completes with an evidence copy (server re-validated) + proposal artifact.
  const proposal = await waitUntil("proposal artifact", async () => {
    const snap = await json("GET", `/api/ai/writing/conversations/${handoffConversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === handoff.body.runId);
    if (run && ["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("handoff run failed: " + run.status + " " + (run.errorCode ?? ""));
    const artifactIds = new Set(snap.body.artifacts.map((a: { id: string }) => a.id));
    return snap.body.artifacts.find((a: { kind: string }) => a.kind === "proposal")
      ? { snap, artifactIds }
      : undefined;
  });
  const evidenceArtifact = proposal.snap.body.artifacts.find(
    (a: { kind: string }) => a.kind === "evidence",
  );
  assert.ok(evidenceArtifact, "handoff evidence must be re-registered as a new artifact");
  const proposalView = proposal.snap.body.artifacts.find(
    (a: { kind: string }) => a.kind === "proposal",
  );
  assert.equal(proposalView.applicationState, "pending");

  // 9. Durable apply through the collaboration channel; the document content changes.
  const acceptedApply = await json("POST", `/api/ai/writing/artifacts/${proposalView.id}/review`, {
    decisionId: "decision-1",
    revision: proposalView.reviewRevision ?? 0,
    action: "accept",
  });
  assert.equal(acceptedApply.status, 200, JSON.stringify(acceptedApply.body));
  assert.equal(acceptedApply.body.applicationState, "applied");
  assert.ok(acceptedApply.body.receipt?.operationId);
  // Content reads the persisted projection; the durable apply lands asynchronously.
  const serialized = await waitUntil("adopted block in persisted content", async () => {
    const docContent = await json("GET", `/api/documents/${documentId}/content`);
    const text = JSON.stringify(docContent.body);
    return text.includes("冒烟测试生成的新提案段落") ? text : undefined;
  });
  assert.ok(serialized.includes("参考资料"), "citation reference paragraph written");
  assert.ok(serialized.includes(documentId), "citation link targets the source document");
  const replayDecision = await json("POST", `/api/ai/writing/artifacts/${proposalView.id}/review`, {
    decisionId: "decision-1",
    revision: proposalView.reviewRevision ?? 0,
    action: "accept",
  });
  assert.equal(replayDecision.status, 200);
  assert.equal(replayDecision.body.receipt.operationId, acceptedApply.body.receipt.operationId);

  // 10. Cancellation stops the run without deleting accepted history.
  const freeConv = await json("POST", "/api/ai/writing/conversations", {
    targetDocumentId: documentId,
  });
  const holdSubmit = await json(
    "POST",
    `/api/ai/writing/conversations/${freeConv.body.id}/messages`,
    {
      clientMessageId: "cm-hold",
      idempotencyKey: "ik-hold",
      text: "hold 这段文字慢慢写",
      expectedContextRevision: freeConv.body.contextRevision,
    },
  );
  assert.equal(holdSubmit.status, 202);
  await waitUntil("run started", async () => {
    const snap = await json("GET", `/api/ai/writing/conversations/${freeConv.body.id}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === holdSubmit.body.runId);
    return run && run.status !== "queued" ? run : undefined;
  });
  const cancelled = await json(
    "POST",
    `/api/ai/writing/conversations/${freeConv.body.id}/runs/${holdSubmit.body.runId}/cancel`,
  );
  assert.equal(cancelled.status, 200);
  const cancelSettled = await waitUntil("cancelled settled", async () => {
    const snap = await json("GET", `/api/ai/writing/conversations/${freeConv.body.id}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === holdSubmit.body.runId);
    return ["cancelled", "interrupted"].includes(run?.status) ? run : undefined;
  });
  assert.ok(cancelSettled);

  // 11. Public visitor flow: site management + draft-site visibility boundaries.
  const siteCreate = await json("POST", "/api/qa-sites", {
    ownerWorkspaceId: "ws_default",
    slug: "smoke-site",
    name: "冒烟站点",
  });
  assert.equal(siteCreate.status, 201, JSON.stringify(siteCreate.body));
  const siteId = siteCreate.body.id as string;
  const draftShell = await app.inject({ url: "/api/public/qa-sites/by-slug/smoke-site" });
  assert.equal(draftShell.statusCode, 404, "draft sites never surface in the public shell");
  const anonymousConversation = await app.inject({
    method: "POST",
    url: `/api/public/qa-sites/${siteId}/conversations`,
    payload: {},
  });
  assert.equal(anonymousConversation.statusCode, 403);

  // 12. Publish and answer publicly: sources → approved documents → activate → visitor session →
  //     cited answer → evidence projection without internal identifiers.
  const setSources = await json("PUT", `/api/qa-sites/${siteId}/sources`, {
    expectedRevision: siteCreate.body.revision,
    sources: [{ workspaceId: "ws_default", publicLabel: "知书帮助中心" }],
  });
  assert.equal(setSources.status, 200, JSON.stringify(setSources.body));
  const siteDetail = await json("GET", `/api/qa-sites/${siteId}`);
  const sourceId = siteDetail.body.sources[0].id as string;
  const approve = await json("PUT", `/api/qa-sites/${siteId}/sources/${sourceId}/documents`, {
    items: [{ documentId, action: "approve" }],
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const liveDetail = await json("GET", `/api/qa-sites/${siteId}`);
  const activate = await json("POST", `/api/qa-sites/${siteId}/activate`, {
    expectedRevision: liveDetail.body.site.revision,
  });
  assert.equal(activate.status, 200, JSON.stringify(activate.body));
  const liveShell = await app.inject({ url: "/api/public/qa-sites/by-slug/smoke-site" });
  assert.equal(liveShell.statusCode, 200);
  const session = await app.inject({
    method: "POST",
    url: `/api/public/qa-sites/${siteId}/visitor-session`,
    payload: {},
  });
  assert.equal(session.statusCode, 201, session.body);
  const setCookie = session.headers["set-cookie"];
  const cookieRaw = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
  if (!cookieRaw || !cookieRaw.startsWith("zhishu_qa_site="))
    throw new Error("visitor cookie was not issued");
  const cookie = cookieRaw;
  const pubConv = await json(
    "POST",
    `/api/public/qa-sites/${siteId}/conversations`,
    {},
    { cookie },
  );
  assert.equal(pubConv.status, 201, JSON.stringify(pubConv.body));
  const pubConvId = pubConv.body.id as string;
  const pubSubmit = await json(
    "POST",
    `/api/public/qa-sites/${siteId}/conversations/${pubConvId}/messages`,
    {
      clientMessageId: "cm-pub",
      idempotencyKey: "ik-pub",
      text: "知书是做什么的？",
      expectedContextRevision: pubConv.body.contextRevision,
    },
    { cookie },
  );
  assert.equal(pubSubmit.status, 202, JSON.stringify(pubSubmit.body));
  const pubAnswered = await waitUntil("public answer", async () => {
    const snap = await json(
      "GET",
      `/api/public/qa-sites/${siteId}/conversations/${pubConvId}`,
      undefined,
      { cookie },
    );
    const run = snap.body.runs.find((r: { id: string }) => r.id === pubSubmit.body.runId);
    if (!run) return undefined;
    if (["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("public run terminated: " + run.status + " " + (run.errorCode ?? ""));
    if (run.status === "completed")
      return snap.body.messages.find(
        (m: { runId: string; role: string }) =>
          m.runId === pubSubmit.body.runId && m.role === "assistant",
      );
    return undefined;
  });
  const pubCitation = pubAnswered.parts.find((p: { kind: string }) => p.kind === "citation");
  assert.ok(pubCitation, "public answer carries a citation part");
  const pubArtifact = await json(
    "GET",
    `/api/public/qa-sites/${siteId}/artifacts/${pubCitation.citation.evidenceArtifactId}?conversationId=${pubConvId}`,
    undefined,
    { cookie },
  );
  assert.equal(pubArtifact.status, 200, JSON.stringify(pubArtifact.body));
  assert.equal(pubArtifact.body.sources[0].title, "知书产品说明");
  const projected = JSON.stringify(pubArtifact.body);
  assert.ok(
    !projected.includes("ws_smoke") && !projected.includes("snap_smoke"),
    "projection hides internal ids",
  );
  console.log(
    "ai-smoke passed: 12 scenario groups, qa+writing+handoff+apply+cancel+public visitor",
  );
} catch (error) {
  failures = 1;
  console.error("ai-smoke failed:", error);
} finally {
  await collaboration.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
process.exit(failures);
