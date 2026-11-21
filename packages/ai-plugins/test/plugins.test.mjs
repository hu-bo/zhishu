/* global AbortController */
import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Tools from "@deepseek-ai/dsh-tools";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Sessions from "@deepseek-ai/dsh-session";
import { installRag } from "../dist/rag.js";
import { installWriting } from "../dist/writing.js";
import { installScope } from "../dist/scope.js";

const evidence = {
  sources: [
    {
      sourceKind: "document",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      title: "知书规范",
      workspaceId: "ws_1",
      documentId: "doc_1",
      generationId: "gen_1",
      durableSeq: "12",
      metadataRevision: "1",
      indexVersion: "iv_1",
    },
  ],
  items: [
    {
      evidenceId: "ev_1",
      sourceId: "doc_1",
      snapshotId: "snap_1",
      locator: { kind: "block", blockId: "block_a", start: 0, end: 7 },
      text: "第一段原文内容",
    },
  ],
  freshness: "current",
};

const runContext = (overrides = {}) => ({
  contextRevision: 1,
  command: "chat",
  intentHint: "qa",
  plugins: ["scope", "rag", "research", "writing"],
  scope: { kind: "all" },
  webSearch: false,
  ...overrides,
});

async function fixture(install, context) {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Prompt, { includeHarnessIdentity: false });
  await ctx.plugin(Tools, { mode: "native", maxParallelSubCalls: 1 });
  const access = {
    conversationId: "conv_test",
    currentTurn: () =>
      context === undefined
        ? undefined
        : { runId: "run_test", attempt: 1, contextRevision: 1, context },
  };
  install(ctx, access);
  return { ctx, session: ctx.sessions.create() };
}

const exec = (session) => ({
  signal: new AbortController().signal,
  callId: "call_1",
  agent: { id: "agent_1", session },
  concludeTurn: () => undefined,
});

const ragPorts = (saved) => ({
  search: async () => [],
  read: async () => [],
  register: async () => undefined,
  reserve: async () => undefined,
  evidence: () => evidence,
  artifactOf: () => "art_ev_1",
  verify: async () => undefined,
  save: async (answer) => saved.push(answer),
});

test("plugin tools refuse execution when the accepted Run disables them", async () => {
  const saved = [];
  const { ctx, session } = await fixture(
    (c, access) => installRag(c, ragPorts(saved), access),
    runContext({ plugins: ["scope"] }),
  );
  const answer = ctx.tools.get("answer_with_citations");
  await assert.rejects(
    answer.execute(
      { status: "insufficient-evidence", text: "无资料", citations: [] },
      exec(session),
    ),
    /PLUGIN_DISABLED/,
  );
  const search = ctx.tools.get("search_platform");
  await assert.rejects(search.execute({ query: "知书" }, exec(session)), /PLUGIN_DISABLED/);
  assert.equal(saved.length, 0);
});

test("answer tool returns bounded repair feedback instead of fabricating citations", async () => {
  const saved = [];
  const { ctx, session } = await fixture(
    (c, access) => installRag(c, ragPorts(saved), access),
    runContext(),
  );
  const answer = ctx.tools.get("answer_with_citations");
  const fabricated = await answer.execute(
    {
      status: "answered",
      text: "编造的回答",
      citations: [{ evidenceId: "ev_ghost", quote: "不存在" }],
    },
    exec(session),
  );
  assert.equal(fabricated.ok, false);
  assert.ok(fabricated.feedback.includes("evidenceId"));
  assert.equal(saved.length, 0);
  const noCitation = await answer.execute(
    { status: "answered", text: "没有引用", citations: [] },
    exec(session),
  );
  assert.equal(noCitation.ok, false);
  const valid = await answer.execute(
    {
      status: "answered",
      text: "依据资料回答。",
      citations: [{ evidenceId: "ev_1", quote: "第一段原文内容" }],
    },
    exec(session),
  );
  assert.equal(valid.ok, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].citations[0].evidenceArtifactId, "art_ev_1");
});

test("create-draft runs refuse the answer tool but keep platform research tools open", async () => {
  const saved = [];
  const { ctx, session } = await fixture(
    (c, access) => installRag(c, ragPorts(saved), access),
    runContext({ command: "create-draft", intentHint: "writing", draft: { workspaceId: "ws_1" } }),
  );
  const answer = ctx.tools.get("answer_with_citations");
  const refused = await answer.execute(
    { status: "insufficient-evidence", text: "先回答", citations: [] },
    exec(session),
  );
  assert.equal(refused.ok, false);
  assert.ok(refused.feedback.includes("draft_document"));
  assert.equal(saved.length, 0);
  const searched = await ctx.tools.get("search_platform").execute({ query: "知书" }, exec(session));
  assert.equal(typeof searched.text, "string");
});

test("writing tools are gated per accepted Run, not per session installation", async () => {
  const drafts = [];
  const writingOptions = (access) => ({
    access,
    buildInput: () => undefined,
    buildDraftInput: () => ({
      threadId: "conv_test",
      runId: "run_test",
      prompt: { id: "writing", version: "1", systemInstruction: "" },
    }),
    evidence: () => evidence,
    verify: async () => undefined,
    save: async () => undefined,
    saveDraft: async (draft) => drafts.push(draft),
    artifactOf: () => "art_ev_1",
    schemaVersion: 6,
    systemInstruction: "",
  });
  const draftArgs = {
    blocks: [{ type: "paragraph", text: "草稿正文" }],
    summary: "s",
    citations: [],
  };
  // Unbound chat: creating tools exist for the session but refuse this Run.
  const unbound = await fixture(
    (c, access) => installWriting(c, writingOptions(access), access),
    runContext({ intentHint: "writing" }),
  );
  await assert.rejects(
    unbound.ctx.tools.get("draft_document").execute(draftArgs, exec(unbound.session)),
    /UNSUPPORTED_TARGET/,
  );
  await assert.rejects(
    unbound.ctx.tools.get("rewrite_paragraph").execute(draftArgs, exec(unbound.session)),
    /UNSUPPORTED_TARGET/,
  );
  assert.equal(drafts.length, 0);

  // Accepted create-draft Run in the same session shape: only the draft tool may run.
  const draftRun = await fixture(
    (c, access) => installWriting(c, writingOptions(access), access),
    runContext({ command: "create-draft", intentHint: "writing", draft: { workspaceId: "ws_1" } }),
  );
  const ok = await draftRun.ctx.tools
    .get("draft_document")
    .execute(draftArgs, exec(draftRun.session));
  assert.equal(ok.ok, true);
  assert.equal(drafts.length, 1);
  await assert.rejects(
    draftRun.ctx.tools.get("rewrite_paragraph").execute(draftArgs, exec(draftRun.session)),
    /UNSUPPORTED_TARGET/,
  );
});

test("scope tool validates selections through the host port", async () => {
  const updates = [];
  const { ctx, session } = await fixture(
    (c, access) =>
      installScope(
        c,
        {
          current: () => ({ kind: "all" }),
          update: async (selection) => {
            updates.push(selection);
            return { contextRevision: 2 };
          },
        },
        access,
      ),
    runContext(),
  );
  const tool = ctx.tools.get("set_conversation_scope");
  const invalid = await tool.execute({ kind: "workspaces" }, exec(session));
  assert.equal(invalid.ok, false);
  assert.equal(updates.length, 0);
  const valid = await tool.execute({ kind: "workspaces", workspaceIds: ["ws_1"] }, exec(session));
  assert.equal(valid.ok, true);
  assert.equal(valid.contextRevision, 2);
  assert.deepEqual(updates, [{ kind: "workspaces", workspaceIds: ["ws_1"] }]);
});
