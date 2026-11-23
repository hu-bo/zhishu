import { sql } from "drizzle-orm";
import type { Database } from "../../database/index.js";
type Executor = Pick<Database, "execute">;
/** Serialize directory/authorization mutations and attach their audit actor in the same transaction. */
export async function lockKnowledgeTree(tx: Executor, tenantId: string, actorId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-tree:${tenantId}`}, 718268)), set_config('zhishu.actor_id', ${actorId}, true)`,
  );
}
/** Content updates share the tree snapshot while permission changes take the exclusive lock. */
export async function readKnowledgeTree(tx: Executor, tenantId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`knowledge-tree:${tenantId}`}, 718268))`,
  );
}
