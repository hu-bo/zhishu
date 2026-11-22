import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { LlmAdapter, ToolCallId, type GenerateOptions } from "@zhishu/dsh-agent/kernel";
import type { RagService } from "../modules/rag/rag.service.js";
import type { EvidenceBundle } from "@zhishu/ai-contracts";
import * as schema from "../../database/schema/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCollaborationServer } from "../modules/collaboration/hocuspocus.server.js";
import { OperationsMetrics } from "../modules/health/operations-metrics.js";

/**
 * Scripted end-to-end smoke for the unified assistant (no external model traffic):
 * one conversation flows question -> create-draft (atomic binding) -> proposal apply,
 * with idempotency, cancellation, context revision isolation and public visitor boundaries.
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

/** One scripted DSH model serves every plugin: answer, draft and proposal tools. */
class ScriptedDshModel extends LlmAdapter {
  calls = 0;
  private *toolCall(name: string, args: unknown) {
    const block = {
      type: "tool-call" as const,
      id: ToolCallId(`call-smoke-${name}`),
      name,
      arguments: JSON.stringify(args),
    };
    yield { type: "block-end" as const, index: 0, block };
    yield { type: "finish" as const, reason: { kind: "tool-calls" as const } };
  }
  async *stream(options: GenerateOptions) {
    this.calls++;
    const messages = options.messages;
    const isRuntimeContext = (m: (typeof messages)[number]) =>
      m.role === "user" &&
      (Array.isArray(m.content) ? m.content : []).some(
        (b) =>
          b.type === "text" && (b as { text: string }).text.startsWith("Current runtime context"),
      );
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user" && !isRuntimeContext(messages[i])) {
        lastUserIndex = i;
        break;
      }
    }
    const toolThisTurn = messages.slice(lastUserIndex + 1).some((m) => m.role === "tool");
    const fullText = (messages[lastUserIndex]?.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    // History is embedded as data; the current instruction follows the 本轮输入 marker.
    const text = fullText.split("本轮输入：").pop() ?? fullText;
    if (text.includes("hold") && !toolThisTurn) {
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
    const draftArgs = {
      blocks: [
        { type: "heading", level: 1, text: "知产品介绍" },
        { type: "paragraph", text: "知书提供在线文档编辑与团队协作能力。" },
      ],
      summary: "冒烟草稿",
      citations: [{ evidenceId: "ev_smoke", quote: "在线文档编辑" }],
    };
    // Research-first draft: the Run carries no reference artifact, so the model must
    // search, then read (registering evidence through this Run's own sources), then draft.
    if (text.includes("检索后起草")) {
      const turnTools = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool");
      if (turnTools.length === 0) {
        yield* this.toolCall("search_platform", { query: "知书" });
        return;
      }
      if (turnTools.length === 1) {
        const raw = JSON.stringify(turnTools[turnTools.length - 1]);
        const sourceId = /sourceId\\+"\s*:\s*\\+"([^"\\]+)/.exec(raw)?.[1] ?? "";
        yield* this.toolCall("read_platform_source", { sourceId });
        return;
      }
      yield* this.toolCall("draft_document", draftArgs);
      return;
    }
    if (!toolThisTurn) {
      let name = "answer_with_citations";
      let args: unknown = {
        status: "answered",
        text: "知书支持在线文档编辑与团队协作。",
        citations: [{ evidenceId: "ev_smoke", quote: "在线文档编辑" }],
      };
      if (text.includes("起草")) {
        name = "draft_document";
        args = draftArgs;
      } else if (text.includes("续写")) {
        name = "continue_document";
        args = {
          blocks: [
            {
              type: "paragraph",
              text: "这是冒烟测试生成的新提案段落：知书提供在线文档编辑与团队协作能力。",
            },
          ],
          summary: "冒烟提案",
          citations: [{ evidenceId: "ev_smoke", quote: "在线文档编辑" }],
        };
      }
      const block = {
        type: "tool-call" as const,
        id: ToolCallId("call-smoke-1"),
        name,
        arguments: JSON.stringify(args),
      };
      yield { type: "block-end" as const, index: 0, block };
      yield { type: "finish" as const, reason: { kind: "tool-calls" as const } };
      return;
    }
    const textBlock = { type: "text" as const, text: "已完成。" };
    yield { type: "block-start" as const, index: 0, blockType: "text" as const };
    yield { type: "text-delta" as const, index: 0, text: "已完成。" };
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
  assistantAdapter: new ScriptedDshModel(),
  ragStub: stubRag,
});
const collaboration = createCollaborationServer(
  config,
  app.db,
  app.dbPool,
  () => process.exit(1),
  metrics,
  app.log,
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

  // 1. Unified capabilities: one engine, web research unavailable without a key.
  const caps = await json("GET", "/api/ai/capabilities");
  assert.equal(caps.status, 200);
  assert.equal(caps.body.enabled, true);
  assert.equal(caps.body.engine, "dsh-native-v1");
  assert.equal(caps.body.webSearchAvailable, false);
  assert.ok(caps.body.plugins.includes("rag") && caps.body.plugins.includes("writing"));

  // 2. Source document for evidence re-validation and proposal apply.
  const createdDoc = await json("POST", "/api/documents/", { title: "冒烟来源文档" });
  assert.equal(createdDoc.status, 201);
  const documentId = createdDoc.body.id as string;
  const smokeSource = evidence.sources[0];
  if (smokeSource.sourceKind === "document") {
    smokeSource.sourceId = documentId;
    smokeSource.documentId = documentId;
    evidence.items[0].sourceId = documentId;
  }

  // 3. One conversation: question -> cited answer, idempotent replay, key-reuse conflict.
  const conv = await json("POST", "/api/ai/conversations", {});
  assert.equal(conv.status, 201);
  const conversationId = conv.body.id as string;
  const submitBody = {
    clientMessageId: "cm-1",
    idempotencyKey: "ik-1",
    text: "知书是做什么的？",
    expectedContextRevision: conv.body.contextRevision,
    intentHint: "qa",
  };
  const accepted = await json(
    "POST",
    `/api/ai/conversations/${conversationId}/messages`,
    submitBody,
  );
  assert.equal(accepted.status, 202);
  const runId = accepted.body.runId as string;
  const replay = await json("POST", `/api/ai/conversations/${conversationId}/messages`, submitBody);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.runId, runId);
  const conflict = await json("POST", `/api/ai/conversations/${conversationId}/messages`, {
    ...submitBody,
    text: "同一幂等键换问题",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
  const answered = await waitUntil("answer", async () => {
    const snap = await json("GET", `/api/ai/conversations/${conversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === runId);
    if (!run) return undefined;
    if (run.status === "completed")
      return snap.body.messages.find(
        (m: { runId: string; role: string }) => m.runId === runId && m.role === "assistant",
      );
    if (["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("run terminated: " + run.status + " " + (run.errorCode ?? ""));
    return undefined;
  });
  const citationPart = answered.parts.find((p: { kind: string }) => p.kind === "citation");
  assert.ok(citationPart, "answered message must carry a citation part");
  assert.equal(citationPart.citation.quote, "在线文档编辑");

  // 4. Scope change bumps the single context revision; stale revisions are rejected.
  const scopeChange = await json("POST", `/api/ai/conversations/${conversationId}/context`, {
    scope: { kind: "documents", documentIds: [documentId] },
    expectedContextRevision: conv.body.contextRevision,
  });
  assert.equal(scopeChange.status, 200);
  const staleSubmit = await json("POST", `/api/ai/conversations/${conversationId}/messages`, {
    clientMessageId: "cm-2",
    idempotencyKey: "ik-2",
    text: "旧修订提交",
    expectedContextRevision: conv.body.contextRevision,
  });
  assert.equal(staleSubmit.status, 409);

  // 5. Web search without a configured key is an explicit 503.
  const webRejected = await json("POST", `/api/ai/conversations/${conversationId}/messages`, {
    clientMessageId: "cm-web",
    idempotencyKey: "ik-web",
    text: "请联网查一下",
    expectedContextRevision: scopeChange.body.contextRevision,
    webSearch: true,
  });
  assert.equal(webRejected.status, 503);

  // 6. Create draft in the SAME conversation: atomic document creation + target binding.
  const draftAccepted = await json("POST", `/api/ai/conversations/${conversationId}/draft`, {
    idempotencyKey: "draft-1",
    instruction: "基于资料起草一篇介绍",
    workspaceId: "ws_default",
    expectedContextRevision: scopeChange.body.contextRevision,
    referenceArtifactIds: [citationPart.citation.evidenceArtifactId],
  });
  assert.equal(draftAccepted.status, 202, JSON.stringify(draftAccepted.body));
  const draftReplay = await json("POST", `/api/ai/conversations/${conversationId}/draft`, {
    idempotencyKey: "draft-1",
    instruction: "基于资料起草一篇介绍",
    workspaceId: "ws_default",
    expectedContextRevision: scopeChange.body.contextRevision,
    referenceArtifactIds: [citationPart.citation.evidenceArtifactId],
  });
  assert.equal(draftReplay.status, 202);
  assert.equal(draftReplay.body.runId, draftAccepted.body.runId);
  const bound = await waitUntil("draft binding", async () => {
    const snap = await json("GET", `/api/ai/conversations/${conversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === draftAccepted.body.runId);
    if (run && ["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("draft run failed: " + run.status + " " + (run.errorCode ?? ""));
    return snap.body.conversation.targetDocumentId ? snap.body.conversation : undefined;
  });
  const draftDocumentId = bound.targetDocumentId as string;
  assert.ok(draftDocumentId.startsWith("doc_"));
  const draftContent = await waitUntil("draft body persisted", async () => {
    const docContent = await json("GET", `/api/documents/${draftDocumentId}/content`);
    return JSON.stringify(docContent.body).includes("知产品介绍") ? docContent.body : undefined;
  });
  const draftSerialized = JSON.stringify(draftContent);
  // Source links persist into the body: the quoted text carries a link mark and a reference
  // paragraph names the source. Decoration splits text nodes, so assert fragments, not a span.
  assert.ok(draftSerialized.includes("在线文档编辑"), "draft keeps the cited text");
  assert.ok(draftSerialized.includes("参考资料"), "draft writes a reference paragraph");
  assert.ok(draftSerialized.includes(documentId), "draft reference links the source document");
  assert.ok(draftSerialized.includes('"type":"link"'), "draft citation uses a link mark");
  // A second create-draft returns the already-bound target, never a second document.
  const alreadyBound = await json("POST", `/api/ai/conversations/${conversationId}/draft`, {
    idempotencyKey: "draft-2",
    instruction: "再写一篇",
    workspaceId: "ws_default",
    expectedContextRevision: bound.contextRevision,
  });
  assert.equal(alreadyBound.status, 202);
  assert.equal(alreadyBound.body.status, "already-bound");
  assert.equal(alreadyBound.body.documentId, draftDocumentId);

  // 7. Continue writing on the bound document: carried sources are re-validated, then a
  //    proposal artifact is produced and applied through the durable channel.
  const proposalSubmit = await json("POST", `/api/ai/conversations/${conversationId}/messages`, {
    clientMessageId: "cm-write",
    idempotencyKey: "ik-write",
    text: "续写一段补充说明",
    expectedContextRevision: bound.contextRevision,
    intentHint: "writing",
    referenceArtifactIds: [citationPart.citation.evidenceArtifactId],
  });
  assert.equal(proposalSubmit.status, 202, JSON.stringify(proposalSubmit.body));
  const proposalView = await waitUntil("proposal artifact", async () => {
    const snap = await json("GET", `/api/ai/conversations/${conversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === proposalSubmit.body.runId);
    if (run && ["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("proposal run failed: " + run.status + " " + (run.errorCode ?? ""));
    return snap.body.artifacts.find((a: { kind: string }) => a.kind === "proposal");
  });
  assert.equal(proposalView.applicationState, "pending");
  const acceptedApply = await json("POST", `/api/ai/artifacts/${proposalView.id}/review`, {
    decisionId: "decision-1",
    revision: proposalView.reviewRevision ?? 0,
    action: "accept",
  });
  assert.equal(acceptedApply.status, 200, JSON.stringify(acceptedApply.body));
  assert.equal(acceptedApply.body.applicationState, "applied");
  assert.ok(acceptedApply.body.receipt?.operationId);
  const serialized = await waitUntil("adopted block in persisted content", async () => {
    const docContent = await json("GET", `/api/documents/${draftDocumentId}/content`);
    const text = JSON.stringify(docContent.body);
    return text.includes("冒烟测试生成的新提案段落") ? text : undefined;
  });
  assert.ok(serialized.includes("参考资料"), "citation reference paragraph written");

  // 8. Cancellation stops the run without deleting accepted history.
  const holdSubmit = await json("POST", `/api/ai/conversations/${conversationId}/messages`, {
    clientMessageId: "cm-hold",
    idempotencyKey: "ik-hold",
    text: "hold 这段文字慢慢写",
    expectedContextRevision: bound.contextRevision,
    intentHint: "writing",
  });
  assert.equal(holdSubmit.status, 202);
  await waitUntil("run started", async () => {
    const snap = await json("GET", `/api/ai/conversations/${conversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === holdSubmit.body.runId);
    return run && run.status !== "queued" ? run : undefined;
  });
  const cancelled = await json(
    "POST",
    `/api/ai/conversations/${conversationId}/runs/${holdSubmit.body.runId}/cancel`,
  );
  assert.equal(cancelled.status, 200);
  await waitUntil("cancelled settled", async () => {
    const snap = await json("GET", `/api/ai/conversations/${conversationId}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === holdSubmit.body.runId);
    return ["cancelled", "interrupted"].includes(run?.status) ? run : undefined;
  });

  // 8b. create-draft without reference artifacts: the model researches through
  //     search_platform + read_platform_source and must register the read evidence inside
  //     this very Run (regression: lost sources threw INVALID_CITATION and the draft
  //     command then failed as OUTPUT_REQUIRED).
  const researchConv = await json("POST", "/api/ai/conversations", {});
  assert.equal(researchConv.status, 201);
  const researchDraft = await json("POST", `/api/ai/conversations/${researchConv.body.id}/draft`, {
    idempotencyKey: "draft-research",
    instruction: "检索后起草一篇介绍",
    workspaceId: "ws_default",
    expectedContextRevision: researchConv.body.contextRevision,
  });
  assert.equal(researchDraft.status, 202, JSON.stringify(researchDraft.body));
  const researchBound = await waitUntil("research draft binding", async () => {
    const snap = await json("GET", `/api/ai/conversations/${researchConv.body.id}`);
    const run = snap.body.runs.find((r: { id: string }) => r.id === researchDraft.body.runId);
    if (run && ["failed", "cancelled", "interrupted"].includes(run.status))
      throw new Error("research draft run failed: " + run.status + " " + (run.errorCode ?? ""));
    return snap.body.conversation.targetDocumentId ? snap.body : undefined;
  });
  assert.notEqual(researchBound.conversation.targetDocumentId, draftDocumentId);
  assert.ok(
    researchBound.artifacts.some((a: { kind: string }) => a.kind === "evidence"),
    "platform read registered the Run's evidence bundle",
  );
  assert.ok(
    researchBound.artifacts.some((a: { kind: string }) => a.kind === "draft"),
    "the researched draft artifact exists",
  );

  // 9. Public visitor flow: site management + approval + cited answer + projection.
  const siteCreate = await json("POST", "/api/qa-sites", {
    ownerWorkspaceId: "ws_default",
    slug: "smoke-site",
    name: "冒烟站点",
  });
  assert.equal(siteCreate.status, 201, JSON.stringify(siteCreate.body));
  const siteId = siteCreate.body.id as string;
  const draftShell = await app.inject({ url: "/api/public/qa-sites/by-slug/smoke-site" });
  assert.equal(draftShell.statusCode, 404, "draft sites never surface in the public shell");
  const setSources = await json("PUT", `/api/qa-sites/${siteId}/sources`, {
    expectedRevision: siteCreate.body.revision,
    sources: [{ workspaceId: "ws_default", publicLabel: "知书帮助中心" }],
  });
  assert.equal(setSources.status, 200, JSON.stringify(setSources.body));
  const siteDetail = await json("GET", `/api/qa-sites/${siteId}`);
  const sourceId = siteDetail.body.sources[0].id as string;
  const approve = await json("PUT", `/api/qa-sites/${siteId}/sources/${sourceId}/documents`, {
    expectedRevision: siteDetail.body.site.revision,
    items: [{ documentId, action: "approve" }],
  });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const liveDetail = await json("GET", `/api/qa-sites/${siteId}`);
  const activate = await json("POST", `/api/qa-sites/${siteId}/activate`, {
    expectedRevision: liveDetail.body.site.revision,
  });
  assert.equal(activate.status, 200, JSON.stringify(activate.body));
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
  // Public visitors cannot create drafts or bind targets.
  const pubDraft = await json(
    "POST",
    `/api/public/qa-sites/${siteId}/conversations/${pubConvId}/draft`,
    {
      idempotencyKey: "pub-draft",
      instruction: "写",
      workspaceId: "ws_default",
      expectedContextRevision: 1,
    },
    { cookie },
  );
  assert.ok([403, 404].includes(pubDraft.status), "public draft creation is refused");
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
    "ai-smoke passed: unified assistant qa+draft-binding+proposal-apply+cancel+research-draft+public visitor",
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
