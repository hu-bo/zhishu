import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * Forward-only migration acceptance on an isolated in-process database: the empty-database
 * full chain and the 0045-data upgrade. No business database is touched.
 */

const journal = async () =>
  JSON.parse(await readFile("database/migrations/meta/_journal.json", "utf8")) as {
    entries: { tag: string }[];
  };

async function applyThrough(pg: PGlite, lastTagPrefix: string) {
  for (const { tag } of (await journal()).entries) {
    await pg.exec(await readFile(`database/migrations/${tag}.sql`, "utf8"));
    if (tag.startsWith(lastTagPrefix)) return;
  }
  throw new Error(`migration ${lastTagPrefix} not found`);
}

const seed0045 = async (pg: PGlite) => {
  await pg.exec(`
    insert into identity_profiles (tenant_id, identity_id, display_name, email)
      values ('t1','id1','作者','a@example.test');
    insert into workspaces (tenant_id, id, name, kind, created_by, personal_owner_id)
      values ('t1','ws1','个人空间','personal','id1','id1');
    insert into catalogs (tenant_id, id, workspace_id, name, position, created_by)
      values ('t1','cat1','ws1','根目录',0,'id1');
    insert into documents (tenant_id, id, workspace_id, catalog_id, title, created_by, access_mode)
      values ('t1','doc1','ws1','cat1','目标文档','id1','personal');
    insert into qa_sites (tenant_id, id, owner_workspace_id, slug, name, status, created_by)
      values ('t1','site1','ws1','public-site','公开站','active','id1');
    insert into ai_conversations
      (tenant_id, id, purpose, identity_id, scope_selection, context_revision, configuration_id, creation_key, origin)
      values
      ('t1','ai_qa1','qa','id1','{"kind":"all"}',1,'qa-model','ck1',null),
      ('t1','ai_wr1','writing','id1','{"kind":"all"}',2,'writing-v2','ck2',
        '{"kind":"qa-handoff","sourceConversationId":"ai_qa1","sourceMessageIds":["msg_x"],"sourceArtifactIds":["art_x"]}');
    insert into ai_conversations
      (tenant_id, id, purpose, visitor_id, site_id, scope_selection, context_revision, expires_at)
      values ('t1','ai_pub1','qa','visitor1','site1','{"kind":"all"}',1, now() + interval '12 hours');
    insert into ai_runs
      (tenant_id, id, conversation_id, purpose, idempotency_key, input_hash, context, status, attempt, usage, execution, expires_at)
      values
      ('t1','run_qa_done','ai_qa1','qa','ik1','sha256:${"a".repeat(64)}',
        '{"contextRevision":1,"scope":{"kind":"all"},"retrieval":{"contextTokenBudget":12000,"maxEvidenceItems":32,"maxRepairRounds":1}}',
        'completed',1,'{"modelCalls":1,"inputTokens":10,"outputTokens":20,"searchCalls":1,"sourceReads":1,"webSearchCalls":0,"webReadCalls":0,"unknownCalls":0}',
        '{"evidenceRefs":[{"evidenceArtifactId":"art_e1","evidenceId":"ev1"}],"steps":[],"evidenceArtifactIds":["art_e1"],"repairRounds":1}',
        now() + interval '7 days'),
      ('t1','run_qa_open','ai_qa1','qa','ik2','sha256:${"b".repeat(64)}',
        '{"contextRevision":1,"scope":{"kind":"all"},"retrieval":{"contextTokenBudget":12000,"maxEvidenceItems":32,"maxRepairRounds":1}}',
        'running',1,'{"modelCalls":0,"inputTokens":0,"outputTokens":0,"searchCalls":0,"sourceReads":0,"webSearchCalls":0,"webReadCalls":0,"unknownCalls":0}',
        null, now() + interval '30 minutes'),
      ('t1','run_wr_done','ai_wr1','writing','ik3','sha256:${"c".repeat(64)}',
        '{"contextRevision":2,"webSearch":false,"capture":{"document":{"documentId":"doc1","generationId":"gen1","durableSeq":1,"contentHash":"sha256:${"d".repeat(64)}"},"structureRevision":1}}',
        'completed',1,'{"modelCalls":1,"inputTokens":5,"outputTokens":6,"searchCalls":0,"sourceReads":0,"webSearchCalls":0,"webReadCalls":0,"unknownCalls":0}',
        '{"nativeMessageId":"nm1","deliveryConfirmed":true,"turn":1,"evidenceRefs":[],"evidenceArtifactIds":[],"proposalArtifactIds":["art_p1"],"steps":[]}',
        now() + interval '7 days');
    insert into ai_messages (tenant_id, id, conversation_id, run_id, role, parts, state, committed_at)
      values ('t1','msg1','ai_qa1','run_qa_done','user','[{"kind":"text","text":"什么是知书？"}]','committed',now());
    insert into ai_artifacts
      (tenant_id, id, conversation_id, run_id, purpose, producer_call_id, result_index, kind, schema_version, state, payload, application_state)
      values
      ('t1','art_e1','ai_qa1','run_qa_done','qa','step:retrieve:1',0,'evidence',1,'committed','{"sources":[],"items":[],"freshness":"current"}',null),
      ('t1','art_p1','ai_wr1','run_wr_done','writing','tool:call1',0,'proposal',1,'committed','{"summary":"历史提案"}','applied');
    insert into writing_sessions
      (id, tenant_id, conversation_id, purpose, context_revision, header, inherited_event_count, events, next_seq)
      values ('ws_ai_wr1_2','t1','ai_wr1','writing',2,'{"version":4}',0,'[]',0);
    insert into writing_image_jobs
      (id, tenant_id, conversation_id, run_id, purpose, tool_call_id, status, asset_id)
      values ('run_wr_done:call9','t1','ai_wr1','run_wr_done','writing','call9','ready','image_x');
  `);
};

test("empty database applies the full chain and ends with 37 unified business tables", async () => {
  const pg = new PGlite();
  try {
    await applyThrough(pg, "0046");
    const tables = await pg.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema='public' and table_type='BASE TABLE'
       and table_name not in ('__drizzle_migrations','legacy_ai_conversation_origins')
       order by table_name`,
    );
    assert.equal(tables.rows.length, 37);
    assert.ok(tables.rows.some((r) => r.table_name === "ai_sessions"));
    assert.ok(tables.rows.some((r) => r.table_name === "ai_image_jobs"));
    assert.ok(!tables.rows.some((r) => r.table_name.startsWith("writing_")));
    const purposeColumns = await pg.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns
       where table_schema='public' and column_name='purpose'
       and table_name in ('ai_conversations','ai_runs','ai_artifacts','ai_sessions','ai_image_jobs')`,
    );
    assert.equal(purposeColumns.rows[0]!.count, "0");
  } finally {
    await pg.close();
  }
});

test("0045 data upgrade keeps history, interrupts unfinished runs and rebuilds constraints", async () => {
  const pg = new PGlite();
  try {
    await applyThrough(pg, "0045");
    await seed0045(pg);
    await pg.exec(await readFile("database/migrations/0046_unified_assistant.sql", "utf8"));

    // Completed history keeps its original conversationId and bodies.
    const messages = await pg.query<{ id: string }>(
      `select id from ai_messages where tenant_id='t1' order by id`,
    );
    assert.deepEqual(
      messages.rows.map((r) => r.id),
      ["msg1"],
    );
    const artifacts = await pg.query<{ id: string; kind: string }>(
      `select id, kind from ai_artifacts where tenant_id='t1' order by id`,
    );
    assert.deepEqual(
      artifacts.rows.map((r) => [r.id, r.kind]),
      [
        ["art_e1", "evidence"],
        ["art_p1", "proposal"],
      ],
    );

    // Unfinished legacy work is explicitly interrupted; completed runs stay completed.
    const runs = await pg.query<{ id: string; status: string; error_code: string | null }>(
      `select id, status, error_code from ai_runs where tenant_id='t1' order by id`,
    );
    assert.deepEqual(
      runs.rows.map((r) => [r.id, r.status, r.error_code]),
      [
        ["run_qa_done", "completed", null],
        ["run_qa_open", "interrupted", "LEGACY_INTERRUPTED"],
        ["run_wr_done", "completed", null],
      ],
    );

    // Contexts are normalized to the unified acceptance shape without losing capture/scope.
    const contexts = await pg.query<{ id: string; context: Record<string, unknown> }>(
      `select id, context from ai_runs where tenant_id='t1' order by id`,
    );
    const qaContext = contexts.rows.find((r) => r.id === "run_qa_done")!.context;
    assert.equal(qaContext.command, "chat");
    assert.equal(qaContext.intentHint, "qa");
    assert.deepEqual(qaContext.plugins, ["scope", "rag"]);
    assert.equal(Object.hasOwn(qaContext, "retrieval"), false);
    const writingContext = contexts.rows.find((r) => r.id === "run_wr_done")!.context;
    assert.equal(writingContext.intentHint, "writing");
    assert.deepEqual(
      (writingContext.capture as { document: { documentId: string } }).document.documentId,
      "doc1",
    );
    const execution = await pg.query<{ execution: Record<string, unknown> }>(
      `select execution from ai_runs where id='run_qa_done'`,
    );
    assert.equal(Object.hasOwn(execution.rows[0]!.execution, "repairRounds"), false);

    // Native sessions and image jobs survive the rename with their rows.
    const sessions = await pg.query<{ id: string; conversation_id: string }>(
      `select id, conversation_id from ai_sessions`,
    );
    assert.deepEqual(sessions.rows, [{ id: "ws_ai_wr1_2", conversation_id: "ai_wr1" }]);
    const jobs = await pg.query<{ id: string; status: string; asset_id: string }>(
      `select id, status, asset_id from ai_image_jobs`,
    );
    assert.deepEqual(jobs.rows, [
      { id: "run_wr_done:call9", status: "ready", asset_id: "image_x" },
    ]);

    // Handoff origins are exported to the migration audit, not parsed by the runtime.
    const audit = await pg.query<{ conversation_id: string; origin: { kind: string } }>(
      `select conversation_id, origin from legacy_ai_conversation_origins`,
    );
    assert.deepEqual(
      audit.rows.map((r) => [r.conversation_id, r.origin.kind]),
      [["ai_wr1", "qa-handoff"]],
    );

    // Rebuilt composite foreign keys still reject cross-tenant binding.
    await assert.rejects(
      pg.exec(
        `insert into ai_runs (tenant_id, id, conversation_id, idempotency_key, input_hash, context, status, attempt, usage, expires_at)
         values ('t2','run_bad','ai_qa1','ik','sha256:${"e".repeat(64)}','{"contextRevision":1,"command":"chat","intentHint":"qa","plugins":["rag"],"scope":{"kind":"all"},"webSearch":false}','queued',1,'{"modelCalls":0,"inputTokens":0,"outputTokens":0,"searchCalls":0,"sourceReads":0,"webSearchCalls":0,"webReadCalls":0,"unknownCalls":0}', now() + interval '30 minutes')`,
      ),
      /foreign key/i,
    );
    // Public site conversations can never carry an editor target.
    await assert.rejects(
      pg.exec(`update ai_conversations set target_document_id='doc1' where id='ai_pub1'`),
      /ai_conversations_site_target_check/i,
    );
    // Creation dedup still works without purpose: same owner+key replays, different key inserts.
    await assert.rejects(
      pg.exec(
        `insert into ai_conversations (tenant_id, id, identity_id, scope_selection, creation_key)
         values ('t1','ai_dup','id1','{"kind":"all"}','ck1')`,
      ),
      /ai_conversations_identity_creation_uq/i,
    );
    // The outbox accepts the new binding event type.
    await pg.exec(
      `insert into ai_events (tenant_id, conversation_id, sequence, type, entity_id, payload)
       values ('t1','ai_wr1',1,'conversation.updated','ai_wr1','{"contextRevision":3,"status":"active","targetDocumentId":"doc1"}')`,
    );
  } finally {
    await pg.close();
  }
});
