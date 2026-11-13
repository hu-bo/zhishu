import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { MessagePart, ConversationPurpose, RunStatus } from "@zhishu/chat-contracts";
import type {
  ConversationOrigin,
  GenerationLimits,
  ProposalApplicationState,
  ProposalReview,
  QaExecution,
  QaRunContext,
  RunUsage,
  ScopeSelection,
  WritingApproval,
  WritingExecution,
  WritingRunContext,
} from "@zhishu/ai-contracts";
import { DEFAULT_RUN_USAGE } from "@zhishu/ai-contracts";
import { hashContent } from "@zhishu/ai-contracts/hash";
import type { StructureReceipt } from "@zhishu/document-contracts";
import type { Database } from "../../../database/index.js";
import { DomainError } from "../../shared/domain-error.js";
import { AiRepository } from "./ai.repository.js";
import type { ArtifactRow, ConversationRow, MessageRow, RunRow } from "./ai.types.js";
import { artifactDto, conversationDto, messageDto, runDto } from "./ai.types.js";

const TERMINAL_RUN: readonly RunStatus[] = ["completed", "interrupted", "failed", "cancelled"];
const ACTIVE_RUN: readonly RunStatus[] = ["queued", "running", "waiting-approval", "interrupted"];
const QUEUED_CAP = 4;
const RUN_FRESH_MINUTES = 30;
const RUN_KEEP_DAYS = 7;

/** Conversation owner: one internal identity or one signed public visitor. */
export type ConversationOwner =
  | { kind: "identity"; tenantId: string; identityId: string; siteId?: string }
  | { kind: "visitor"; tenantId: string; visitorId: string; siteId: string };

export interface CreateConversationCommand {
  purpose: ConversationPurpose;
  owner: ConversationOwner;
  scope: ScopeSelection;
  targetDocumentId?: string | null;
  configurationId?: string | null;
  creationKey?: string | null;
  origin?: ConversationOrigin | null;
  ttlMs?: number;
}

export interface AdmitMessageCommand {
  conversation: ConversationRow;
  purpose: ConversationPurpose;
  expectedContextRevision: number;
  clientMessageId: string;
  idempotencyKey: string;
  parts: MessagePart[];
  /** Canonical client request material used for the inputHash replay comparison. */
  identityInput: unknown;
  context: QaRunContext | WritingRunContext;
}

/** Default hourly Run admission budget per owner; the single source for the 120 cap. */
export const DEFAULT_OWNER_HOURLY_MAX = 120;

export interface AdmissionBudget {
  tenantRunningMax: number;
  ownerHourlyMax: number;
  siteHourlyMax?: number;
}

export interface ExecutionWrite {
  run: RunRow;
  owner: string;
  execution?: QaExecution | WritingExecution;
  /**
   * Shallow merge onto the current fenced execution. Step progress must not rewrite the
   * evidence ledger that registerArtifact folds in concurrently.
   */
  executionPatch?: Partial<QaExecution> & Partial<WritingExecution>;
  status?: "running" | "waiting-approval";
  reserve?: Partial<Record<keyof RunUsage, number>>;
  limits?: GenerationLimits;
  renewLeaseMs?: number;
  emitEvent?: boolean;
}

export interface CommitOutputCommand {
  run: RunRow;
  owner: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  errorCode?: string;
  /** Assistant answer content; staged then committed in this transaction. */
  assistantParts?: MessagePart[];
  artifactIdsToCommit?: string[];
  execution?: QaExecution | WritingExecution;
  /** Settled actual usage added to the reservations; the product metering source of truth. */
  usage?: Partial<Record<keyof RunUsage, number>>;
}

export interface RegisterArtifactCommand {
  run: RunRow;
  owner: string;
  producerCallId: string;
  resultIndex: number;
  kind: "evidence" | "draft" | "proposal" | "image";
  schemaVersion: number;
  payload: unknown;
  evidenceIds: string[];
  applicationState?: ProposalApplicationState;
  /** Evidence artifact registration also folds identities into the Run evidence ledger. */
  trackEvidence?: boolean;
}

/**
 * The single shared product service. Both purposes drive state through it; no business
 * module writes conversation/run/message/artifact/event rows on its own. All external
 * network calls happen outside these transactions.
 */
export class AiService {
  readonly repository: AiRepository;
  /** Stable instance identity for lease ownership. */
  readonly instanceId = randomUUID();

  constructor(
    private readonly db: Database,
    private readonly log: (event: string, meta: Record<string, unknown>) => void = () => {},
    wake?: (conversationKey: string) => void,
  ) {
    this.repository = new AiRepository(db, (tenantId, conversationId) =>
      wake?.(`${tenantId}:${conversationId}`),
    );
  }

  private tx<T>(fn: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>) {
    return this.db.transaction(fn);
  }

  async createConversation(
    cmd: CreateConversationCommand,
  ): Promise<{ conversation: ConversationRow; created: boolean }> {
    const id = `ai_${randomUUID().replaceAll("-", "")}`;
    return this.tx(async (tx) => {
      if (cmd.creationKey) {
        const existing = await this.repository.findConversationByCreationKey(tx, {
          tenantId: cmd.owner.tenantId,
          purpose: cmd.purpose,
          creationKey: cmd.creationKey,
          identityId: cmd.owner.kind === "identity" ? cmd.owner.identityId : undefined,
          visitorId: cmd.owner.kind === "visitor" ? cmd.owner.visitorId : undefined,
          siteId: cmd.owner.kind === "visitor" ? cmd.owner.siteId : (cmd.owner.siteId ?? null),
        });
        if (existing) return { conversation: existing, created: false };
      }
      const conversation = await this.repository.insertConversation(tx, {
        id,
        tenantId: cmd.owner.tenantId,
        purpose: cmd.purpose,
        identityId: cmd.owner.kind === "identity" ? cmd.owner.identityId : null,
        visitorId: cmd.owner.kind === "visitor" ? cmd.owner.visitorId : null,
        siteId: cmd.owner.kind === "visitor" ? cmd.owner.siteId : (cmd.owner.siteId ?? null),
        scopeSelection: cmd.scope,
        targetDocumentId: cmd.targetDocumentId ?? null,
        configurationId: cmd.configurationId ?? null,
        creationKey: cmd.creationKey ?? null,
        origin: cmd.origin ?? null,
        expiresAt: cmd.ttlMs ? new Date(Date.now() + cmd.ttlMs) : null,
      });
      return { conversation, created: true };
    });
  }

  async getConversation(tenantId: string, conversationId: string): Promise<ConversationRow> {
    const row = await this.repository.findConversation(this.db, tenantId, conversationId);
    if (!row) throw new DomainError("NOT_FOUND", "会话不存在");
    return row;
  }

  async refresh(conversation: ConversationRow): Promise<ConversationRow> {
    return (
      (await this.repository.findConversation(this.db, conversation.tenantId, conversation.id)) ??
      conversation
    );
  }

  async listConversations(
    owner: ConversationOwner,
    purpose: ConversationPurpose,
    filter: { targetDocumentId?: string; limit?: number } = {},
  ): Promise<ConversationRow[]> {
    return this.repository.listConversations(this.db, {
      tenantId: owner.tenantId,
      purpose,
      identityId: owner.kind === "identity" ? owner.identityId : undefined,
      visitorId: owner.kind === "visitor" ? owner.visitorId : undefined,
      targetDocumentId: filter.targetDocumentId,
      limit: filter.limit ?? 20,
    });
  }

  /** Atomic admission: queued Run + committed user message + events in one short transaction. */
  async admitMessage(
    cmd: AdmitMessageCommand,
    budget: AdmissionBudget,
  ): Promise<{
    run: RunRow;
    message: MessageRow;
    replayed: boolean;
  }> {
    const inputHash = hashContent(cmd.identityInput);
    return this.tx(async (tx) => {
      // Fixed lock order: admission key, then conversation row.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ai-admit:${cmd.conversation.tenantId}:${cmd.conversation.id}`},719202))`,
      );
      const conversation = await this.repository.lockConversation(
        tx,
        cmd.conversation.tenantId,
        cmd.conversation.id,
      );
      if (!conversation) throw new DomainError("NOT_FOUND", "会话不存在");
      if (conversation.purpose !== cmd.purpose)
        throw new DomainError("CONFLICT", "会话用途与路由不一致");
      if (conversation.status !== "active") throw new DomainError("CONFLICT", "会话不可继续");
      if (conversation.contextRevision !== cmd.expectedContextRevision)
        throw new DomainError("CONFLICT", "上下文已更新，请基于新上下文重新提交");
      const byKey = await this.repository.findRunByIdempotency(
        tx,
        conversation.tenantId,
        conversation.id,
        cmd.idempotencyKey,
      );
      if (byKey) {
        if (byKey.inputHash !== inputHash)
          throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一幂等标识不能用于不同输入");
        const userMessage = await this.findUserMessage(tx, conversation, byKey);
        return { run: byKey, message: userMessage, replayed: true };
      }
      const byClient = await this.repository.findMessageByClientId(
        tx,
        conversation.tenantId,
        conversation.id,
        cmd.clientMessageId,
      );
      if (byClient) {
        const run = await this.repository.findRun(tx, conversation.tenantId, byClient.runId);
        if (!run) throw new DomainError("CONFLICT", "消息缺少任务");
        if (run.inputHash !== inputHash)
          throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一消息标识不能用于不同输入");
        return { run, message: byClient, replayed: true };
      }
      const active = await this.repository.listActiveRuns(
        tx,
        conversation.tenantId,
        conversation.id,
      );
      if (active.filter((r) => r.status === "queued").length >= QUEUED_CAP)
        throw new DomainError("RESOURCE_LIMIT", "等待队列已满");
      const tenantRunning = await this.repository.countActiveByOwner(tx, {
        tenantId: conversation.tenantId,
      });
      if (tenantRunning >= budget.tenantRunningMax)
        throw new DomainError("RESOURCE_LIMIT", "租户并发生成已满，请稍后重试");
      const ownerActive = await this.repository.countActiveByOwner(tx, {
        tenantId: conversation.tenantId,
        identityId: conversation.identityId ?? undefined,
        visitorId: conversation.visitorId ?? undefined,
      });
      if (ownerActive >= 1) throw new DomainError("RESOURCE_LIMIT", "当前身份已有生成中的会话");
      const hourWindow = new Date(Date.now() - 3_600_000);
      if (conversation.identityId) {
        const ownerRecent = await this.repository.countRuns(tx, {
          tenantId: conversation.tenantId,
          statuses: ACTIVE_RUN,
          identityId: conversation.identityId,
          since: hourWindow,
        });
        if (ownerRecent >= budget.ownerHourlyMax)
          throw new DomainError("RESOURCE_LIMIT", "本小时生成额度已用完");
      }
      if (conversation.siteId && budget.siteHourlyMax !== undefined) {
        const siteRecent = await this.repository.countRuns(tx, {
          tenantId: conversation.tenantId,
          statuses: ACTIVE_RUN,
          siteId: conversation.siteId,
          since: hourWindow,
        });
        if (siteRecent >= budget.siteHourlyMax)
          throw new DomainError("RESOURCE_LIMIT", "本站点本小时提问额度已用完");
      }
      const runId = `run_${randomUUID().replaceAll("-", "")}`;
      const run = await this.repository.insertRun(tx, {
        id: runId,
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        purpose: cmd.purpose,
        idempotencyKey: cmd.idempotencyKey,
        inputHash,
        context: cmd.context,
        usage: { ...DEFAULT_RUN_USAGE },
        expiresAt: new Date(Date.now() + RUN_FRESH_MINUTES * 60_000),
      });
      const message = await this.repository.insertMessage(tx, {
        id: `msg_${randomUUID().replaceAll("-", "")}`,
        tenantId: conversation.tenantId,
        conversationId: conversation.id,
        runId,
        role: "user",
        parts: cmd.parts,
        clientMessageId: cmd.clientMessageId,
        state: "committed",
        committedAt: new Date(),
      });
      await this.repository.appendEvent(tx, conversation, {
        eventId: randomUUID(),
        type: "run.updated",
        entityId: runId,
        payload: { run: runDto(run) },
        createdAt: new Date(),
      });
      await this.repository.appendEvent(tx, conversation, {
        eventId: randomUUID(),
        type: "message.created",
        entityId: message.id,
        payload: { message: messageDto(message) },
        createdAt: new Date(),
      });
      return { run, message, replayed: false };
    });
  }

  private async findUserMessage(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    conversation: ConversationRow,
    run: RunRow,
  ): Promise<MessageRow> {
    const found = await this.repository.userMessage(
      tx,
      conversation.tenantId,
      conversation.id,
      run.id,
    );
    if (!found) throw new DomainError("CONFLICT", "任务缺少输入消息");
    return found;
  }

  /** Claim one queued run under the conversation single-writer rule with a fencing token. */
  async claimRun(conversation: ConversationRow, leaseMs: number): Promise<RunRow | undefined> {
    return this.tx(async (tx) => {
      const locked = await this.repository.lockConversation(
        tx,
        conversation.tenantId,
        conversation.id,
      );
      if (!locked) return;
      const run = await this.repository.claimQueuedRun(
        tx,
        locked,
        this.instanceId,
        new Date(Date.now() + leaseMs),
      );
      if (!run) return;
      await this.repository.appendEvent(tx, locked, {
        eventId: randomUUID(),
        type: "run.updated",
        entityId: run.id,
        payload: { run: runDto(run) },
        createdAt: new Date(),
      });
      return run;
    });
  }

  /** Fenced execution/lease/usage write. Undefined means the lease was lost: stop all work. */
  async writeExecution(input: ExecutionWrite): Promise<RunRow | undefined> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, input.run.tenantId, input.run.id);
      if (
        !current ||
        current.leaseOwner !== input.owner ||
        current.fencingToken !== input.run.fencingToken ||
        current.attempt !== input.run.attempt ||
        TERMINAL_RUN.includes(current.status)
      )
        return;
      let usage = current.usage;
      if (input.reserve && input.limits)
        usage = settleUsage(current.usage, input.reserve, input.limits);
      let execution = input.execution ?? current.execution ?? undefined;
      if (input.executionPatch) {
        const base = (current.execution ?? {
          evidenceRefs: [],
          evidenceArtifactIds: [],
          steps: [],
        }) as QaExecution | WritingExecution;
        execution = { ...base, ...input.executionPatch };
      }
      const updated = await this.repository.patchRunFenced(tx, current, input.owner, {
        usage,
        execution,
        status: input.status,
        leaseExpiresAt: input.renewLeaseMs ? new Date(Date.now() + input.renewLeaseMs) : undefined,
      });
      if (!updated) return;
      if (input.emitEvent === false) return updated;
      const conversation = await this.repository.lockConversation(
        tx,
        updated.tenantId,
        updated.conversationId,
      );
      if (conversation) {
        const execution = updated.execution as WritingExecution | null;
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "run.updated",
          entityId: updated.id,
          payload: {
            run: runDto(updated),
            ...(execution?.approval ? { approval: execution.approval } : {}),
          },
          createdAt: new Date(),
        });
      }
      return updated;
    });
  }

  /** Idempotent producer artifact write; evidence identities fold into the Run evidence ledger. */
  async registerArtifact(
    cmd: RegisterArtifactCommand,
  ): Promise<{ artifact: ArtifactRow; created: boolean; run: RunRow }> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, cmd.run.tenantId, cmd.run.id);
      if (
        !current ||
        current.leaseOwner !== cmd.owner ||
        current.fencingToken !== cmd.run.fencingToken ||
        TERMINAL_RUN.includes(current.status)
      )
        throw new DomainError("CONFLICT", "执行所有权已丢失");
      const baseExecution = (current.execution ?? {
        evidenceRefs: [],
        evidenceArtifactIds: [],
        steps: [],
      }) as QaExecution;
      const inserted = await this.repository.insertArtifact(tx, {
        id: `art_${randomUUID().replaceAll("-", "")}`,
        tenantId: current.tenantId,
        conversationId: current.conversationId,
        runId: current.id,
        purpose: current.purpose,
        producerCallId: cmd.producerCallId,
        resultIndex: cmd.resultIndex,
        kind: cmd.kind,
        schemaVersion: cmd.schemaVersion,
        state: "committed",
        payload: cmd.payload,
        evidenceRefs: cmd.evidenceIds.map((evidenceId) => ({ evidenceArtifactId: "", evidenceId })),
        applicationState: cmd.applicationState ?? null,
      });
      if (!inserted.created) return { ...inserted, run: current };
      if (cmd.evidenceIds.length)
        await this.repository.setArtifactPayload(tx, current.tenantId, inserted.artifact.id, {
          evidenceRefs: cmd.evidenceIds.map((evidenceId) => ({
            evidenceArtifactId: inserted.artifact.id,
            evidenceId,
          })),
        });
      let tracked = current;
      if (cmd.trackEvidence) {
        const updated = await this.repository.patchRunFenced(tx, current, cmd.owner, {
          execution: {
            ...baseExecution,
            evidenceArtifactIds: [
              ...new Set([...baseExecution.evidenceArtifactIds, inserted.artifact.id]),
            ],
            evidenceRefs: [
              ...baseExecution.evidenceRefs,
              ...cmd.evidenceIds.map((evidenceId) => ({
                evidenceArtifactId: inserted.artifact.id,
                evidenceId,
              })),
            ],
          },
        });
        if (!updated) throw new DomainError("CONFLICT", "执行所有权已丢失");
        tracked = updated;
      }
      const conversation = await this.repository.lockConversation(
        tx,
        current.tenantId,
        current.conversationId,
      );
      if (conversation) {
        const stored = await this.repository.findArtifact(
          tx,
          current.tenantId,
          inserted.artifact.id,
        );
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "artifact.created",
          entityId: inserted.artifact.id,
          payload: { artifact: artifactDto(stored ?? inserted.artifact) },
          createdAt: new Date(),
        });
      }
      return { ...inserted, run: tracked };
    });
  }

  /** Stage the single assistant message (no public event until commit). */
  async stageAssistantMessage(
    run: RunRow,
    owner: string,
    parts: MessagePart[],
  ): Promise<MessageRow | undefined> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, run.tenantId, run.id);
      if (
        !current ||
        current.leaseOwner !== owner ||
        current.fencingToken !== run.fencingToken ||
        TERMINAL_RUN.includes(current.status)
      )
        return;
      const staged = await this.repository.upsertStagedAssistant(tx, {
        id: `amsg_${current.id}`,
        tenantId: current.tenantId,
        conversationId: current.conversationId,
        runId: current.id,
        parts,
        generationAttempt: current.attempt,
      });
      const execution = (current.execution ?? {
        evidenceRefs: [],
        evidenceArtifactIds: [],
        steps: [],
      }) as QaExecution | WritingExecution;
      await this.repository.patchRunFenced(tx, current, owner, {
        execution: { ...execution, stagedMessageId: staged.id },
      });
      return staged;
    });
  }

  /** Final product commit: fenced Run terminal, staged output and artifacts committed, events. */
  async commitRunOutput(cmd: CommitOutputCommand): Promise<RunRow> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, cmd.run.tenantId, cmd.run.id);
      if (
        !current ||
        current.leaseOwner !== cmd.owner ||
        current.fencingToken !== cmd.run.fencingToken ||
        current.attempt !== cmd.run.attempt
      )
        throw new DomainError("CONFLICT", "执行所有权已丢失");
      if (TERMINAL_RUN.includes(current.status)) return current;
      const conversation = await this.repository.lockConversation(
        tx,
        current.tenantId,
        current.conversationId,
      );
      if (!conversation) throw new DomainError("CONFLICT", "会话不存在");
      const updated = await this.repository.patchRunFenced(tx, current, cmd.owner, {
        status: cmd.status,
        errorCode: cmd.errorCode,
        execution: cmd.execution ?? current.execution ?? undefined,
        usage: cmd.usage ? addUsage(current.usage, cmd.usage) : current.usage,
        clearLease: true,
        expiresAt: new Date(Date.now() + RUN_KEEP_DAYS * 86_400_000),
      });
      const settled = updated ?? {
        ...current,
        status: cmd.status,
        errorCode: cmd.errorCode ?? null,
      };
      for (const artifactId of cmd.artifactIdsToCommit ?? []) {
        const committed = await this.repository.commitArtifact(tx, settled.tenantId, artifactId);
        if (committed)
          await this.repository.appendEvent(tx, conversation, {
            eventId: randomUUID(),
            type: "artifact.created",
            entityId: committed.id,
            payload: { artifact: artifactDto(committed) },
            createdAt: new Date(),
          });
      }
      if (cmd.assistantParts) {
        const existing = await this.repository.assistantMessage(tx, settled.tenantId, settled.id);
        const staged =
          existing ??
          (await this.repository.upsertStagedAssistant(tx, {
            id: `amsg_${settled.id}`,
            tenantId: settled.tenantId,
            conversationId: settled.conversationId,
            runId: settled.id,
            parts: cmd.assistantParts,
            generationAttempt: settled.attempt,
          }));
        if (staged && staged.state === "staged") {
          const committed = await this.repository.commitMessage(tx, settled.tenantId, staged.id);
          if (committed)
            await this.repository.appendEvent(tx, conversation, {
              eventId: randomUUID(),
              type: "message.created",
              entityId: committed.id,
              payload: { message: messageDto(committed) },
              createdAt: new Date(),
            });
        }
      }
      await this.repository.appendEvent(tx, conversation, {
        eventId: randomUUID(),
        type: "run.updated",
        entityId: settled.id,
        payload: { run: runDto(settled) },
        createdAt: new Date(),
      });
      return settled;
    });
  }

  /** Persist the active tool approval and flip the Run to waiting-approval (writing only). */
  async recordApproval(
    run: RunRow,
    owner: string,
    approval: WritingApproval,
  ): Promise<RunRow | undefined> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, run.tenantId, run.id);
      if (
        !current ||
        current.leaseOwner !== owner ||
        current.fencingToken !== run.fencingToken ||
        current.status !== "running"
      )
        return;
      const execution: WritingExecution = {
        ...((current.execution as WritingExecution) ?? {
          evidenceRefs: [],
          evidenceArtifactIds: [],
          proposalArtifactIds: [],
          steps: [],
        }),
        approval,
      };
      const updated = await this.repository.patchRunFenced(tx, current, owner, {
        execution,
        status: "waiting-approval",
      });
      if (!updated) return;
      const conversation = await this.repository.lockConversation(
        tx,
        updated.tenantId,
        updated.conversationId,
      );
      if (conversation)
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "run.updated",
          entityId: updated.id,
          payload: { run: runDto(updated), approval },
          createdAt: new Date(),
        });
      return updated;
    });
  }

  /** Apply the user's decision to the stored approval and return the Run to running. */
  async resolveApproval(input: {
    run: RunRow;
    owner: string;
    approvalId: string;
    decision?: "allow-once" | "reject";
    decisionId?: string;
    outcome: WritingApproval["status"];
  }): Promise<void> {
    await this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, input.run.tenantId, input.run.id);
      if (
        !current ||
        current.leaseOwner !== input.owner ||
        current.fencingToken !== input.run.fencingToken
      )
        return;
      const execution = (current.execution as WritingExecution) ?? {
        evidenceRefs: [],
        evidenceArtifactIds: [],
        proposalArtifactIds: [],
        steps: [],
      };
      if (!execution.approval || execution.approval.id !== input.approvalId) return;
      const approval: WritingApproval = {
        ...execution.approval,
        status: input.outcome,
        ...(input.decision ? { decision: input.decision } : {}),
        ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      };
      const updated = await this.repository.patchRunFenced(tx, current, input.owner, {
        execution: { ...execution, approval },
        status: current.status === "waiting-approval" ? "running" : current.status,
      });
      if (!updated) return;
      const conversation = await this.repository.lockConversation(
        tx,
        updated.tenantId,
        updated.conversationId,
      );
      if (conversation)
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "run.updated",
          entityId: updated.id,
          payload: { run: runDto(updated), approval },
          createdAt: new Date(),
        });
    });
  }

  /**
   * Retry is the only user retry command. It first checks persisted facts: committed output
   * closes the Run; staged output re-delivers without regeneration; otherwise a new attempt.
   */
  async retryRun(
    tenantId: string,
    runId: string,
  ): Promise<{ kind: "already-terminal" | "queued" | "redeliver-staged"; run: RunRow }> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, tenantId, runId);
      if (!current) throw new DomainError("NOT_FOUND", "任务不存在");
      if (current.status === "completed") return { kind: "already-terminal", run: current };
      if (current.status !== "failed" && current.status !== "interrupted")
        throw new DomainError("CONFLICT", "当前状态不能重试");
      const conversation = await this.repository.lockConversation(
        tx,
        current.tenantId,
        current.conversationId,
      );
      if (!conversation) throw new DomainError("CONFLICT", "会话不存在");
      const assistant = await this.repository.assistantMessage(tx, tenantId, current.id);
      if (assistant?.state === "committed") {
        const closed = await this.repository.setRunStatusUnleased(
          tx,
          tenantId,
          current.id,
          "completed",
        );
        const settled = closed ?? current;
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "run.updated",
          entityId: settled.id,
          payload: { run: runDto(settled) },
          createdAt: new Date(),
        });
        return { kind: "already-terminal", run: settled };
      }
      const bumped = await this.repository.bumpRunAttempt(tx, tenantId, current.id, [
        "failed",
        "interrupted",
      ]);
      if (!bumped) throw new DomainError("CONFLICT", "重试未能受理");
      await this.repository.appendEvent(tx, conversation, {
        eventId: randomUUID(),
        type: "run.updated",
        entityId: bumped.id,
        payload: { run: runDto(bumped) },
        createdAt: new Date(),
      });
      return { kind: assistant?.state === "staged" ? "redeliver-staged" : "queued", run: bumped };
    });
  }

  /** Dispatcher entry: claim the oldest queued run for the purpose across conversations. */
  async claimNext(
    purpose: ConversationPurpose,
    leaseMs: number,
  ): Promise<{ conversation: ConversationRow; run: RunRow } | undefined> {
    const queued = await this.repository.queuedRuns(purpose, 32);
    const seen = new Set<string>();
    for (const queuedRun of queued) {
      if (seen.has(queuedRun.conversationId)) continue;
      seen.add(queuedRun.conversationId);
      const conversation = await this.repository.findConversation(
        this.db,
        queuedRun.tenantId,
        queuedRun.conversationId,
      );
      if (!conversation || conversation.status !== "active") continue;
      const claimed = await this.claimRun(conversation, leaseMs);
      if (claimed) return { conversation, run: claimed };
    }
    return undefined;
  }

  async readRun(tenantId: string, runId: string): Promise<RunRow | undefined> {
    return this.repository.findRun(this.db, tenantId, runId);
  }

  async readMessage(tenantId: string, messageId: string): Promise<MessageRow | undefined> {
    return this.repository.findMessage(this.db, tenantId, messageId);
  }

  async userMessageForRun(
    tenantId: string,
    runId: string,
    conversationId: string,
  ): Promise<MessageRow | undefined> {
    return this.repository.userMessage(this.db, tenantId, conversationId, runId);
  }

  async listCommittedMessages(
    tenantId: string,
    conversationId: string,
    limit: number,
  ): Promise<MessageRow[]> {
    const rows = await this.repository.listMessages(this.db, {
      tenantId,
      conversationId,
      limit,
    });
    return [...rows].reverse();
  }

  async cancelRun(tenantId: string, runId: string): Promise<RunRow> {
    return this.tx(async (tx) => {
      const current = await this.repository.lockRun(tx, tenantId, runId);
      if (!current) throw new DomainError("NOT_FOUND", "任务不存在");
      if (TERMINAL_RUN.includes(current.status)) return current;
      const marked = await this.repository.markCancelRequested(tx, tenantId, runId);
      const finalized =
        current.status === "queued"
          ? await this.repository.setRunStatusUnleased(tx, tenantId, runId, "cancelled")
          : marked;
      const conversation = await this.repository.lockConversation(
        tx,
        tenantId,
        current.conversationId,
      );
      if (conversation && finalized)
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "run.updated",
          entityId: finalized.id,
          payload: { run: runDto(finalized) },
          createdAt: new Date(),
        });
      return finalized ?? current;
    });
  }

  /** Scope changes bump the single context revision, isolate executing runs and emit scope.changed. */
  async setScope(
    conversation: ConversationRow,
    expectedContextRevision: number,
    scope: ScopeSelection,
  ): Promise<{ conversation: ConversationRow; cancelledRunIds: string[] }> {
    return this.tx(async (tx) => {
      const locked = await this.repository.lockConversation(
        tx,
        conversation.tenantId,
        conversation.id,
      );
      if (!locked) throw new DomainError("NOT_FOUND", "会话不存在");
      if (locked.contextRevision !== expectedContextRevision)
        throw new DomainError("CONFLICT", "上下文已更新，请刷新后重试");
      const active = await this.repository.listActiveRuns(tx, locked.tenantId, locked.id);
      const cancelledRunIds: string[] = [];
      for (const run of active) {
        if (run.status === "queued") {
          await this.repository.setRunStatusUnleased(tx, locked.tenantId, run.id, "cancelled");
          cancelledRunIds.push(run.id);
        } else if (run.status === "running" || run.status === "waiting-approval") {
          await this.repository.markCancelRequested(tx, locked.tenantId, run.id);
          cancelledRunIds.push(run.id);
        }
      }
      await this.repository.updateConversation(tx, locked, {
        scopeSelection: scope,
        contextRevision: locked.contextRevision + 1,
      });
      const refreshed = {
        ...locked,
        scopeSelection: scope,
        contextRevision: locked.contextRevision + 1,
      };
      await this.repository.appendEvent(tx, refreshed, {
        eventId: randomUUID(),
        type: "scope.changed",
        entityId: refreshed.id,
        payload: { contextRevision: refreshed.contextRevision, scope, cancelledRunIds },
        createdAt: new Date(),
      });
      return { conversation: refreshed, cancelledRunIds };
    });
  }

  /** Revocation transaction: withdraw staged, cancel active runs, bump revision. */
  async invalidateContext(
    tenantId: string,
    conversationIds: string[],
    reason: string,
  ): Promise<void> {
    for (const id of conversationIds) {
      await this.tx(async (tx) => {
        const conversation = await this.repository.lockConversation(tx, tenantId, id);
        if (!conversation) return;
        await this.repository.withdrawMessages(tx, tenantId, id);
        const active = await this.repository.listActiveRuns(tx, tenantId, id);
        const cancelledRunIds: string[] = [];
        for (const run of active) {
          cancelledRunIds.push(run.id);
          if (run.status === "running" || run.status === "waiting-approval")
            await this.repository.markCancelRequested(tx, tenantId, run.id);
          else await this.repository.setRunStatusUnleased(tx, tenantId, run.id, "cancelled");
        }
        await this.repository.updateConversation(tx, conversation, {
          contextRevision: conversation.contextRevision + 1,
        });
        const refreshed = { ...conversation, contextRevision: conversation.contextRevision + 1 };
        await this.repository.appendEvent(tx, refreshed, {
          eventId: randomUUID(),
          type: "scope.changed",
          entityId: refreshed.id,
          payload: {
            contextRevision: refreshed.contextRevision,
            scope: refreshed.scopeSelection,
            cancelledRunIds,
            reason,
          },
          createdAt: new Date(),
        });
      });
    }
  }

  /** Record a review decision; duplicate decisionId replays, unknown application keeps pending. */
  async recordProposalReview(input: {
    tenantId: string;
    artifactId: string;
    expectedRevision: number;
    decisionId: string;
    fingerprint: string;
    applicationState: ProposalApplicationState;
    review: ProposalReview;
    receipt?: StructureReceipt | null;
  }): Promise<{ changed: boolean; artifact: ArtifactRow }> {
    return this.tx(async (tx) => {
      const artifact = await this.repository.lockArtifact(tx, input.tenantId, input.artifactId);
      if (!artifact || artifact.kind !== "proposal")
        throw new DomainError("NOT_FOUND", "提案不存在");
      const receipts = artifact.review?.receipts ?? {};
      if (receipts[input.decisionId]) {
        if (receipts[input.decisionId] !== input.fingerprint)
          throw new DomainError("IDEMPOTENCY_KEY_REUSED", "同一决定标识不能用于不同内容");
        return { changed: false, artifact };
      }
      if ((artifact.reviewRevision ?? 0) !== input.expectedRevision)
        throw new DomainError("CONFLICT", "提案状态已更新，请刷新后重试");
      const review: ProposalReview = {
        ...input.review,
        receipts: { ...receipts, [input.decisionId]: input.fingerprint },
      };
      const updated = await this.repository.recordArtifactReview(tx, artifact, {
        reviewRevision: (artifact.reviewRevision ?? 0) + 1,
        review,
        applicationState: input.applicationState,
        ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
      });
      if (!updated) throw new DomainError("CONFLICT", "提案状态已更新，请刷新后重试");
      const conversation = await this.repository.lockConversation(
        tx,
        updated.tenantId,
        updated.conversationId,
      );
      if (conversation)
        await this.repository.appendEvent(tx, conversation, {
          eventId: randomUUID(),
          type: "artifact.application-updated",
          entityId: updated.id,
          payload: {
            artifactId: updated.id,
            applicationState: updated.applicationState,
            reviewRevision: updated.reviewRevision,
            receipt: updated.receipt,
          },
          createdAt: new Date(),
        });
      return { changed: true, artifact: updated };
    });
  }

  async snapshot(
    conversation: ConversationRow,
    page: { before?: string; limit?: number } = {},
  ): Promise<import("@zhishu/chat-contracts").ConversationSnapshot> {
    const limit = page.limit ?? 60;
    const messages = await this.repository.listMessages(this.db, {
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      limit,
      before: page.before,
    });
    const runs = await this.repository.listRecentRuns(
      this.db,
      conversation.tenantId,
      conversation.id,
      50,
    );
    const artifacts = await this.repository.listArtifacts(
      this.db,
      conversation.tenantId,
      conversation.id,
      80,
    );
    const title =
      (await this.repository.conversationTitle(this.db, conversation.id, conversation.tenantId)) ??
      "对话";
    return {
      conversation: conversationDto(conversation, title),
      messages: [...messages].reverse().map(messageDto),
      runs: [...runs].reverse().map(runDto),
      artifacts: artifacts.map(artifactDto),
      cursor: conversation.eventSequence.toString(),
      hasMoreMessages: messages.length === limit,
    };
  }

  async events(tenantId: string, conversationId: string, cursor: string, limit = 100) {
    return this.repository.eventsAfter(this.db, tenantId, conversationId, cursor, limit);
  }

  /** Scheduler maintenance: stale leases, deadlines and reference-ordered GC. */
  async maintain(): Promise<void> {
    const stale = await this.repository.staleRuns();
    for (const run of stale) {
      await this.tx(async (tx) => {
        const current = await this.repository.lockRun(tx, run.tenantId, run.id);
        if (
          !current ||
          !["queued", "running", "waiting-approval", "interrupted"].includes(current.status)
        )
          return;
        const deadline =
          current.status === "queued" ||
          (current.status === "interrupted" && current.expiresAt < new Date());
        const target = current.status === "queued" ? "failed" : "interrupted";
        const code = deadline ? "DEADLINE" : "OWNER_EXITED";
        const updated = await this.repository.setRunStatusUnleased(
          tx,
          current.tenantId,
          current.id,
          target,
          code,
        );
        const conversation = await this.repository.lockConversation(
          tx,
          current.tenantId,
          current.conversationId,
        );
        if (conversation && updated)
          await this.repository.appendEvent(tx, conversation, {
            eventId: randomUUID(),
            type: "run.updated",
            entityId: updated.id,
            payload: { run: runDto(updated) },
            createdAt: new Date(),
          });
      });
      this.log("ai_run_expired", { runId: run.id });
    }
    const expired = await this.repository.expiredConversations();
    for (const conversation of expired) {
      const deleted = await this.tx(async (tx) => {
        const locked = await this.repository.lockConversation(
          tx,
          conversation.tenantId,
          conversation.id,
        );
        if (!locked) return false;
        return this.repository.deleteConversationRows(tx, locked.tenantId, locked.id);
      });
      if (deleted) this.log("ai_conversation_gc", { conversationId: conversation.id });
      else
        this.log("ai_conversation_gc_retained", {
          conversationId: conversation.id,
          reason: "unsettled runs, image results or proposal applications",
        });
    }
  }

  async findArtifact(tenantId: string, artifactId: string): Promise<ArtifactRow | undefined> {
    return this.repository.findArtifact(this.db, tenantId, artifactId);
  }

  async listArtifacts(
    tenantId: string,
    conversationId: string,
    limit = 80,
  ): Promise<ArtifactRow[]> {
    return this.repository.listArtifacts(this.db, tenantId, conversationId, limit);
  }

  async listActiveRuns(tenantId: string, conversationId: string): Promise<RunRow[]> {
    return this.repository.listActiveRuns(this.db, tenantId, conversationId);
  }

  async listConversationsByIds(tenantId: string, ids: string[]): Promise<ConversationRow[]> {
    if (!ids.length) return [];
    return this.repository.listConversationsByIds(this.db, tenantId, ids);
  }
}

/** Actuals are additive facts; budget enforcement happens at reservation time, not here. */
function addUsage(usage: RunUsage, delta: Partial<Record<keyof RunUsage, number>>): RunUsage {
  return {
    ...usage,
    modelCalls: usage.modelCalls + (delta.modelCalls ?? 0),
    inputTokens: usage.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (delta.outputTokens ?? 0),
    searchCalls: usage.searchCalls + (delta.searchCalls ?? 0),
    sourceReads: usage.sourceReads + (delta.sourceReads ?? 0),
    webSearchCalls: usage.webSearchCalls + (delta.webSearchCalls ?? 0),
    webReadCalls: usage.webReadCalls + (delta.webReadCalls ?? 0),
    unknownCalls: usage.unknownCalls + (delta.unknownCalls ?? 0),
    ...(delta.providerCredits !== undefined
      ? { providerCredits: (usage.providerCredits ?? 0) + delta.providerCredits }
      : {}),
  };
}

function settleUsage(
  usage: RunUsage,
  delta: Partial<Record<keyof RunUsage, number>>,
  limits: GenerationLimits,
): RunUsage {
  const next = addUsage(usage, delta);
  if (
    next.modelCalls > limits.maxModelCalls ||
    next.searchCalls > limits.maxSearchCalls ||
    next.sourceReads > limits.maxSourceReads ||
    next.webSearchCalls > limits.webSearchCallsPerRun ||
    next.webReadCalls > limits.webReadPagesPerRun ||
    next.inputTokens > limits.maxInputTokens * limits.maxModelCalls ||
    next.outputTokens > limits.maxOutputTokens * limits.maxModelCalls
  )
    throw new DomainError("RESOURCE_LIMIT", "本轮生成预算已用完");
  return next;
}
