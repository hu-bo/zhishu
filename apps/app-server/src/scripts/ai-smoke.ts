import "../environment.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { aiRuns } from "../../database/schema/ai.table.js";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import * as Y from "yjs";
import {
  createAiEventValidator,
  replacementChanges,
  type AuthoringRequest,
  type EvidenceItem,
} from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-runtime";
import { createDatabase, createPool } from "../../database/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCollaborationServer } from "../modules/collaboration/hocuspocus.server.js";
import { DocumentRepository } from "../modules/documents/document.repository.js";
import { serverRoot } from "../paths.js";
import type { AiTaskView } from "../modules/ai/ai.schema.js";
import { mockUser } from "../modules/identity/mock-user.js";
import { startImageProviderFixture } from "./image-provider-fixture.js";
import { spawn } from "node:child_process";
import type { ChatSnapshot } from "@zhishu/chat-contracts";
import { AssetObjectStorage } from "../modules/assets/asset-storage.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class ScriptedModel extends BaseChatModel {
  calls = 0;
  private gate:
    { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  _llmType() {
    return "zhishu-integration-test";
  }
  bindTools(_tools: BindToolsInput[]) {
    void _tools;
    return this;
  }
  holdNext() {
    this.gate = { started: deferred(), release: deferred() };
    return this.gate;
  }
  async result(messages: BaseMessage[], signal?: AbortSignal) {
    this.calls++;
    const gate = this.gate;
    this.gate = undefined;
    if (gate) {
      gate.started.resolve();
      await Promise.race([
        gate.release.promise,
        new Promise<never>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error("ABORTED"));
          else
            signal?.addEventListener("abort", () => reject(new Error("ABORTED")), { once: true });
        }),
      ]);
    }
    signal?.throwIfAborted();
    const objects = messages.map((m) => {
      try {
        return JSON.parse(typeof m.content === "string" ? m.content : "") as Record<
          string,
          unknown
        >;
      } catch {
        return {};
      }
    });
    const input =
      objects.find((o) => typeof o.instruction === "string" || typeof o.message === "string") ?? {};
    const evidence = (Array.isArray(input.evidence) ? input.evidence : []) as EvidenceItem[];
    const read = objects.find(
      (o) => Array.isArray(o) && (o[0] as EvidenceItem | undefined)?.evidenceId,
    ) as unknown as EvidenceItem[] | undefined;
    const source = objects.find(
      (o) =>
        Array.isArray(o) &&
        typeof (o[0] as { sourceId?: string } | undefined)?.sourceId === "string",
    ) as unknown as { sourceId: string }[] | undefined;
    if (input.intent === "research" && !source)
      return { name: "searchKnowledge", args: { query: "产品目标" }, id: "search_one" };
    if (input.intent === "research" && !read)
      return { name: "readSource", args: { sourceId: source![0]!.sourceId }, id: "read_one" };
    const item = (read ?? evidence)[0];
    const citations = item
      ? [{ evidenceId: item.evidenceId, quote: item.text.slice(0, Math.min(24, item.text.length)) }]
      : [];
    if (typeof input.message === "string")
      return {
        name: "chat_result",
        id: "chat_final",
        args: {
          status: "replied",
          text: item
            ? `根据所选资料，我们可以先明确产品目标，再把关键问题整理为可执行的方案。\n\n${item.text.slice(0, 80)}`
            : "我们可以先从三个问题开始：这篇文档写给谁、希望解决什么问题，以及读者看完后可以采取什么行动。\n\n你也可以先告诉我一个零散的想法，我们一起把它梳理清楚。",
          citations,
        },
      };
    return {
      name: "authoring_result",
      id: "authoring_final",
      args: {
        blocks: [
          { type: "heading", level: 2, text: "目标与写作思路" },
          {
            type: "paragraph",
            text: "先把需要解决的问题说清楚，再围绕读者真正关心的内容组织结构。让每一段都有明确的目的，让每一个结论都能找到依据。",
          },
          {
            type: "paragraph",
            text: "建议从背景、目标、方案和下一步四个部分展开。先完成一份轻量草稿，再结合反馈逐步补充细节。",
          },
        ],
        summary: "新增目标与写作思路，保留原有正文。",
        citations,
      },
    };
  }
  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
    const call = await this.result(messages, options.signal);
    return {
      generations: [
        {
          text: "",
          message: new AIMessage({ content: "", tool_calls: [{ ...call, type: "tool_call" }] }),
        },
      ],
    };
  }
  async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"]) {
    const call = await this.result(messages, options.signal),
      args = JSON.stringify(call.args);
    for (let offset = 0; offset < args.length; offset += 32) {
      options.signal?.throwIfAborted();
      yield new ChatGenerationChunk({
        text: "",
        message: new AIMessageChunk({
          content: "",
          tool_call_chunks: [
            {
              name: offset === 0 ? call.name : undefined,
              id: offset === 0 ? call.id : undefined,
              index: 0,
              args: args.slice(offset, offset + 32),
              type: "tool_call_chunk",
            },
          ],
        }),
      });
    }
  }
}

// Deterministic test adapter only: production uses the official DSH provider plugin.
class ScriptedDshModel extends LlmAdapter {
  constructor(private model: ScriptedModel) {
    super();
  }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const messages = options.messages.map((message) => {
      let text = message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      try {
        const value = JSON.parse(text) as { text?: string };
        if (typeof value.text === "string") text = value.text;
      } catch {
        /* Plain text fixture. */
      }
      return new HumanMessage(text);
    });
    const call = await this.model.result(messages, options.signal);
    if (
      options.tools?.some((tool) => tool.name === "create_image") &&
      options.messages.some(
        (m) =>
          m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("配图")),
      ) &&
      !options.messages.some((m) => m.role === "tool")
    ) {
      const id = ToolCallId("image_fixture_one");
      const args = JSON.stringify({ prompt: "白色画布上的文章示意配图" });
      yield {
        type: "block-end",
        index: 0,
        block: { type: "tool-call", id, name: "create_image", arguments: args },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    if (!options.tools?.some((tool) => tool.name === "authoring_result")) {
      const turns = options.messages.filter((m) => m.role === "user" && m.source?.kind === "user");
      const text = `第 ${turns.length} 轮写作讨论：${
        turns
          .at(-1)
          ?.content.filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") ?? ""
      }`;
      yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      yield { type: "finish", reason: { kind: "stop" } };
      return;
    }
    const name =
      call.name === "searchKnowledge"
        ? "search_sources"
        : call.name === "readSource"
          ? "read_source"
          : call.name;
    const args = JSON.stringify(call.args),
      id = ToolCallId(call.id);
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: args };
    yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: args } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
}

assert.ok(process.env.DATABASE_URL, "Configure the project .env first");
const admin = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
const testUrl = new URL(process.env.AI_TEST_DATABASE_URL ?? process.env.DATABASE_URL);
const databaseName = process.env.AI_TEST_DATABASE_URL
  ? testUrl.pathname.slice(1)
  : `zhishu_ai_test_${randomUUID().replaceAll("-", "")}`;
assert.match(
  databaseName,
  /^zhishu_ai_test_[a-z0-9_]+$/u,
  "Use a disposable zhishu_ai_test_* database; this script removes it afterward",
);
testUrl.pathname = `/${databaseName}`;
if (!process.env.AI_TEST_DATABASE_URL) await admin.query(`create database "${databaseName}"`);
const pool = createPool({ connectionString: testUrl.href, max: 10 });
let app: Awaited<ReturnType<typeof buildApp>> | undefined,
  collaboration: ReturnType<typeof createCollaborationServer> | undefined;
const serve = process.argv.includes("--serve"),
  model = new ScriptedModel({});
let applyFault: "before" | "after" | null = null;
const imageFixture = process.env.WRITING_TEST_STORAGE_ENDPOINT
  ? await startImageProviderFixture()
  : undefined;
try {
  await migrate(createDatabase(pool), {
    migrationsFolder: resolve(serverRoot, "database/migrations"),
  });
  await pool.query("create schema ai_checkpoint");
  const saver = new PostgresSaver(pool, undefined, { schema: "ai_checkpoint" });
  await saver.setup();
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: testUrl.href,
    NODE_ENV: "test",
    AUTH_MODE: "mock",
    LOG_LEVEL: "silent",
    PORT: "3310",
    COLLABORATION_PORT: "3311",
    COLLABORATION_PUBLIC_URL: "ws://127.0.0.1:3311",
    COLLABORATION_ALLOWED_ORIGINS: "http://127.0.0.1:5187,http://127.0.0.1:5173",
    AI_MODEL: undefined,
    AI_API_KEY: undefined,
    AI_IMAGE_MODEL: imageFixture ? "fixture-image" : undefined,
    AI_IMAGE_API_KEY: imageFixture ? "image-fixture-key" : undefined,
    AI_IMAGE_BASE_URL: imageFixture?.baseURL,
    ASSET_STORAGE_ENDPOINT: process.env.WRITING_TEST_STORAGE_ENDPOINT,
    ASSET_STORAGE_PUBLIC_ENDPOINT: undefined,
    ASSET_STORAGE_ACCESS_KEY_ID: imageFixture ? "zhishu_test" : undefined,
    ASSET_STORAGE_SECRET_ACCESS_KEY: imageFixture ? "zhishu_disposable_test_only" : undefined,
    ASSET_STORAGE_BUCKET: `zhishu-writing-test-${randomUUID().slice(0, 8)}`,
    ASSET_STORAGE_AUTO_CREATE_BUCKET: "true",
    ASSET_STORAGE_CHECK_ON_STARTUP: "false",
  });
  app = await buildApp(config, {
    aiModel: model,
    writingAdapter: new ScriptedDshModel(model),
    collaborationOwner: {
      snapshot: (principal, id) => collaboration!.owner.snapshot(principal, id),
      apply: async (input) => {
        const fault = applyFault;
        applyFault = null;
        if (fault === "before") throw new Error("QA_WRITE_TRANSPORT_INTERRUPTED");
        const result = await collaboration!.owner.apply(input);
        if (fault === "after") throw new Error("QA_WRITE_ACK_LOST");
        return result;
      },
    },
    sessionRevoker: {
      revokeDocumentSessions: (id, generation) =>
        collaboration?.revokeDocumentSessions(id, generation),
    },
  });
  collaboration = createCollaborationServer(config, app.db, app.dbPool);
  await collaboration.listen();
  await app.ready();
  const login = (id?: string) =>
    app!.inject({ method: "POST", url: "/api/auth/mock/login", payload: id ? { userId: id } : {} });
  const ownerToken = (await login()).json<{ accessToken: string }>().accessToken;
  const readerToken = (await login("mock-editor-001")).json<{ accessToken: string }>().accessToken;
  const call = async (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
    status = 200,
    token = ownerToken,
  ) => {
    const response = await app!.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    assert.equal(response.statusCode, status, `${method} ${url}: unexpected HTTP status`);
    return response;
  };
  const workspace = (
    await call(
      "POST",
      "/api/knowledge/workspaces",
      { name: "我的创作空间", kind: "personal", icon: "📝" },
      201,
    )
  ).json<{ id: string }>();
  const team = (
    await call(
      "POST",
      "/api/knowledge/workspaces",
      { name: "产品团队", kind: "team", icon: "📚" },
      201,
    )
  ).json<{ id: string }>();
  const doc = (
    await call("POST", "/api/documents", { title: "产品方案草稿", workspaceId: workspace.id }, 201)
  ).json<{ id: string }>();
  const source = (
    await call("POST", "/api/documents", { title: "产品设计原则", workspaceId: team.id }, 201)
  ).json<{ id: string }>();
  const principal = { ...mockUser };
  const sourceContext = await collaboration.owner.snapshot(principal, source.id);
  await collaboration.owner.apply({
    principal,
    batch: {
      operationId: `op_${randomUUID()}`,
      origin: "user",
      documentId: source.id,
      generationId: sourceContext.snapshot.generationId,
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
                text: "知书面向持续写作与团队知识积累。产品设计首先保证正文空间、真实保存状态与清楚的权限边界。AI 结果应先形成完整草稿，再由确定的版本与权限检查决定是否写入个人文档。",
              },
            ],
          },
        },
      ],
    },
    expectedDurableSeq: sourceContext.snapshot.durableSeq,
    baseStructureRevision: sourceContext.structureRevision,
    guard: async () => undefined,
    record: async () => undefined,
  });
  const context = () => collaboration!.owner.snapshot(principal, doc.id);
  const authoring = async (documentId = doc.id) => {
    const captured = await collaboration!.owner.snapshot(principal, documentId);
    const request: AuthoringRequest = {
      kind: "authoring",
      requestId: randomUUID(),
      intent: "create",
      instruction: "整理产品方案的写作思路",
      document: {
        documentId,
        generationId: captured.snapshot.generationId,
        durableSeq: captured.snapshot.durableSeq,
        contentHash: hashContent(captured.snapshot.content),
      },
      baseStructureRevision: captured.structureRevision,
      target: {
        kind: "document-end",
        afterBlockId: captured.snapshot.content.content.at(-1)?.attrs.blockId ?? null,
      },
    };
    return {
      protocolVersion: 1 as const,
      request,
      sourceDocumentIds: [] as string[],
      previousRequestIds: [] as string[],
    };
  };
  const events = (body: string, id: string, version: 1 | 2) => {
    const validator =
      version === 1
        ? createAiEventValidator({ requestId: id })
        : createAiEventValidator({ requestId: id, protocolVersion: 2 });
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; payload: { code?: string } });
    for (const event of data)
      assert.equal(validator.push(event).success, true, JSON.stringify(event));
    assert.equal(validator.finish().success, true);
    return data;
  };
  const chat = {
    protocolVersion: 2,
    request: {
      kind: "chat",
      requestId: randomUUID(),
      message: "一起梳理我的想法",
      responseMode: "discussion",
      previousRequestIds: [],
    },
    sourceDocumentIds: [],
  };
  const beforeChat = await context();
  const chatResponse = await call("POST", "/api/ai/chat", chat);
  assert.equal(events(chatResponse.body, chat.request.requestId, 2).at(-1)?.type, "completed");
  assert.equal((await context()).snapshot.durableSeq, beforeChat.snapshot.durableSeq);
  const initialCalls = model.calls;
  await call("POST", "/api/ai/chat", chat);
  assert.equal(model.calls, initialCalls);
  await call(
    "POST",
    "/api/ai/chat",
    { ...chat, request: { ...chat.request, message: "复用 ID 不同输入" } },
    409,
  );
  await call("GET", `/api/ai/requests/${chat.request.requestId}`, undefined, 404, readerToken);
  const forged = {
    ...chat,
    request: {
      ...chat.request,
      requestId: randomUUID(),
      previousRequestIds: [chat.request.requestId],
    },
  };
  await call("POST", "/api/ai/chat", forged, 404, readerToken);
  console.log("PASS Chat: real SSE v2, idempotency, no document writes, private history.");

  const manual = await authoring(),
    beforeManual = await context();
  const manualEvents = events(
    (await call("POST", "/api/ai/authoring", manual)).body,
    manual.request.requestId,
    1,
  );
  assert.equal(manualEvents.at(-1)?.type, "completed", JSON.stringify(manualEvents));
  assert.equal((await context()).snapshot.durableSeq, beforeManual.snapshot.durableSeq);
  const accepted = (
    await call("POST", `/api/ai/requests/${manual.request.requestId}/accept`)
  ).json<{ application: { state: string; receipt: { durableSeq: number } } }>();
  assert.equal(accepted.application.state, "applied");
  assert.equal(accepted.application.receipt.durableSeq, beforeManual.snapshot.durableSeq + 1);
  const replay = await Promise.all([
    call("POST", `/api/ai/requests/${manual.request.requestId}/accept`),
    call("POST", `/api/ai/requests/${manual.request.requestId}/accept`),
  ]);
  for (const r of replay)
    assert.deepEqual(r.json<{ application: unknown }>().application, accepted.application);
  assert.equal((await context()).snapshot.durableSeq, beforeManual.snapshot.durableSeq + 1);
  console.log(
    "PASS Manual: preview is separate, atomic accept, durable receipt, repeated accepts write once.",
  );

  const teamRequest = await authoring(source.id);
  await call("POST", "/api/ai/authoring", teamRequest, 403);
  const readerRequest = await authoring();
  await call("POST", "/api/ai/authoring", readerRequest, 403, readerToken);
  await call("POST", "/api/ai/authoring", { ...readerRequest, writeMode: "auto" }, 400);
  await call("POST", `/api/ai/requests/${manual.request.requestId}/pause-auto`, undefined, 404);
  console.log(
    "PASS Confirmation only: removed mode fields/routes are rejected; team and other subjects cannot write.",
  );

  // Persist a real Y.Text update without changing the structure revision.
  const conflict = await authoring(),
    gate = model.holdNext();
  const pending = call("POST", "/api/ai/authoring", conflict);
  await gate.started.promise;
  const current = await context(),
    repository = new DocumentRepository(app.db),
    scratch = new Y.Doc();
  await repository.replayYjsState(
    {
      documentId: doc.id,
      generationId: current.snapshot.generationId,
      targetSeq: current.snapshot.durableSeq,
    },
    (bytes) => Y.applyUpdate(scratch, bytes),
  );
  const base = Y.encodeStateVector(scratch),
    fragment = scratch.getXmlFragment("content"),
    paragraph = fragment
      .toArray()
      .find((node) => node instanceof Y.XmlElement && node.nodeName === "paragraph");
  assert.ok(paragraph instanceof Y.XmlElement);
  const text = paragraph.toArray().find((node) => node instanceof Y.XmlText);
  assert.ok(text instanceof Y.XmlText);
  text.insert(0, "人工更新：");
  const update = Y.encodeStateAsUpdate(scratch, base);
  // Keep the owner's in-memory projection consistent by using its ordinary WS update path below.
  const { HocuspocusProvider } = await import("@hocuspocus/provider");
  const session = (
    await call(
      "POST",
      `/api/documents/${doc.id}/collaboration-session`,
      { schemaVersion: 5, extensions: [] },
      201,
    )
  ).json<{ documentName: string; token: string }>();
  const connected = new Y.Doc(),
    provider = new HocuspocusProvider({
      url: "ws://127.0.0.1:3311",
      name: session.documentName,
      document: connected,
      token: session.token,
    });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS_SYNC_TIMEOUT")), 10000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  let submittedHash: string | undefined;
  connected.on("update", (bytes: Uint8Array, origin: unknown) => {
    if (origin === "qa-text") submittedHash = createHash("sha256").update(bytes).digest("hex");
  });
  const persisted = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS_ACK_TIMEOUT")), 10000);
    provider.on("stateless", ({ payload }: { payload: string }) => {
      const event = JSON.parse(payload) as { type: string; updateHash: string };
      if (event.type === "persisted" && event.updateHash === submittedHash) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  Y.applyUpdate(connected, update, "qa-text");
  await persisted;
  const afterHuman = await context();
  provider.destroy();
  connected.destroy();
  scratch.destroy();
  gate.release.resolve();
  await pending;
  const conflicted = (
    await call("POST", `/api/ai/requests/${conflict.request.requestId}/accept`)
  ).json<{
    status: string;
    application: { state: string };
  }>();
  assert.equal(conflicted.status, "completed");
  assert.equal(conflicted.application.state, "conflict");
  assert.equal((await context()).snapshot.durableSeq, afterHuman.snapshot.durableSeq);
  console.log(
    "PASS Conflict: an actual websocket text update blocks stale accepted output; completed draft survives.",
  );

  const grounded = {
    protocolVersion: 2,
    request: {
      kind: "chat",
      requestId: randomUUID(),
      message: "总结产品设计原则",
      responseMode: "grounded",
      contextRef: "selected-documents",
      previousRequestIds: [],
    },
    sourceDocumentIds: [source.id],
  };
  assert.equal(
    events((await call("POST", "/api/ai/chat", grounded)).body, grounded.request.requestId, 2).at(
      -1,
    )?.type,
    "completed",
  );
  const groundedResult = (
    await call("GET", `/api/ai/requests/${grounded.request.requestId}`)
  ).json<{ result: { citations: { quote: string }[] } }>();
  assert.ok(groundedResult.result.citations.length);
  const research = await authoring();
  research.request.intent = "research";
  research.request.contextRef = "selected-documents";
  research.sourceDocumentIds = [source.id];
  const researchEvents = events(
    (await call("POST", "/api/ai/authoring", research)).body,
    research.request.requestId,
    1,
  );
  assert.equal(
    researchEvents.at(-1)?.type,
    "completed",
    JSON.stringify(researchEvents.map((e) => ({ type: e.type, code: e.payload.code }))),
  );
  const researched = (await call("GET", `/api/ai/requests/${research.request.requestId}`)).json<{
    result: { citations: unknown[] };
    usage: { searchCalls: number; sourceReads: number };
  }>();
  assert.ok(researched.result.citations.length);
  assert.ok(researched.usage.searchCalls > 0);
  assert.ok(researched.usage.sourceReads > 0);
  await call("PUT", `/api/documents/${source.id}/acl/mock-editor-001`, { actions: ["read", "ai"] });
  const readerChat = { ...grounded, request: { ...grounded.request, requestId: randomUUID() } };
  await call("POST", "/api/ai/chat", readerChat, 200, readerToken);
  const revokedChat = { ...grounded, request: { ...grounded.request, requestId: randomUUID() } },
    revokeGate = model.holdNext(),
    revokedPending = call("POST", "/api/ai/chat", revokedChat, 200, readerToken);
  await revokeGate.started.promise;
  await call("PUT", `/api/documents/${source.id}/acl/mock-editor-001`, { actions: ["read"] });
  revokeGate.release.resolve();
  const revokedEvents = events((await revokedPending).body, revokedChat.request.requestId, 2);
  assert.equal(revokedEvents.at(-1)?.type, "failed");
  assert.ok(!revokedEvents.some((event) => event.type === "chat"));
  await call(
    "GET",
    `/api/ai/requests/${readerChat.request.requestId}`,
    undefined,
    403,
    readerToken,
  );
  console.log(
    "PASS Sources: real team evidence, grounded Chat, research search/read citations, revoked-source delivery denied.",
  );

  const address = await app.listen({ host: "127.0.0.1", port: serve ? 3310 : 0 });
  const disconnected = { ...chat, request: { ...chat.request, requestId: randomUUID() } },
    disconnectGate = model.holdNext();
  const response = await fetch(`${address}/api/ai/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify(disconnected),
  });
  await disconnectGate.started.promise;
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  const awaitState = async (id: string, expected: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = (await call("GET", `/api/ai/requests/${id}`)).json<{
        status: string;
        application: { state: string };
      }>();
      if (task.status === expected) return task;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task did not reach ${expected}`);
  };
  await awaitState(disconnected.request.requestId, "interrupted");
  const beforeResume = await context();
  await call("POST", `/api/ai/requests/${disconnected.request.requestId}/resume`, undefined, 202);
  await awaitState(disconnected.request.requestId, "completed");
  assert.equal((await context()).snapshot.durableSeq, beforeResume.snapshot.durableSeq);
  console.log(
    "PASS Disconnect/resume: official PostgreSQL checkpoint resumes the original input, without any document write.",
  );

  const cancelled = await authoring(),
    cancelGate = model.holdNext(),
    cancelPending = call("POST", "/api/ai/authoring", cancelled);
  await cancelGate.started.promise;
  const beforeCancel = await context();
  await call("POST", `/api/ai/requests/${cancelled.request.requestId}/cancel`);
  await cancelPending;
  await awaitState(cancelled.request.requestId, "cancelled");
  await call("POST", `/api/ai/requests/${cancelled.request.requestId}/resume`, undefined, 409);
  assert.equal((await context()).snapshot.durableSeq, beforeCancel.snapshot.durableSeq);
  console.log("PASS Explicit cancellation: model aborts, no document write, no resume.");

  for (const fault of ["before", "after"] as const) {
    const uncertain = await authoring();
    await call("POST", "/api/ai/authoring", uncertain);
    const before = await context();
    applyFault = fault;
    const first = (
      await call("POST", `/api/ai/requests/${uncertain.request.requestId}/accept`)
    ).json<{ application: { state: string; code: string | null } }>();
    assert.equal(first.application.state, fault === "before" ? "pending" : "applied");
    if (fault === "before") assert.equal(first.application.code, "WRITE_UNCONFIRMED");
    const again = (
      await call("POST", `/api/ai/requests/${uncertain.request.requestId}/accept`)
    ).json<{ application: { state: string } }>();
    assert.equal(again.application.state, "applied");
    assert.equal((await context()).snapshot.durableSeq, before.snapshot.durableSeq + 1);
  }
  console.log(
    "PASS Unknown write outcome: retrying the same proposal confirms one durable write, including a lost success acknowledgement.",
  );

  const selfSourced = await authoring();
  selfSourced.sourceDocumentIds = [doc.id];
  selfSourced.request.contextRef = "selected-documents";
  const selfEvents = events(
    (await call("POST", "/api/ai/authoring", selfSourced)).body,
    selfSourced.request.requestId,
    1,
  );
  assert.equal(selfEvents.at(-1)?.type, "completed");
  const selfResult = (
    await call("POST", `/api/ai/requests/${selfSourced.request.requestId}/accept`)
  ).json<{
    application: { state: string };
    result: { citations: unknown[] };
  }>();
  assert.equal(selfResult.application.state, "applied");
  assert.ok(selfResult.result.citations.length);
  assert.equal(
    (await call("POST", `/api/ai/requests/${selfSourced.request.requestId}/accept`)).json<{
      application: { state: string };
    }>().application.state,
    "applied",
  );
  console.log(
    "PASS Self-sourced writing: a committed update keeps its historical evidence and receipt readable, without relaxing generation or acceptance version guards.",
  );

  const replacement = await authoring();
  replacement.request.intent = "rewrite-document";
  replacement.request.target = { kind: "document" };
  replacement.sourceDocumentIds = [doc.id];
  replacement.request.contextRef = "selected-documents";
  const initialReplacement = await context();
  await call("POST", "/api/ai/authoring", replacement);
  assert.equal((await context()).snapshot.durableSeq, initialReplacement.snapshot.durableSeq);
  const task = (
    await call("GET", `/api/ai/requests/${replacement.request.requestId}`)
  ).json<AiTaskView>();
  assert.ok(task.result && "operationBatch" in task.result);
  const changes = replacementChanges(task.result, initialReplacement.snapshot.content);
  assert.ok(changes.length >= 3);
  const staleReplacement = await authoring();
  staleReplacement.request.intent = "rewrite-document";
  staleReplacement.request.target = { kind: "document" };
  await call("POST", "/api/ai/authoring", staleReplacement);
  const endpoint = `/api/ai/requests/${replacement.request.requestId}/review`;
  const acceptOne = {
    decisionId: randomUUID(),
    revision: 0,
    action: "accept",
    blockIds: [changes[0]!.blockId],
  };
  applyFault = "before";
  const uncertainReview = (await call("POST", endpoint, acceptOne)).json<AiTaskView>();
  assert.equal(uncertainReview.application.code, "WRITE_UNCONFIRMED");
  assert.equal((await context()).snapshot.durableSeq, initialReplacement.snapshot.durableSeq);
  applyFault = "after";
  const one = (await call("POST", endpoint, acceptOne)).json<AiTaskView>();
  assert.equal(one.application.state, "partial");
  assert.equal(one.review?.revision, 1);
  const afterOne = await context();
  assert.equal(afterOne.snapshot.durableSeq, initialReplacement.snapshot.durableSeq + 1);
  assert.deepEqual(
    afterOne.snapshot.content.content.filter(
      (block) => block.attrs.blockId !== changes[0]!.blockId,
    ),
    initialReplacement.snapshot.content.content.filter(
      (block) => block.attrs.blockId !== changes[0]!.blockId,
    ),
  );
  await Promise.all([call("POST", endpoint, acceptOne), call("POST", endpoint, acceptOne)]);
  assert.equal((await context()).snapshot.durableSeq, afterOne.snapshot.durableSeq);
  await call("POST", endpoint, { ...acceptOne, action: "reject" }, 409);
  await call("POST", endpoint, { ...acceptOne, decisionId: randomUUID() }, 409);
  await call("POST", endpoint, acceptOne, 404, readerToken);
  const rejectOne = {
    decisionId: randomUUID(),
    revision: 1,
    action: "reject",
    blockIds: [changes[1]!.blockId],
  };
  await call("POST", endpoint, rejectOne);
  const afterReject = await context();
  assert.equal(afterReject.snapshot.durableSeq, afterOne.snapshot.durableSeq);
  assert.deepEqual(afterReject.snapshot.content, afterOne.snapshot.content);
  const restored = (
    await call("GET", `/api/ai/requests/${replacement.request.requestId}`)
  ).json<AiTaskView>();
  assert.equal(restored.review?.decisions.length, 2);
  assert.equal(restored.review?.decisions[1]?.action, "reject");
  const all = { decisionId: randomUUID(), revision: 2, action: "accept" };
  const finished = (await call("POST", endpoint, all)).json<AiTaskView>();
  assert.equal(finished.application.state, "applied");
  const final = await context();
  assert.equal(final.snapshot.durableSeq, afterOne.snapshot.durableSeq + 1);
  assert.equal(
    final.snapshot.content.content.length,
    3 +
      (changes[1]!.operation.type === "delete-block"
        ? 1
        : changes[1]!.operation.type === "insert-block"
          ? -1
          : 0),
  );
  assert.deepEqual(
    final.snapshot.content.content.find((block) => block.attrs.blockId === changes[1]!.blockId),
    initialReplacement.snapshot.content.content.find(
      (block) => block.attrs.blockId === changes[1]!.blockId,
    ),
  );
  await call("POST", endpoint, all);
  assert.equal((await context()).snapshot.durableSeq, final.snapshot.durableSeq);
  const stale = (
    await call("POST", `/api/ai/requests/${staleReplacement.request.requestId}/review`, {
      decisionId: randomUUID(),
      revision: 0,
      action: "accept",
    })
  ).json<AiTaskView>();
  assert.equal(stale.application.state, "conflict");
  assert.equal((await context()).snapshot.durableSeq, final.snapshot.durableSeq);
  const discard = await authoring();
  discard.request.intent = "rewrite-document";
  discard.request.target = { kind: "document" };
  await call("POST", "/api/ai/authoring", discard);
  const rejection = { decisionId: randomUUID(), revision: 0, action: "reject" };
  const rejected = (
    await call("POST", `/api/ai/requests/${discard.request.requestId}/review`, rejection)
  ).json<AiTaskView>();
  assert.equal(rejected.application.state, "rejected");
  await call("POST", `/api/ai/requests/${discard.request.requestId}/review`, rejection);
  assert.equal((await context()).snapshot.durableSeq, final.snapshot.durableSeq);
  // Simulate an already-accepted task created before migration 0033.
  await app.db
    .update(aiRuns)
    .set({ review: null })
    .where(
      and(
        eq(aiRuns.tenantId, principal.tenantId),
        eq(aiRuns.subjectId, principal.identityId),
        eq(aiRuns.requestId, replacement.request.requestId),
      ),
    );
  const legacy = (
    await call("POST", `/api/ai/requests/${replacement.request.requestId}/accept`)
  ).json<AiTaskView>();
  assert.deepEqual(legacy.application, finished.application);
  const legacyReview = (
    await call("POST", endpoint, { decisionId: randomUUID(), revision: 0, action: "accept" })
  ).json<AiTaskView>();
  assert.deepEqual(legacyReview.application, finished.application);
  assert.equal((await context()).snapshot.durableSeq, final.snapshot.durableSeq);
  console.log(
    "PASS Paragraph review: isolated accept/reject, durable restoration, mixed accept-all, self-sourced continuation, stale/duplicate/unauthorized rejection, lost acknowledgements and reject-all preserve original.",
  );

  const writing = (
    await call("POST", "/api/writing/conversations", { sourceDocumentIds: [] })
  ).json<{ conversation: { id: string }; cursor: string }>();
  const writingPath = `/api/writing/conversations/${writing.conversation.id}`;
  const streamStop = new AbortController();
  const stream = await fetch(
    `${address}${writingPath.replace("/api", "/api")}/events?cursor=${writing.cursor}`,
    { headers: { authorization: `Bearer ${ownerToken}` }, signal: streamStop.signal },
  );
  assert.equal(stream.headers.get("content-type")?.includes("text/event-stream"), true);
  const writingFrames: string[] = [];
  const observe = (async () => {
    try {
      for await (const chunk of stream.body!)
        writingFrames.push(Buffer.from(chunk).toString("utf8"));
    } catch {
      /* Explicit subscription close below. */
    }
  })();
  const writingInput = {
    clientMessageId: randomUUID(),
    idempotencyKey: randomUUID(),
    text: "讨论第一轮写作",
  };
  const firstWritingGate = model.holdNext();
  const firstWriting = (await call("POST", `${writingPath}/messages`, writingInput, 202)).json<{
    runId: string;
  }>();
  await firstWritingGate.started.promise;
  await new Promise((r) => setTimeout(r, 300));
  firstWritingGate.release.resolve();
  assert.equal(
    (await call("POST", `${writingPath}/messages`, writingInput, 202)).json<{ runId: string }>()
      .runId,
    firstWriting.runId,
  );
  await call("POST", `${writingPath}/messages`, { ...writingInput, text: "不同的输入" }, 409);
  await call("GET", writingPath, undefined, 404, readerToken);
  const waitWriting = async (status: string) => {
    for (let i = 0; i < 100; i++) {
      const snapshot = (await call("GET", writingPath)).json<{
        runs: { id: string; status: string }[];
        messages: { role: string; text: string }[];
        cursor: string;
      }>();
      if (snapshot.runs.at(-1)?.status === status) return snapshot;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`Writing did not reach ${status}`);
  };
  await waitWriting("completed");
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(writingFrames.join("").includes("assistant.delta"));
  streamStop.abort();
  await observe;
  const writingGate = model.holdNext();
  const secondWriting = call(
    "POST",
    `${writingPath}/messages`,
    { clientMessageId: randomUUID(), idempotencyKey: randomUUID(), text: "继续第二轮" },
    202,
  );
  await writingGate.started.promise;
  await secondWriting;
  writingGate.release.resolve();
  const twoTurns = await waitWriting("completed");
  assert.equal(twoTurns.messages.filter((m) => m.role === "assistant").length, 2);
  assert.ok(twoTurns.messages.at(-1)?.text.includes("第 2 轮"));
  const reconnect = await fetch(`${address}${writingPath}/events?cursor=${writing.cursor}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const reconnectReader = reconnect.body!.getReader();
  const writingReplay = await reconnectReader.read();
  assert.ok(new TextDecoder().decode(writingReplay.value).length > 0);
  await reconnectReader.cancel();
  const writingCancelGate = model.holdNext();
  const cancelling = (
    await call(
      "POST",
      `${writingPath}/messages`,
      { clientMessageId: randomUUID(), idempotencyKey: randomUUID(), text: "停止这一轮" },
      202,
    )
  ).json<{ runId: string }>();
  await writingCancelGate.started.promise;
  await call("POST", `${writingPath}/runs/${cancelling.runId}/cancel`);
  await waitWriting("cancelled");
  assert.equal((await context()).snapshot.durableSeq, final.snapshot.durableSeq);
  console.log(
    "PASS Writing HTTP/SSE: official multi-turn streaming, idempotency, identity isolation, detached generation, event replay and explicit cancellation preserve document contents.",
  );
  if (imageFixture) {
    const imageConversation = (
      await call("POST", "/api/writing/conversations", { sourceDocumentIds: [] })
    ).json<{ conversation: { id: string } }>();
    const path = `/api/writing/conversations/${imageConversation.conversation.id}`;
    await call(
      "POST",
      `${path}/messages`,
      { clientMessageId: randomUUID(), idempotencyKey: randomUUID(), text: "请生成一张文章配图" },
      202,
    );
    let approvalId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const state = (await call("GET", path)).json<{
        approvals: { id: string; status: string }[];
      }>();
      approvalId = state.approvals.find((a) => a.status === "pending")?.id;
      if (approvalId) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(approvalId);
    assert.equal(imageFixture.calls(), 0);
    const decision = { approvalId, decisionId: randomUUID(), decision: "allow-once" };
    await call("POST", `${path}/approvals`, decision);
    await call("POST", `${path}/approvals`, decision);
    let assetId: string | undefined, jobId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const jobs = (await call("GET", `${path}/images`)).json<
        { id: string; status: string; assets?: { assetId: string }[] }[]
      >();
      const ready = jobs.find((j) => j.status === "ready");
      assetId = ready?.assets?.[0]?.assetId;
      jobId = ready?.id;
      if (assetId) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    if (!assetId) {
      const pendingJobs = (await call("GET", `${path}/images`)).json<
        { id: string; status: string }[]
      >();
      assert.equal(pendingJobs[0]?.status, "pending");
      assert.equal(imageFixture.calls(), 1);
      const storage = new AssetObjectStorage(config);
      try {
        await storage.initialize();
      } finally {
        storage.close();
      }
      const repaired = (await call("POST", `${path}/images/${pendingJobs[0]!.id}/refresh`)).json<{
        id: string;
        status: string;
        assets: { assetId: string }[];
      }>();
      assert.equal(repaired.status, "ready");
      assetId = repaired.assets[0]?.assetId;
      jobId = repaired.id;
    }
    assert.ok(assetId);
    assert.ok(jobId);
    assert.equal(imageFixture.calls(), 1);
    const access = (await call("GET", `${path}/images/${assetId}/access`)).json<{ url: string }>();
    assert.deepEqual(Buffer.from(await (await fetch(access.url)).arrayBuffer()), imageFixture.png);
    await call("GET", `${path}/images/${assetId}/access`, undefined, 404, readerToken);
    await call("POST", `${path}/images/${jobId}/refresh`);
    assert.equal(imageFixture.calls(), 1);
    assert.ok(!(await call("GET", path)).body.includes(imageFixture.png.toString("base64")));
    console.log(
      "PASS Image: official approval before dispatch, one HTTP provider call, storage failure buffers the validated PNG, retry saves to private MinIO without regenerating, refreshed access is authorized; protocol fixture only, no paid call.",
    );
  }
  const worker = async (
    id: string,
    mode: string,
    expectedFailure = false,
  ): Promise<ChatSnapshot> => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/scripts/writing-restart-worker.ts", id, mode],
      {
        cwd: serverRoot,
        env: { ...process.env, DATABASE_URL: testUrl.href },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (mode === "crash" && stdout.includes("READY_FOR_KILL")) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (mode === "crash") {
      assert.ok(stdout.includes("READY_FOR_KILL"));
      return {} as ChatSnapshot;
    }
    if (expectedFailure) {
      assert.notEqual(code, 0);
      assert.ok(stderr.includes("SESSION_UNAVAILABLE"));
      return {} as ChatSnapshot;
    }
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout.trim().split("\n").at(-1)!) as ChatSnapshot;
  };
  const restartId = randomUUID();
  const persistedWriting = await worker(restartId, "create");
  const continued = await worker(restartId, "continue");
  assert.equal(continued.messages.length, 4);
  assert.equal(continued.runs[0]?.id, persistedWriting.runs[0]?.id);
  const interruptedId = randomUUID();
  await worker(interruptedId, "crash");
  const resumed = await worker(interruptedId, "resume");
  assert.equal(resumed.messages.length, 2);
  assert.equal(resumed.runs[0]?.attempt, 2);
  console.log(
    "PASS DSH process restart: PostgreSQL native history reopens in a new Node process; a killed model call repairs to interrupted and resumes the same product Run without duplicating its user message.",
  );
  const storageFaultId = randomUUID();
  assert.match(storageFaultId, /^[a-f0-9-]+$/);
  await pool.query(
    `alter table writing_conversations add constraint writing_test_commit_failure check (id <> '${storageFaultId}' or not(state->'snapshot'->'runs' @> '[{"status":"completed"}]'::jsonb))`,
  );
  await worker(storageFaultId, "create", true);
  const unconfirmed = await pool.query<{ state: { snapshot: ChatSnapshot } }>(
    "select state from writing_conversations where id=$1",
    [storageFaultId],
  );
  assert.notEqual(unconfirmed.rows[0]?.state.snapshot.runs[0]?.status, "completed");
  await pool.query("alter table writing_conversations drop constraint writing_test_commit_failure");
  const repaired = await worker(storageFaultId, "recover");
  assert.equal(repaired.runs.length, 1);
  assert.equal(repaired.runs[0]?.status, "completed");
  assert.equal(repaired.messages.length, 2);
  console.log(
    "PASS PostgreSQL product commit failure: no success is published; after recovery the already durable native turn commits once without model redelivery.",
  );

  if (serve) {
    const canvas = (
      await call(
        "POST",
        "/api/documents",
        { title: "产品方案 · 创作草稿", workspaceId: workspace.id },
        201,
      )
    ).json<{ id: string }>();
    console.log(
      `AI browser acceptance server: http://127.0.0.1:3310 (isolated PostgreSQL; scripted model only). Canvas=${canvas.id}; source=${source.id}; team=${team.id}`,
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} finally {
  await collaboration?.close();
  await app?.close();
  await pool.end();
  await admin.query(`drop database "${databaseName}" with (force)`);
  await admin.end();
  await imageFixture?.close();
}
