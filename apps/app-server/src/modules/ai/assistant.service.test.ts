import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Pool } from "pg";
import type { Database } from "../../../database/index.js";
import * as schema from "../../../database/schema/index.js";
import {
  documents,
  identityProfiles,
  resourceAcl,
  workspaces,
  catalogs,
  aiRuns,
  aiArtifacts,
  aiMessages,
  qaSites,
} from "../../../database/schema/index.js";
import { DEFAULT_RUN_USAGE } from "@zhishu/ai-contracts";
import { AiService } from "./ai.service.js";
import { ConversationEventBus } from "./event-stream.js";
import { AssistantService, type AssistantAudience } from "./assistant.service.js";
import type { AppConfig } from "../../config.js";
import type { Principal } from "../identity/identity.types.js";
import type { CollaborationOwner } from "../collaboration/owner.js";
import { AiImages } from "./images.js";

/**
 * Service-level acceptance on an isolated in-process database: unified admission, plugin
 * subset enforcement, create-draft idempotency/guards and target binding. Native model
 * execution is covered by the package tests and the dedicated-environment ai-smoke runner.
 */

const principal: Principal = {
  userId: "t1",
  identityId: "id1",
  username: "id1",
  displayName: "作者",
  email: "a@example.test",
  globalRoles: [],
  active: true,
};
const internal: AssistantAudience = { kind: "internal", principal };

async function setup(overrides: { owner?: CollaborationOwner } = {}) {
  const pg = new PGlite();
  const journal = JSON.parse(await readFile("database/migrations/meta/_journal.json", "utf8")) as {
    entries: { tag: string }[];
  };
  for (const { tag } of journal.entries)
    await pg.exec(await readFile(`database/migrations/${tag}.sql`, "utf8"));
  const db = drizzle(pg, { schema }) as unknown as Database;
  await db.insert(identityProfiles).values({
    userId: "t1",
    identityId: "id1",
    displayName: "作者",
    email: "a@example.test",
  });
  await db.insert(workspaces).values({
    userId: "t1",
    id: "ws_personal",
    name: "个人空间",
    kind: "personal",
    createdBy: "id1",
    personalOwnerId: "id1",
  });
  await db.insert(catalogs).values({
    userId: "t1",
    id: "cat_personal",
    workspaceId: "ws_personal",
    name: "根目录",
    position: 0,
    createdBy: "id1",
  });
  const store = new AiService(db);
  const bus = new ConversationEventBus();
  const config = {
    AI_MODEL: "scripted",
    AI_API_KEY: "scripted-key",
    AI_MAX_CONCURRENT: 4,
    AI_SESSION_IDLE_MS: 600_000,
    AI_TIMEOUT_MS: 120_000,
    APP_PUBLIC_URL: "http://localhost:5173",
  } as unknown as AppConfig;
  const owner: CollaborationOwner = overrides.owner ?? {
    snapshot: async () => {
      throw new Error("not used");
    },
    apply: async () => {
      throw new Error("not used");
    },
  };
  const assistant = new AssistantService({
    store,
    bus,
    db,
    pool: {} as Pool,
    rag: null,
    owner,
    images: new AiImages({} as Pool, config, null),
    drafts: {
      createDraftInTx: async () => {
        throw new Error("binding not exercised in acceptance test");
      },
    },
    config,
    log: () => {},
  });
  return { pg, db, store, assistant };
}

test("one conversation admits chat runs with server-computed plugins and intent hints", async () => {
  const { pg, store, assistant } = await setup();
  try {
    const conversation = await assistant.createConversation(internal, {});
    const accepted = await assistant.submitMessage(internal, conversation.id, {
      clientMessageId: "cm1",
      idempotencyKey: "ik1",
      text: "知书是什么？",
      expectedContextRevision: conversation.contextRevision,
      intentHint: "qa",
    });
    const run = await store.readRun("t1", accepted.runId);
    assert.equal(run?.context.command, "chat");
    assert.equal(run?.context.intentHint, "qa");
    assert.ok(run?.context.plugins.includes("rag"));
    assert.ok(run?.context.plugins.includes("writing"));
    // The same conversation accepts a writing-intent turn without a new session.
    const writing = await assistant.submitMessage(internal, conversation.id, {
      clientMessageId: "cm2",
      idempotencyKey: "ik2",
      text: "帮我构思一篇文章",
      expectedContextRevision: conversation.contextRevision,
      intentHint: "writing",
    });
    const writingRun = await store.readRun("t1", writing.runId);
    assert.equal(writingRun?.conversationId, conversation.id);
    assert.equal(writingRun?.context.intentHint, "writing");
  } finally {
    await pg.close();
  }
});

test("public audiences are limited to scope/rag and cannot request writing plugins", async () => {
  const { pg, assistant } = await setup();
  try {
    const site: AssistantAudience = {
      kind: "site",
      userId: "t1",
      siteId: "site1",
      visitorId: "v1",
      approved: [],
    };
    assert.deepEqual(assistant.allowedPlugins(site), ["scope", "rag"]);
    assert.deepEqual(assistant.allowedPlugins(internal), ["scope", "rag", "research", "writing"]);
  } finally {
    await pg.close();
  }
});

test("create-draft is idempotent, guarded while in flight, and refuses uneditable spaces", async () => {
  const { pg, store, assistant } = await setup();
  try {
    const conversation = await assistant.createConversation(internal, {});
    const body = {
      idempotencyKey: "draft-1",
      instruction: "基于资料起草",
      workspaceId: "ws_personal",
      expectedContextRevision: conversation.contextRevision,
    };
    const first = await assistant.createDraft(principal, conversation.id, body);
    assert.equal(first.status, "accepted");
    assert.ok(first.runId);
    const run = await store.readRun("t1", first.runId!);
    assert.equal(run?.context.command, "create-draft");
    assert.equal(run?.context.draft?.workspaceId, "ws_personal");
    // Same key replays the same run.
    const replay = await assistant.createDraft(principal, conversation.id, body);
    assert.equal(replay.runId, first.runId);
    assert.equal(replay.replayed, true);
    // A different key cannot create a second draft while one is in flight.
    const racing = await assistant.createDraft(principal, conversation.id, {
      ...body,
      idempotencyKey: "draft-2",
    });
    assert.equal(racing.status, "in-progress");
    assert.equal(racing.runId, first.runId);
    // An uneditable workspace is refused.
    const other = await assistant.createConversation(internal, {});
    await assert.rejects(
      assistant.createDraft(principal, other.id, {
        ...body,
        workspaceId: "ws_missing",
        expectedContextRevision: other.contextRevision,
      }),
      /空间不存在或无权访问|空间不可编辑/,
    );
  } finally {
    await pg.close();
  }
});

test("create-draft returns the bound target instead of creating a second document", async () => {
  const { pg, db, assistant } = await setup();
  try {
    const conversation = await assistant.createConversation(internal, {});
    await db.insert(documents).values({
      id: "doc_bound",
      userId: "t1",
      title: "已绑定文档",
      createdBy: "id1",
      accessMode: "personal",
      workspaceId: "ws_personal",
      catalogId: "cat_personal",
    });
    await db.insert(resourceAcl).values({
      userId: "t1",
      documentId: "doc_bound",
      identityId: "id1",
      role: "admin",
      createdBy: "id1",
    });
    await assistant.bindTarget(principal, conversation.id, {
      targetDocumentId: "doc_bound",
      expectedContextRevision: conversation.contextRevision,
    });
    const result = await assistant.createDraft(principal, conversation.id, {
      idempotencyKey: "draft-x",
      instruction: "再写",
      workspaceId: "ws_personal",
      expectedContextRevision: conversation.contextRevision + 1,
    });
    assert.equal(result.status, "already-bound");
    assert.equal(result.documentId, "doc_bound");
    assert.equal(result.runId, null);
  } finally {
    await pg.close();
  }
});

test("binding an existing target bumps the context revision and isolates stale submissions", async () => {
  const { pg, db, assistant } = await setup();
  try {
    const conversation = await assistant.createConversation(internal, {});
    await db.insert(documents).values({
      id: "doc_target",
      userId: "t1",
      title: "目标文档",
      createdBy: "id1",
      accessMode: "personal",
      workspaceId: "ws_personal",
      catalogId: "cat_personal",
    });
    await db.insert(resourceAcl).values({
      userId: "t1",
      documentId: "doc_target",
      identityId: "id1",
      role: "admin",
      createdBy: "id1",
    });
    const bound = await assistant.bindTarget(principal, conversation.id, {
      targetDocumentId: "doc_target",
      expectedContextRevision: conversation.contextRevision,
    });
    assert.equal(bound.contextRevision, conversation.contextRevision + 1);
    assert.equal(bound.targetDocumentId, "doc_target");
    // A stale revision is refused at admission (target-free conversation avoids snapshot capture).
    const plain = await assistant.createConversation(internal, {});
    await assistant.submitMessage(internal, plain.id, {
      clientMessageId: "cm-ok",
      idempotencyKey: "ik-ok",
      text: "正常提交",
      expectedContextRevision: plain.contextRevision,
    });
    await assistant.setScope(internal, plain.id, plain.contextRevision, {
      kind: "documents",
      documentIds: ["doc_target"],
    });
    await assert.rejects(
      assistant.submitMessage(internal, plain.id, {
        clientMessageId: "cm-stale",
        idempotencyKey: "ik-stale",
        text: "旧修订",
        expectedContextRevision: plain.contextRevision,
      }),
      /上下文已更新/,
    );
  } finally {
    await pg.close();
  }
});

test("public projection drops answers whose evidence ledger is no longer approved", async () => {
  const { pg, db, assistant } = await setup();
  try {
    await db.insert(qaSites).values({
      userId: "t1",
      id: "site1",
      ownerWorkspaceId: "ws_personal",
      slug: "rev-site",
      name: "撤权站点",
      status: "active",
      createdBy: "id1",
    });
    const site = (approved: { documentId: string; workspaceId: string; publicLabel: string }[]) =>
      ({
        kind: "site",
        userId: "t1",
        siteId: "site1",
        visitorId: "v1",
        approved,
      }) as AssistantAudience;
    const conversation = await assistant.createConversation(site([]), {});
    const bundle = {
      freshness: "current" as const,
      sources: [
        {
          sourceKind: "document" as const,
          sourceId: "doc_revoked",
          snapshotId: "snap",
          title: "T",
          workspaceId: "ws_personal",
          documentId: "doc_revoked",
          generationId: "gen",
          durableSeq: "1",
          metadataRevision: "1",
          indexVersion: "iv",
        },
      ],
      items: [
        {
          evidenceId: "ev_rev",
          sourceId: "doc_revoked",
          snapshotId: "snap",
          locator: { kind: "block" as const, blockId: "b", start: 0, end: 2 },
          text: "中文",
        },
      ],
    };
    await db.insert(aiRuns).values({
      id: "run_rev",
      userId: "t1",
      conversationId: conversation.id,
      idempotencyKey: "ik",
      inputHash: `sha256:${"a".repeat(64)}`,
      context: {
        contextRevision: 1,
        command: "chat",
        intentHint: "qa",
        plugins: ["scope", "rag"],
        scope: { kind: "all" },
        webSearch: false,
      },
      status: "completed",
      attempt: 1,
      usage: { ...DEFAULT_RUN_USAGE },
      execution: {
        evidenceRefs: [{ evidenceArtifactId: "art_rev", evidenceId: "ev_rev" }],
        evidenceArtifactIds: ["art_rev"],
        proposalArtifactIds: [],
        steps: [],
      },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.insert(aiArtifacts).values({
      id: "art_rev",
      userId: "t1",
      conversationId: conversation.id,
      runId: "run_rev",
      producerCallId: "step:retrieve:1",
      resultIndex: 0,
      kind: "evidence",
      schemaVersion: 1,
      state: "committed",
      payload: bundle,
      evidenceRefs: [{ evidenceArtifactId: "art_rev", evidenceId: "ev_rev" }],
    });
    await db.insert(aiMessages).values({
      id: "msg_rev",
      userId: "t1",
      conversationId: conversation.id,
      runId: "run_rev",
      role: "assistant",
      parts: [
        { kind: "text", text: "答案" },
        {
          kind: "citation",
          citation: {
            citationId: "c1",
            evidenceArtifactId: "art_rev",
            evidenceId: "ev_rev",
            locator: { kind: "block", blockId: "b", start: 0, end: 2 },
            quote: "中文",
          },
        },
      ],
      state: "committed",
      committedAt: new Date(),
    });

    // Revoked: the source is no longer approved, so the old answer must disappear even though
    // its displayed citation still resolves. The Run evidence ledger is the authority.
    const revoked = await assistant.snapshot(site([]), conversation.id);
    assert.ok(!revoked.messages.some((m) => m.role === "assistant"));
    // Re-approved: the answer is visible again.
    const approved = await assistant.snapshot(
      site([{ documentId: "doc_revoked", workspaceId: "ws_personal", publicLabel: "L" }]),
      conversation.id,
    );
    assert.ok(approved.messages.some((m) => m.role === "assistant"));
  } finally {
    await pg.close();
  }
});

test("proposal review is incremental: per-block decisions keep the proposal open until every change is decided", async () => {
  const appliedOperations: string[][] = [];
  let durableSeq = 1;
  const dbRef: { current?: Database } = {};
  const proposalPayload = {
    document: { documentId: "doc_review", generationId: "gen_r1", structureRevision: 1 },
    summary: "改写两处段落",
    target: { kind: "document" },
    operationBatch: {
      operationId: "ob-review",
      documentId: "doc_review",
      generationId: "gen_r1",
      preconditions: [],
      operations: [
        {
          type: "replace-block",
          targetBlockId: "b1",
          block: {
            type: "paragraph",
            attrs: { blockId: "b1" },
            content: [{ type: "text", text: "新内容一" }],
          },
        },
        {
          type: "replace-block",
          targetBlockId: "b2",
          block: {
            type: "paragraph",
            attrs: { blockId: "b2" },
            content: [{ type: "text", text: "新内容二" }],
          },
        },
      ],
    },
    citations: [],
  };
  const owner: CollaborationOwner = {
    snapshot: async () => ({
      snapshot: {
        documentId: "doc_review",
        schemaVersion: 1,
        extensions: [],
        snapshotRevision: 1,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              attrs: { blockId: "b1" },
              content: [{ type: "text", text: "原文一" }],
            },
            {
              type: "paragraph",
              attrs: { blockId: "b2" },
              content: [{ type: "text", text: "原文二" }],
            },
          ],
        },
        generationId: "gen_r1",
        durableSeq: 1,
      },
      structureRevision: 1,
      workspaceId: "ws_personal",
      title: "审阅目标",
    }),
    apply: async (input) => {
      const receipt = {
        operationId: input.batch.operationId,
        generationId: input.batch.generationId,
        durableSeq: ++durableSeq,
        structureRevision: 2,
      };
      await dbRef.current!.transaction(async (tx) => {
        await input.guard(tx);
        await input.record(tx, receipt);
      });
      appliedOperations.push(
        input.batch.operations.map((operation) =>
          operation.type === "insert-block"
            ? String(operation.block.attrs.blockId)
            : String(operation.targetBlockId),
        ),
      );
      return receipt;
    },
  };
  const { pg, db, assistant } = await setup({ owner });
  dbRef.current = db;
  try {
    const conversation = await assistant.createConversation(internal, {});
    await db.insert(documents).values({
      id: "doc_review",
      userId: "t1",
      title: "审阅目标",
      createdBy: "id1",
      accessMode: "personal",
      workspaceId: "ws_personal",
      catalogId: "cat_personal",
    });
    await db.insert(resourceAcl).values({
      userId: "t1",
      documentId: "doc_review",
      identityId: "id1",
      role: "admin",
      createdBy: "id1",
    });
    await db.insert(aiRuns).values({
      id: "run_review",
      userId: "t1",
      conversationId: conversation.id,
      idempotencyKey: "ik-review",
      inputHash: `sha256:${"b".repeat(64)}`,
      context: {
        contextRevision: 1,
        command: "chat",
        intentHint: "writing",
        plugins: ["scope", "rag", "writing"],
        scope: { kind: "all" },
        webSearch: false,
      },
      status: "completed",
      attempt: 1,
      usage: { ...DEFAULT_RUN_USAGE },
      execution: {
        evidenceRefs: [],
        evidenceArtifactIds: [],
        proposalArtifactIds: ["art_review", "art_all"],
        steps: [],
      },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    for (const id of ["art_review", "art_all"])
      await db.insert(aiArtifacts).values({
        id,
        userId: "t1",
        conversationId: conversation.id,
        runId: "run_review",
        producerCallId: `tool:${id}`,
        resultIndex: 0,
        kind: "proposal",
        schemaVersion: 1,
        state: "committed",
        applicationState: "pending",
        payload: proposalPayload,
        evidenceRefs: [],
      });

    // Accepting one of two changes applies only that operation and keeps the proposal open.
    const first = await assistant.reviewProposal(principal, "art_review", {
      decisionId: "d1",
      revision: 0,
      action: "accept",
      blockIds: ["b1"],
    });
    assert.equal(first.applicationState, "pending");
    assert.deepEqual(appliedOperations, [["b1"]]);

    // While the proposal is open, a decided block cannot be decided again.
    await assert.rejects(
      assistant.reviewProposal(principal, "art_review", {
        decisionId: "d3",
        revision: 1,
        action: "accept",
        blockIds: ["b1"],
      }),
      /均已有决定/,
    );

    // Rejecting the remaining change closes the proposal as partial.
    const second = await assistant.reviewProposal(principal, "art_review", {
      decisionId: "d2",
      revision: 1,
      action: "reject",
      blockIds: ["b2"],
    });
    assert.equal(second.applicationState, "partial");
    assert.equal(appliedOperations.length, 1);

    // Fully decided: further decisions replay the terminal state instead of re-applying.
    const replay = await assistant.reviewProposal(principal, "art_review", {
      decisionId: "d5",
      revision: 2,
      action: "accept",
      blockIds: ["b1"],
    });
    assert.equal(replay.applicationState, "partial");
    assert.equal(appliedOperations.length, 1);

    // A fresh proposal accepts everything in one decision and lands as applied.
    const all = await assistant.reviewProposal(principal, "art_all", {
      decisionId: "d4",
      revision: 0,
      action: "accept",
    });
    assert.equal(all.applicationState, "applied");
    assert.deepEqual(appliedOperations, [["b1"], ["b1", "b2"]]);
  } finally {
    await pg.close();
  }
});
