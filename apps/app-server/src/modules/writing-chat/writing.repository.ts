import type { Pool } from "pg";
import type { ChatStore, ChatRecord, ChatLease } from "@zhishu/dsh-agent";
import type { Principal } from "../identity/identity.types.js";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../shared/domain-error.js";

export class WritingRepository implements ChatStore {
  constructor(private pool: Pool) {}
  async create(
    principal: Principal,
    id: string,
    sources: string[],
    sourceContext: { sourceVersions: unknown[] },
  ) {
    await this.pool.query(
      "insert into writing_conversations(id,tenant_id,subject_id,source_document_ids,source_context) values($1,$2,$3,$4,$5)",
      [
        id,
        principal.tenantId,
        principal.identityId,
        JSON.stringify(sources),
        JSON.stringify({ sourceVersions: sourceContext.sourceVersions }),
      ],
    );
  }
  async ensure(
    principal: Principal,
    id: string,
    sources: string[],
    sourceContext: { sourceVersions: unknown[] },
  ) {
    await this.pool.query(
      "insert into writing_conversations(id,tenant_id,subject_id,source_document_ids,source_context) values($1,$2,$3,$4,$5) on conflict do nothing",
      [
        id,
        principal.tenantId,
        principal.identityId,
        JSON.stringify(sources),
        JSON.stringify({ sourceVersions: sourceContext.sourceVersions }),
      ],
    );
    await this.get(principal, id);
  }
  async get(principal: Principal, id: string) {
    const result = await this.pool.query<{
      state: ChatRecord | null;
      source_document_ids: string[];
      source_context: {
        sourceVersions: { documentId: string; generationId: string; durableSeq: number }[];
      };
    }>(
      "select state,source_document_ids,source_context from writing_conversations where id=$1 and tenant_id=$2 and subject_id=$3",
      [id, principal.tenantId, principal.identityId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("NOT_FOUND", "对话不存在或无权访问");
    return row;
  }
  async events(id: string, cursor: string) {
    const result = await this.pool.query<{ event: import("@zhishu/chat-contracts").ChatEvent }>(
      "select event from writing_events where conversation_id=$1 and sequence>$2 order by sequence limit 128",
      [id, cursor],
    );
    return result.rows.map((r) => r.event);
  }
  async admit<T>(principal: Principal, max: number, action: () => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      // The global transaction lock serializes admission, never execution or streaming.
      await client.query("select pg_advisory_xact_lock(719103)");
      const result = await client.query<{ total: string; subject: string }>(
        "select count(*) as total,count(*) filter(where tenant_id=$1 and subject_id=$2) as subject from writing_conversations c where exists(select 1 from jsonb_array_elements(c.state->'snapshot'->'runs') r where r->>'status' in ('queued','running','waiting-approval'))",
        [principal.tenantId, principal.identityId],
      );
      if (Number(result.rows[0]?.total) >= max || Number(result.rows[0]?.subject) >= 2)
        throw new DomainError("RESOURCE_LIMIT", "已有写作任务正在执行，请等待后再试");
      const value = await action();
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  async recoverOrphans() {
    const rows = await this.pool.query<{ id: string }>(
      "select id from writing_conversations c where exists(select 1 from jsonb_array_elements(c.state->'snapshot'->'runs') r where r->>'status' in ('queued','running','waiting-approval')) limit 128",
    );
    for (const row of rows.rows) {
      let lease: ChatLease;
      try {
        lease = await this.acquire(row.id);
      } catch (error) {
        if (error instanceof DomainError && error.code === "CONFLICT") continue;
        throw error;
      }
      try {
        const record = await lease.load();
        if (!record) continue;
        for (const run of record.snapshot.runs)
          if (["queued", "running", "waiting-approval"].includes(run.status)) {
            run.status = "interrupted";
            run.errorCode = "OWNER_EXITED";
          }
        for (const approval of record.snapshot.approvals)
          if (approval.status === "pending") approval.status = "expired";
        record.snapshot.cursor = String(BigInt(record.snapshot.cursor) + 1n);
        await lease.commit(record, {
          type: "snapshot",
          eventId: randomUUID(),
          conversationId: row.id,
          sequence: record.snapshot.cursor,
          snapshot: record.snapshot,
        });
      } finally {
        await lease.close();
      }
    }
  }
  async acquire(id: string): Promise<ChatLease> {
    const client = await this.pool.connect();
    let closed = false,
      lost = false;
    const loss = () => {
      lost = true;
    };
    client.on("error", loss);
    client.on("end", loss);
    try {
      const locked = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1,719102)) as locked",
        [id],
      );
      if (!locked.rows[0]?.locked)
        throw new DomainError("CONFLICT", "对话正由另一实例执行，请重连原实例");
    } catch (error) {
      client.removeListener("error", loss);
      client.removeListener("end", loss);
      client.release();
      throw error;
    }
    const check = () => {
      if (closed || lost) throw new Error("WRITER_LOST");
    };
    return {
      async load() {
        check();
        const result = await client.query<{ state: ChatRecord | null }>(
          "select state from writing_conversations where id=$1",
          [id],
        );
        return result.rows[0]?.state ?? undefined;
      },
      async commit(record, event) {
        check();
        await client.query("begin");
        try {
          await client.query("set local synchronous_commit = on");
          const result = await client.query(
            "update writing_conversations set state=$2,updated_at=now() where id=$1 and coalesce(state->'snapshot'->>'cursor','0')=$3",
            [id, JSON.stringify(record), String(BigInt(event.sequence) - 1n)],
          );
          if (result.rowCount !== 1) throw new Error("STALE_WRITER");
          await client.query(
            "insert into writing_events(conversation_id,sequence,event) values($1,$2,$3)",
            [id, event.sequence, JSON.stringify(event)],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => {
            lost = true;
          });
          throw error;
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          if (!lost)
            await client.query("select pg_advisory_unlock(hashtextextended($1,719102))", [id]);
        } finally {
          client.removeListener("error", loss);
          client.removeListener("end", loss);
          client.release(lost);
        }
      },
    };
  }
}
