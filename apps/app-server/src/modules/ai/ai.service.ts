import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  createAuthoringRuntime,
  createChatRuntime,
  DEFAULT_GENERATION_LIMITS,
  hashContent,
  AiRuntimeError,
} from "@zhishu/ai-runtime";
import {
  canonicalJson,
  createAiEventValidator,
  validateAiTaskRequestV2,
  validateAuthoringProposal,
  validateChatResult,
  isReplacementIntent,
  replacementChanges,
  replacementBatch,
  type AiTaskEvent,
  type AiTaskEventV2,
  type AuthoringProposal,
  type ChatRequest,
  type AuthoringRequest,
} from "@zhishu/ai-contracts";
import type { AiRunInput } from "../../../database/schema/ai.table.js";
import type { AppConfig } from "../../config.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import { AiDocumentAccess } from "../documents/index.js";
import type { CollaborationOwner } from "../collaboration/owner.js";
import { AiRepository, threadId, type AiRun } from "./ai.repository.js";
import type { ReviewAiInput } from "./ai.schema.js";
import { applyOperationBatch } from "@zhishu/document-contracts";
import type { WritingService } from "../writing-chat/writing.service.js";

export interface StartAiInput {
  request: AuthoringRequest | ChatRequest;
  protocolVersion: 1 | 2;
  previousRequestIds?: string[];
  sourceDocumentIds: string[];
}
const prompt = {
  id: "zhishu-writing",
  version: "1",
  systemInstruction: "请用清楚、自然的中文帮助用户思考和写作。资料不足时如实说明。",
};
export class AiService {
  private readonly ownerId = randomUUID();
  private readonly active = new Map<string, AbortController>();
  private readonly background = new Set<Promise<void>>();
  readonly modelVersion: string;
  constructor(
    private readonly repository: AiRepository,
    private readonly documents: AiDocumentAccess,
    private readonly owner: CollaborationOwner,
    private readonly model: BaseChatModel | null,
    private readonly saver: PostgresSaver,
    private readonly leases: Pool,
    private readonly config: AppConfig,
    private readonly writing?: WritingService,
  ) {
    this.modelVersion = hashContent([
      config.AI_MODEL ?? "injected-model",
      config.AI_BASE_URL ?? "default",
      config.AI_API_FORMAT ?? "auto",
      config.AI_THINKING ?? "default",
      config.AI_REASONING_EFFORT ?? "default",
      "zhishu-ai-v1",
    ]);
  }
  capabilities() {
    return {
      enabled: this.model !== null,
      protocolVersions: [1, 2],
      reason: this.model
        ? null
        : "尚未配置 AI 模型，请在服务端设置 AI_MODEL、AI_API_KEY 和可选的 AI_BASE_URL。",
      supportsTokenPreview: true,
      chatDelivery: "complete-result" as const,
    };
  }
  async context(principal: Principal, id: string) {
    const context = await this.documents.context(principal, id);
    return {
      ...context,
      version: {
        documentId: id,
        generationId: context.snapshot.generationId,
        durableSeq: context.snapshot.durableSeq,
        contentHash: hashContent(context.snapshot.content),
      },
    };
  }
  private async load(principal: Principal, id: string) {
    const run = await this.repository.find(principal, id);
    if (!run) throw new DomainError("NOT_FOUND", "任务不存在或无权访问");
    if (run.expiresAt.getTime() <= Date.now())
      throw new DomainError("AI_HISTORY_UNAVAILABLE", "任务已过保留期，请开启新对话");
    // Completed results retain historical evidence; reading requires current access,
    // while generation, resume and acceptance still require the original source versions.
    await this.documents.verify(principal, run.input, undefined, false, run.status !== "completed");
    return run;
  }
  private present(run: AiRun) {
    return {
      requestId: run.requestId,
      status: run.status,
      kind: run.input.request.kind,
      review: run.review
        ? {
            revision: run.review.revision,
            decisions: run.review.decisions,
            version: run.review.version,
            structureRevision: run.review.structureRevision,
          }
        : null,
      result: run.status === "completed" ? run.result : null,
      errorCode: run.errorCode,
      application: { state: run.applicationState, code: run.applicationCode, receipt: run.receipt },
      usage: run.usage,
      createdAt: run.createdAt.toISOString(),
      expiresAt: run.expiresAt.toISOString(),
    };
  }
  async get(principal: Principal, id: string) {
    const run = await this.load(principal, id);
    if (run.result && run.input.request.kind === "authoring") {
      if (
        !run.input.snapshot ||
        !validateAuthoringProposal(run.result, {
          request: run.input.request,
          snapshot: run.input.snapshot,
          evidence: run.input.evidence,
        }).success
      )
        throw new DomainError("CONFLICT", "任务结果不能安全读取");
    } else if (
      run.result &&
      run.input.request.kind === "chat" &&
      !validateChatResult(run.result, { request: run.input.request, evidence: run.input.evidence })
        .success
    )
      throw new DomainError("CONFLICT", "任务结果不能安全读取");
    return this.present(run);
  }
  async start(principal: Principal, body: StartAiInput) {
    if (!this.model) throw new DomainError("SERVICE_UNAVAILABLE", "AI 模型尚未配置");
    if (!validateAiTaskRequestV2(body.request).success)
      throw new DomainError("VALIDATION_ERROR", "AI 请求不合法");
    if (
      body.request.kind === "chat" &&
      body.request.responseMode === "discussion" &&
      body.sourceDocumentIds.length
    )
      throw new DomainError("VALIDATION_ERROR", "选择资料后请使用资料讨论模式");
    const inputHash = createHash("sha256").update(canonicalJson(body)).digest("hex");
    const old = await this.repository.find(principal, body.request.requestId);
    if (old) {
      if (old.inputHash !== inputHash)
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一任务标识不能用于不同输入");
      return { run: old, fresh: false };
    }
    const previousRequestIds =
      body.request.kind === "chat"
        ? (body.request.previousRequestIds ?? [])
        : (body.previousRequestIds ?? []);
    if (
      new Set(previousRequestIds).size !== previousRequestIds.length ||
      previousRequestIds.includes(body.request.requestId)
    )
      throw new DomainError("VALIDATION_ERROR", "历史任务引用不合法");
    const history: AiRunInput["history"] = [],
      historicalVersions: AiRunInput["sourceVersions"] = [];
    let previousCreatedAt = 0;
    for (const id of previousRequestIds) {
      const run = await this.load(principal, id);
      if (run.status !== "completed" || !run.result)
        throw new DomainError("AI_HISTORY_UNAVAILABLE", "历史任务尚未完成，请开启新对话");
      if (run.createdAt.getTime() < previousCreatedAt)
        throw new DomainError("VALIDATION_ERROR", "历史任务必须按时间顺序引用");
      previousCreatedAt = run.createdAt.getTime();
      const request = run.input.request;
      const text = "text" in run.result ? run.result.text : run.result.summary;
      history.push(
        {
          role: "user",
          content:
            request.kind === "chat"
              ? request.message
              : request.kind === "authoring"
                ? request.instruction
                : request.question,
        },
        { role: "assistant", content: text },
      );
      historicalVersions.push(...run.input.sourceVersions);
    }
    if (JSON.stringify(history).length > 16000)
      throw new DomainError("AI_HISTORY_UNAVAILABLE", "对话已超过上下文上限，请开启新对话");
    let target: Awaited<ReturnType<AiDocumentAccess["context"]>> | undefined;
    if (body.request.kind === "authoring") {
      await this.documents.target(principal, body.request.document.documentId);
      target = await this.documents.context(principal, body.request.document.documentId);
      if (
        target.snapshot.generationId !== body.request.document.generationId ||
        target.snapshot.durableSeq !== body.request.document.durableSeq ||
        target.structureRevision !== body.request.baseStructureRevision ||
        hashContent(target.snapshot.content) !== body.request.document.contentHash
      )
        throw new DomainError("CONFLICT", "文档已更新，请重新读取写入位置");
    }
    if (body.request.contextRef && !body.sourceDocumentIds.length)
      throw new DomainError("VALIDATION_ERROR", "请重新选择资料范围");
    const sources = await this.documents.sources(
      principal,
      body.sourceDocumentIds,
      target?.workspaceId,
    );
    const sourceVersions = [
      ...new Map(
        [...historicalVersions, ...sources.sourceVersions].map((v) => [v.documentId, v]),
      ).values(),
    ];
    const input: AiRunInput = {
      engine: body.request.kind === "authoring" ? "dsh-v1" : "langchain-v1",
      request: body.request,
      previousRequestIds,
      sourceDocumentIds: body.sourceDocumentIds,
      sourceVersions,
      snapshot: target?.snapshot,
      evidence: sources.evidence,
      history,
      modelVersion: this.modelVersion,
      limits: { ...DEFAULT_GENERATION_LIMITS, timeoutMs: this.config.AI_TIMEOUT_MS },
    };
    return this.repository.create(
      principal,
      inputHash,
      input,
      this.ownerId,
      this.config.AI_MAX_CONCURRENT,
    );
  }
  private async lease(run: AiRun) {
    const client = await this.leases.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1,719002)) as locked",
        [threadId(run)],
      );
      if (!result.rows[0]?.locked) throw new DomainError("CONFLICT", "原任务仍在执行，请稍后重试");
      return client;
    } catch (error) {
      client.release();
      throw error;
    }
  }
  private async release(client: PoolClient, run: AiRun) {
    try {
      await client.query("select pg_advisory_unlock(hashtextextended($1,719002))", [threadId(run)]);
    } finally {
      client.release();
    }
  }
  async *execute(
    run: AiRun,
    principal: Principal,
    externalSignal: AbortSignal,
    resume = false,
    heldLease?: PoolClient,
  ): AsyncGenerator<AiTaskEvent | AiTaskEventV2> {
    const controller = new AbortController(),
      key = threadId(run);
    const signal = AbortSignal.any([controller.signal, externalSignal]);
    this.active.set(key, controller);
    let client: PoolClient | undefined = heldLease,
      terminal = false,
      candidate: AiRun["result"] = null;
    let leaseLost = false;
    const lost = () => {
      leaseLost = true;
      controller.abort("LEASE_LOST");
    };
    let seq = 0;
    try {
      client ??= await this.lease(run);
      client.once("error", lost);
      client.once("end", lost);
      const input = run.input;
      if (!this.model || input.modelVersion !== this.modelVersion)
        throw new DomainError("CONFLICT", "模型配置已变化，请重新生成");
      await this.documents.verify(principal, input);
      const options = {
        model: this.model,
        checkpointer: this.saver,
        limits: input.limits,
        modelVersion: this.modelVersion,
        countTokens: (text: string) => Buffer.byteLength(text),
        verifyEvidence: async () => {
          await this.documents.verify(principal, input);
          return true;
        },
        reserveUsage: async (usage: {
          kind: "model" | "search" | "read";
          inputTokens: number;
          maxOutputTokens: number;
        }) => {
          try {
            await this.repository.reserve(
              run,
              usage.kind,
              usage.inputTokens,
              usage.maxOutputTokens,
            );
          } catch (error) {
            throw new AiRuntimeError(
              error instanceof DomainError && error.code === "RESOURCE_LIMIT"
                ? "BUDGET_EXCEEDED"
                : "CANCELLED",
            );
          }
        },
        researchTools: {
          searchKnowledge: async (query: string) => {
            const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
            return input.sourceDocumentIds
              .map((sourceId) => {
                const items = input.evidence.items.filter((i) => i.source.sourceId === sourceId);
                return {
                  sourceId,
                  title: items[0]?.title ?? "资料",
                  excerpt: items
                    .map((i) => i.text)
                    .join(" ")
                    .slice(0, 1200),
                  score: terms.reduce(
                    (n, t) => n + Number(items.some((i) => i.text.toLocaleLowerCase().includes(t))),
                    0,
                  ),
                };
              })
              .sort((a, b) => b.score - a.score)
              .map(({ sourceId, title, excerpt }) => ({ sourceId, title, excerpt }));
          },
          readSource: async (sourceId: string) => {
            await this.documents.verify(principal, input);
            if (!input.sourceDocumentIds.includes(sourceId))
              throw new AiRuntimeError("ACCESS_REVOKED");
            return input.evidence.items.filter((i) => i.source.sourceId === sourceId);
          },
        },
      };
      const request = input.request;
      const events =
        request.kind === "chat"
          ? (resume ? createChatRuntime(options).resume : createChatRuntime(options).generate)(
              { threadId: key, request, history: input.history, evidence: input.evidence, prompt },
              signal,
            )
          : request.kind === "authoring" && input.snapshot
            ? input.engine === "dsh-v1" && this.writing
              ? this.writing.generateProposal(
                  principal,
                  {
                    threadId: key,
                    request,
                    snapshot: input.snapshot,
                    structureRevision: request.baseStructureRevision,
                    evidence: input.evidence,
                    prompt,
                    history: input.history,
                  },
                  options,
                  signal,
                  resume,
                )
              : (resume
                  ? createAuthoringRuntime(options).resume
                  : createAuthoringRuntime(options).generate)(
                  {
                    threadId: key,
                    request,
                    snapshot: input.snapshot,
                    structureRevision: request.baseStructureRevision,
                    evidence: input.evidence,
                    prompt,
                    history: input.history,
                  },
                  signal,
                )
            : null;
      if (!events) throw new DomainError("VALIDATION_ERROR", "任务类型不支持");
      const validator =
        request.kind === "chat"
          ? createAiEventValidator({ requestId: run.requestId, protocolVersion: 2 })
          : createAiEventValidator({ requestId: run.requestId });
      for await (const event of events) {
        seq = event.seq;
        if (!validator.push(event).success) throw new AiRuntimeError("PROTOCOL_ERROR");
        if (event.type === "text-delta") await this.documents.verify(principal, input);
        if (event.type === "proposal" || event.type === "chat") {
          await this.documents.verify(principal, input);
          candidate = event.payload;
        }
        if (event.type === "completed") {
          signal.throwIfAborted();
          await this.documents.verify(principal, input);
          if (!candidate) throw new AiRuntimeError("INVALID_OUTPUT");
          await this.repository.complete(run, candidate);
          terminal = true;
        }
        if (event.type === "failed") {
          const disconnected = externalSignal.aborted && externalSignal.reason === "DISCONNECTED";
          await this.repository.stop(
            run,
            disconnected || leaseLost ? "interrupted" : signal.aborted ? "cancelled" : "failed",
            event.payload.code,
          );
          terminal = true;
        }
        if (!externalSignal.aborted) yield event;
      }
      if (!validator.finish().success) throw new AiRuntimeError("PROTOCOL_ERROR");
    } catch (error) {
      if (!terminal) {
        const code =
          error instanceof AiRuntimeError
            ? error.code
            : signal.aborted
              ? "CANCELLED"
              : error instanceof DomainError && error.code === "AI_ACCESS_REVOKED"
                ? "ACCESS_REVOKED"
                : "MODEL_FAILED";
        const interrupted = externalSignal.reason === "DISCONNECTED" || leaseLost;
        await this.repository.stop(
          run,
          interrupted ? "interrupted" : signal.aborted ? "cancelled" : "failed",
          code,
        );
        terminal = true;
        if (!externalSignal.aborted) {
          if (seq === 0) {
            yield run.input.request.kind === "chat"
              ? {
                  protocolVersion: 2,
                  requestId: run.requestId,
                  seq: ++seq,
                  type: "started",
                  payload: { kind: "chat" },
                }
              : {
                  protocolVersion: 1,
                  requestId: run.requestId,
                  seq: ++seq,
                  type: "started",
                  payload: { kind: "authoring" },
                };
          }
          yield {
            protocolVersion: run.input.request.kind === "chat" ? 2 : 1,
            requestId: run.requestId,
            seq: seq + 1,
            type: "failed",
            payload: { code, retryable: false },
          } as AiTaskEvent | AiTaskEventV2;
        }
      }
    } finally {
      if (!terminal) await this.repository.stop(run, "interrupted", "STREAM_INTERRUPTED");
      this.active.delete(key);
      controller.abort();
      if (client) {
        client.removeListener("error", lost);
        client.removeListener("end", lost);
        if (leaseLost) client.release(true);
        else await this.release(client, run);
      }
    }
  }
  /** Writing execution is owned by the service; disconnect ends only this subscriber. */
  async *executeDetached(run: AiRun, principal: Principal, subscriber: AbortSignal) {
    const queue: (AiTaskEvent | AiTaskEventV2)[] = [];
    let done = false,
      wake: (() => void) | undefined;
    const task = (async () => {
      try {
        for await (const event of this.execute(run, principal, new AbortController().signal)) {
          if (!subscriber.aborted && queue.length < 128) queue.push(event);
          wake?.();
        }
      } finally {
        done = true;
        wake?.();
      }
    })();
    this.background.add(task);
    void task.catch(() => undefined).finally(() => this.background.delete(task));
    const abort = () => wake?.();
    subscriber.addEventListener("abort", abort);
    try {
      while (!subscriber.aborted) {
        while (queue.length) yield queue.shift()!;
        if (done) {
          await task;
          break;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    } finally {
      subscriber.removeEventListener("abort", abort);
    }
  }
  async accept(principal: Principal, id: string) {
    const run = await this.load(principal, id),
      request = run.input.request;
    if (
      request.kind !== "authoring" ||
      run.status !== "completed" ||
      !run.result ||
      !("operationBatch" in run.result) ||
      !run.input.snapshot
    )
      throw new DomainError("CONFLICT", "完整提案生成后才能接受");
    await this.documents.target(principal, request.document.documentId);
    if (
      !validateAuthoringProposal(run.result, {
        request,
        snapshot: run.input.snapshot,
        evidence: run.input.evidence,
      }).success
    )
      throw new DomainError("CONFLICT", "提案验证失败");
    if (run.receipt && !run.review) return this.present(run);
    if (isReplacementIntent(request.intent))
      return this.review(principal, id, {
        decisionId: randomUUID(),
        revision: run.review?.revision ?? 0,
        action: "accept",
      });
    if (run.receipt) return this.present(run);
    try {
      const proposal = run.result as AuthoringProposal;
      await this.owner.apply({
        principal,
        batch: { ...proposal.operationBatch, generationId: request.document.generationId },
        expectedDurableSeq: request.document.durableSeq,
        baseStructureRevision: request.baseStructureRevision,
        guard: async (tx) => {
          await this.repository.guardApply(tx, run);
          await this.documents.verify(principal, run.input, tx, true);
        },
        record: (tx, receipt) => this.repository.recordReceipt(tx, run, receipt),
      });
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "WRITE_UNCONFIRMED";
      if (code === "AI_ACCESS_REVOKED" || code === "AI_WRITE_PERSONAL_ONLY") {
        await this.repository.application(run, "blocked", code);
        throw error;
      } else
        await this.repository.application(
          run,
          code === "CONFLICT" ? "conflict" : code === "WRITE_UNCONFIRMED" ? "pending" : "blocked",
          code,
        );
    }
    return this.get(principal, id);
  }
  async review(principal: Principal, id: string, body: ReviewAiInput) {
    const run = await this.load(principal, id),
      request = run.input.request;
    if (
      request.kind !== "authoring" ||
      !isReplacementIntent(request.intent) ||
      run.status !== "completed" ||
      !run.result ||
      !("operationBatch" in run.result) ||
      !run.input.snapshot ||
      !validateAuthoringProposal(run.result, {
        request,
        snapshot: run.input.snapshot,
        evidence: run.input.evidence,
      }).success
    )
      throw new DomainError("CONFLICT", "完整替换建议生成后才能审阅");
    // Runs accepted before paragraph review retain their original durable receipt.
    if (run.receipt && !run.review) return this.get(principal, id);
    const proposal = run.result;
    const review = run.review ?? {
      revision: 0,
      decisions: [],
      version: request.document,
      structureRevision: request.baseStructureRevision,
      receipts: {},
    };
    const fingerprint = hashContent(body);
    const previous = review.receipts[body.decisionId];
    if (previous) {
      if (previous !== fingerprint)
        throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一确认标识不能用于不同决定");
      return this.get(principal, id);
    }
    if (body.revision !== review.revision)
      throw new DomainError("CONFLICT", "建议状态已更新，请重新查看");
    const changes = replacementChanges(proposal, run.input.snapshot.content);
    const settled = new Set(review.decisions.map((decision) => decision.blockId));
    const pending = changes
      .filter((change) => !settled.has(change.blockId))
      .map((change) => change.blockId);
    if (!pending.length && run.review) return this.get(principal, id);
    const selected = body.blockIds ?? pending;
    if (selected.some((blockId) => !pending.includes(blockId)))
      throw new DomainError("CONFLICT", "所选建议已处理或不存在");
    const next: NonNullable<AiRun["review"]> = {
      ...review,
      revision: review.revision + 1,
      decisions: [
        ...review.decisions,
        ...selected.map((blockId) => ({ blockId, action: body.action })),
      ],
      receipts: { ...review.receipts, [body.decisionId]: fingerprint },
    };
    const accepted = next.decisions.some((decision) => decision.action === "accept");
    const state =
      next.decisions.length === changes.length
        ? accepted
          ? "applied"
          : "rejected"
        : accepted
          ? "partial"
          : "pending";
    if (body.action === "reject" || !selected.length) {
      await this.repository.rejectReview(
        run,
        body.revision,
        body.decisionId,
        fingerprint,
        next,
        state,
      );
      return this.get(principal, id);
    }
    await this.documents.target(principal, request.document.documentId);
    try {
      const context = await this.context(principal, request.document.documentId);
      if (
        canonicalJson(context.version) !== canonicalJson(review.version) ||
        context.structureRevision !== review.structureRevision
      )
        throw new DomainError("CONFLICT", "原文已变化，剩余建议未写入");
      const batch = replacementBatch(
        proposal,
        run.input.snapshot.content,
        context.snapshot.content,
        selected,
        `op_${hashContent([id, body.decisionId, fingerprint]).slice(7, 55)}`,
      );
      const applied =
        batch &&
        applyOperationBatch(context.snapshot.content, batch, {
          documentId: request.document.documentId,
          generationId: review.version.generationId,
        });
      if (!batch || !applied || !applied.success)
        throw new DomainError("CONFLICT", "建议无法安全应用");
      // Only this run's committed decisions advance its baseline, including a self-sourced target.
      const input = {
        ...run.input,
        sourceVersions: run.input.sourceVersions.map((source) =>
          source.documentId === request.document.documentId
            ? {
                ...source,
                generationId: review.version.generationId,
                durableSeq: review.version.durableSeq,
              }
            : source,
        ),
      };
      await this.owner.apply({
        principal,
        batch: { ...batch, generationId: review.version.generationId },
        expectedDurableSeq: review.version.durableSeq,
        baseStructureRevision: review.structureRevision,
        guard: async (tx) => {
          if (
            !(await this.repository.guardReview(
              tx,
              run,
              body.revision,
              body.decisionId,
              fingerprint,
            ))
          )
            throw new DomainError("CONFLICT", "该决定已处理");
          await this.documents.verify(principal, input, tx, true);
        },
        record: async (tx, receipt) => {
          next.version = {
            ...review.version,
            durableSeq: receipt.durableSeq,
            contentHash: hashContent(applied.content),
          };
          next.structureRevision = receipt.structureRevision;
          await this.repository.recordReview(tx, run, next, state, receipt);
        },
      });
    } catch (error) {
      const current = await this.repository.find(principal, id);
      if (current?.review?.receipts[body.decisionId] === fingerprint)
        return this.get(principal, id);
      const code = error instanceof DomainError ? error.code : "WRITE_UNCONFIRMED";
      await this.repository.failReview(
        run,
        body.revision,
        code === "CONFLICT"
          ? "conflict"
          : code === "WRITE_UNCONFIRMED"
            ? run.applicationState
            : "blocked",
        code,
      );
      if (code === "AI_ACCESS_REVOKED" || code === "AI_WRITE_PERSONAL_ONLY") throw error;
    }
    return this.get(principal, id);
  }
  async cancel(principal: Principal, id: string) {
    const run = await this.load(principal, id);
    await this.repository.cancel(principal, id);
    this.active.get(threadId(run))?.abort("CANCELLED");
    return this.get(principal, id);
  }
  async resume(principal: Principal, id: string) {
    const run = await this.load(principal, id);
    if (run.status !== "interrupted" || run.cancelRequested)
      throw new DomainError("CONFLICT", "当前任务不能恢复");
    if (run.input.request.kind === "authoring") {
      await this.documents.target(principal, run.input.request.document.documentId);
      const context = await this.documents.context(
        principal,
        run.input.request.document.documentId,
      );
      if (
        context.snapshot.generationId !== run.input.request.document.generationId ||
        context.snapshot.durableSeq !== run.input.request.document.durableSeq ||
        context.structureRevision !== run.input.request.baseStructureRevision
      )
        throw new DomainError("CONFLICT", "文档已更新，请重新生成");
    }
    const lease = await this.lease(run);
    let next: AiRun;
    try {
      next = await this.repository.resume(run, this.ownerId, this.config.AI_MAX_CONCURRENT);
    } catch (error) {
      await this.release(lease, run);
      throw error;
    }
    const work = (async () => {
      for await (const _event of this.execute(
        next,
        principal,
        new AbortController().signal,
        true,
        lease,
      )) {
        void _event;
      }
    })();
    this.background.add(work);
    void work.finally(() => this.background.delete(work)).catch(() => undefined);
    return this.present(next);
  }
  async maintain() {
    for (const run of await this.repository.running()) {
      if (this.active.has(threadId(run))) continue;
      let lease: PoolClient;
      try {
        lease = await this.lease(run);
      } catch {
        continue;
      }
      try {
        await this.repository.stop(
          run,
          run.cancelRequested ? "cancelled" : "interrupted",
          "OWNER_EXITED",
        );
      } finally {
        await this.release(lease, run);
      }
    }
    for (const run of await this.repository.expired()) {
      if (this.active.has(threadId(run))) continue;
      let lease: PoolClient;
      try {
        lease = await this.lease(run);
      } catch {
        continue;
      }
      try {
        await this.saver.deleteThread(threadId(run));
        await this.repository.remove(run);
      } finally {
        await this.release(lease, run);
      }
    }
  }
  async close() {
    for (const controller of this.active.values()) controller.abort("SHUTDOWN");
    await Promise.allSettled([...this.background]);
  }
}
