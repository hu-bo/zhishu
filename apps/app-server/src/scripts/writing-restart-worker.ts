import assert from "node:assert/strict";
import { Pool } from "pg";
import { LlmAdapter, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { createDshRuntime } from "@zhishu/dsh-agent";
import { WritingRepository } from "../modules/writing-chat/writing.repository.js";
import { postgresSessionPersistence } from "../modules/writing-chat/writing.persistence.js";
const url = new URL(process.env.DATABASE_URL!);
assert.match(url.pathname, /^\/zhishu_ai_test_[a-z0-9_]+$/);
const [id, mode] = process.argv.slice(2);
assert.ok(id);
assert.ok(mode);
const pool = new Pool({ connectionString: url.href, max: 6 });
class Model extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (mode === "crash") {
      process.stdout.write("READY_FOR_KILL\n");
      await new Promise<void>((_resolve, reject) =>
        options.signal?.addEventListener("abort", () => reject(new Error("ABORTED")), {
          once: true,
        }),
      );
    }
    const count = options.messages.filter(
      (m) => m.role === "user" && m.source?.kind === "user",
    ).length;
    const text = `worker-turn:${count}`;
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
await pool.query(
  "insert into writing_conversations(id,tenant_id,subject_id,source_document_ids,source_context) values($1,'worker-tenant','worker-subject','[]','{\"sourceVersions\":[]}'::jsonb) on conflict do nothing",
  [id],
);
const store = new WritingRepository(pool);
const runtime = await createDshRuntime({
  store,
  persistence: "required",
  configure: async (ctx) => {
    await ctx.plugin(postgresSessionPersistence(pool));
    ctx.llm.registerAdapter(["test"], new Model());
  },
  agentOptions: { provider: "test", model: "test" },
});
try {
  const session =
    mode === "create" || mode === "crash"
      ? await runtime.createSession(id)
      : await runtime.restoreSession(id);
  let snapshot = await session.snapshot();
  if (mode === "resume") {
    assert.equal(snapshot.runs[0]?.status, "interrupted");
    await session.resume(snapshot.runs[0]!.id);
  } else if (mode !== "recover")
    await session.submit({
      clientMessageId: `message-${mode}`,
      idempotencyKey: `key-${mode}`,
      text: mode,
    });
  for (let i = 0; i < 1000; i++) {
    snapshot = await session.snapshot();
    if (snapshot.runs.at(-1)?.status === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(snapshot.runs.at(-1)?.status, "completed");
  process.stdout.write(`${JSON.stringify(snapshot)}\n`);
} finally {
  await runtime.dispose();
  await pool.end();
}
