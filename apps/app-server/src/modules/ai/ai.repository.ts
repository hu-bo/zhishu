import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { aiRuns } from "../../../database/schema/index.js";
import type { AiRunInput } from "../../../database/schema/ai.table.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { DocumentWriteTransaction, StructureReceipt } from "../collaboration/owner.js";
export type AiRun = typeof aiRuns.$inferSelect;
export const runKey = (principal: Pick<Principal, "tenantId" | "identityId">, requestId: string) =>
  and(
    eq(aiRuns.tenantId, principal.tenantId),
    eq(aiRuns.subjectId, principal.identityId),
    eq(aiRuns.requestId, requestId),
  );
export const runPrincipal = (run: AiRun) => ({ tenantId: run.tenantId, identityId: run.subjectId });
export const threadId = (run: Pick<AiRun, "tenantId" | "subjectId" | "requestId">) =>
  JSON.stringify([run.tenantId, run.subjectId, run.requestId]);
export class AiRepository {
  constructor(readonly db: Database) {}
  async find(principal: Pick<Principal, "tenantId" | "identityId">, id: string) {
    const [run] = await this.db.select().from(aiRuns).where(runKey(principal, id)).limit(1);
    return run ?? null;
  }
  async create(
    principal: Principal,
    inputHash: string,
    input: AiRunInput,
    ownerId: string,
    maxConcurrent: number,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai-admission:${principal.tenantId}`},719001))`,
      );
      const [old] = await tx
        .select()
        .from(aiRuns)
        .where(runKey(principal, input.request.requestId))
        .limit(1);
      if (old) {
        if (old.inputHash !== inputHash)
          throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一任务标识不能用于不同输入");
        return { run: old, fresh: false };
      }
      const [count] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          own: sql<number>`count(*) filter(where subject_id = ${principal.identityId})::int`,
        })
        .from(aiRuns)
        .where(and(eq(aiRuns.tenantId, principal.tenantId), eq(aiRuns.status, "running")));
      if ((count?.count ?? 0) >= maxConcurrent || (count?.own ?? 0) > 0)
        throw new DomainError("RESOURCE_LIMIT", "已有任务正在生成，请先停止或等待完成");
      const [run] = await tx
        .insert(aiRuns)
        .values({
          tenantId: principal.tenantId,
          subjectId: principal.identityId,
          requestId: input.request.requestId,
          documentId: input.request.kind === "authoring" ? input.request.document.documentId : null,
          inputHash,
          input,
          status: "running",
          ownerId,
          usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, searchCalls: 0, sourceReads: 0 },
          applicationState: input.request.kind === "authoring" ? "pending" : "none",
          expiresAt: new Date(Date.now() + 86400000),
        })
        .returning();
      if (!run) throw new Error("AI_RUN_INSERT_FAILED");
      return { run, fresh: true };
    });
  }
  async complete(run: AiRun, result: NonNullable<AiRun["result"]>) {
    const rows = await this.db
      .update(aiRuns)
      .set({
        status: "completed",
        result,
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86400000),
      })
      .where(
        and(
          runKey(runPrincipal(run), run.requestId),
          eq(aiRuns.status, "running"),
          eq(aiRuns.ownerId, run.ownerId!),
          eq(aiRuns.attempt, run.attempt),
          eq(aiRuns.cancelRequested, false),
        ),
      )
      .returning();
    if (!rows.length) throw new DomainError("CONFLICT", "任务已停止");
    return rows[0]!;
  }
  async stop(run: AiRun, status: "interrupted" | "cancelled" | "failed", code: string) {
    await this.db
      .update(aiRuns)
      .set({ status, errorCode: code, updatedAt: new Date() })
      .where(
        and(
          runKey(runPrincipal(run), run.requestId),
          eq(aiRuns.status, "running"),
          eq(aiRuns.attempt, run.attempt),
        ),
      );
  }
  async cancel(principal: Principal, id: string) {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(aiRuns)
        .where(runKey(principal, id))
        .for("update")
        .limit(1);
      if (!run) throw new DomainError("NOT_FOUND", "任务不存在");
      await tx
        .update(aiRuns)
        .set({
          ...(run.status === "running" ? { cancelRequested: true } : {}),
          ...(run.status === "interrupted"
            ? { status: "cancelled" as const, cancelRequested: true }
            : {}),
          updatedAt: new Date(),
        })
        .where(runKey(principal, id));
    });
  }
  async resume(run: AiRun, ownerId: string, maxConcurrent: number) {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai-admission:${run.tenantId}`},719001))`,
      );
      const [count] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          own: sql<number>`count(*) filter(where subject_id = ${run.subjectId})::int`,
        })
        .from(aiRuns)
        .where(and(eq(aiRuns.tenantId, run.tenantId), eq(aiRuns.status, "running")));
      if ((count?.count ?? 0) >= maxConcurrent || (count?.own ?? 0) > 0)
        throw new DomainError("RESOURCE_LIMIT", "已有任务正在生成");
      const [updated] = await tx
        .update(aiRuns)
        .set({
          status: "running",
          ownerId,
          attempt: run.attempt + 1,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            runKey(runPrincipal(run), run.requestId),
            eq(aiRuns.status, "interrupted"),
            eq(aiRuns.attempt, run.attempt),
            eq(aiRuns.cancelRequested, false),
          ),
        )
        .returning();
      if (!updated) throw new DomainError("CONFLICT", "任务不能恢复或已经恢复");
      return updated;
    });
  }
  async reserve(
    run: AiRun,
    kind: "model" | "search" | "read",
    inputTokens: number,
    maxOutputTokens: number,
  ) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(aiRuns)
        .where(runKey(runPrincipal(run), run.requestId))
        .for("update")
        .limit(1);
      if (
        !row ||
        row.status !== "running" ||
        row.ownerId !== run.ownerId ||
        row.attempt !== run.attempt ||
        row.cancelRequested
      )
        throw new DomainError("CONFLICT", "任务已停止");
      const usage = { ...row.usage };
      const limits = row.input.limits;
      if (kind === "model") {
        usage.modelCalls++;
        usage.inputTokens += inputTokens;
        usage.outputTokens += maxOutputTokens;
      }
      if (kind === "search") usage.searchCalls++;
      if (kind === "read") usage.sourceReads++;
      if (
        usage.modelCalls > limits.maxModelCalls ||
        usage.searchCalls > limits.maxSearchCalls ||
        usage.sourceReads > limits.maxSourceReads ||
        usage.inputTokens > limits.maxInputTokens * limits.maxModelCalls ||
        usage.outputTokens > limits.maxOutputTokens * limits.maxModelCalls
      )
        throw new DomainError("RESOURCE_LIMIT", "本轮生成预算已用完");
      await tx
        .update(aiRuns)
        .set({ usage, updatedAt: new Date() })
        .where(runKey(runPrincipal(run), run.requestId));
    });
  }
  async application(run: AiRun, state: "conflict" | "blocked" | "pending", code: string) {
    await this.db
      .update(aiRuns)
      .set({ applicationState: state, applicationCode: code, updatedAt: new Date() })
      .where(and(runKey(runPrincipal(run), run.requestId), sql`${aiRuns.receipt} is null`));
  }
  async guardApply(tx: DocumentWriteTransaction, run: AiRun) {
    const [current] = await tx
      .select()
      .from(aiRuns)
      .where(runKey(runPrincipal(run), run.requestId))
      .for("update")
      .limit(1);
    if (
      !current ||
      current.status !== "completed" ||
      current.inputHash !== run.inputHash ||
      !current.result
    )
      throw new DomainError("CONFLICT", "提案尚未完整生成");
  }
  async guardReview(
    tx: DocumentWriteTransaction,
    run: AiRun,
    revision: number,
    decisionId: string,
    fingerprint: string,
  ) {
    const [current] = await tx
      .select()
      .from(aiRuns)
      .where(runKey(runPrincipal(run), run.requestId))
      .for("update")
      .limit(1);
    if (!current || current.status !== "completed" || current.inputHash !== run.inputHash)
      throw new DomainError("CONFLICT", "建议尚未就绪");
    const previous = current.review?.receipts[decisionId];
    if (previous) {
      if (previous !== fingerprint)
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一确认标识不能用于不同决定");
      return false;
    }
    if ((current.review?.revision ?? 0) !== revision)
      throw new DomainError("CONFLICT", "建议状态已更新，请重新查看");
    return true;
  }
  async recordReview(
    tx: DocumentWriteTransaction,
    run: AiRun,
    review: NonNullable<AiRun["review"]>,
    state: AiRun["applicationState"],
    receipt = run.receipt,
  ) {
    await tx
      .update(aiRuns)
      .set({
        review,
        applicationState: state,
        applicationCode: null,
        receipt,
        updatedAt: new Date(),
      })
      .where(runKey(runPrincipal(run), run.requestId));
  }
  async rejectReview(
    run: AiRun,
    revision: number,
    decisionId: string,
    fingerprint: string,
    review: NonNullable<AiRun["review"]>,
    state: AiRun["applicationState"],
  ) {
    await this.db.transaction(async (tx) => {
      if (await this.guardReview(tx, run, revision, decisionId, fingerprint))
        await this.recordReview(tx, run, review, state);
    });
  }
  async failReview(run: AiRun, revision: number, state: AiRun["applicationState"], code: string) {
    await this.db
      .update(aiRuns)
      .set({ applicationState: state, applicationCode: code, updatedAt: new Date() })
      .where(
        and(
          runKey(runPrincipal(run), run.requestId),
          sql`coalesce((${aiRuns.review}->>'revision')::integer,0) = ${revision}`,
        ),
      );
  }
  async recordReceipt(tx: DocumentWriteTransaction, run: AiRun, receipt: StructureReceipt) {
    await tx
      .update(aiRuns)
      .set({ applicationState: "applied", applicationCode: null, receipt, updatedAt: new Date() })
      .where(runKey(runPrincipal(run), run.requestId));
  }
  async running(): Promise<AiRun[]> {
    return this.db.select().from(aiRuns).where(eq(aiRuns.status, "running")).limit(100);
  }
  async expired(): Promise<AiRun[]> {
    return this.db.select().from(aiRuns).where(lt(aiRuns.expiresAt, new Date())).limit(32);
  }
  async remove(run: AiRun) {
    await this.db.delete(aiRuns).where(runKey(runPrincipal(run), run.requestId));
  }
}
