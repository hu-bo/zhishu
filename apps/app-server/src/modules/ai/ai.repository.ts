import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  aiArtifacts,
  aiConversations,
  aiEvents,
  aiImageJobs,
  aiMessages,
  aiRuns,
  aiSessions,
} from "../../../database/schema/index.js";
import type { Database } from "../../../database/index.js";
import type { StructureReceipt } from "@zhishu/document-contracts";
import type {
  ProposalApplicationState,
  ProposalReview,
  RunUsage,
  ScopeSelection,
} from "@zhishu/ai-contracts";
import type { RunStatus } from "@zhishu/chat-contracts";
import type { ArtifactRow, ConversationRow, MessageRow, RunRow } from "./ai.types.js";

type Tx = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Persistence layer for the shared product tables. SQL lives here only; business ordering
 * and fencing rules are enforced by the service. Every conversation-owning mutation runs
 * inside a transaction that locks the conversation row first.
 */
export class AiRepository {
  constructor(
    readonly db: Database,
    private readonly onEventsAppended?: (userId: string, conversationId: string) => void,
  ) {}

  async lockConversation(tx: Tx, userId: string, id: string): Promise<ConversationRow | undefined> {
    const [row] = await tx
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.userId, userId), eq(aiConversations.id, id)))
      .for("update")
      .limit(1);
    return row as ConversationRow | undefined;
  }

  async findConversation(tx: Tx, userId: string, id: string) {
    const [row] = await tx
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.userId, userId), eq(aiConversations.id, id)))
      .limit(1);
    return row as ConversationRow | undefined;
  }

  async insertConversation(
    tx: Tx,
    values: {
      id: string;
      userId: string;
      identityId?: string | null;
      visitorId?: string | null;
      siteId?: string | null;
      scopeSelection: ScopeSelection;
      targetDocumentId?: string | null;
      configurationId?: string | null;
      creationKey?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<ConversationRow> {
    const [row] = await tx
      .insert(aiConversations)
      .values({
        ...values,
        identityId: values.identityId ?? null,
        visitorId: values.visitorId ?? null,
        siteId: values.siteId ?? null,
        targetDocumentId: values.targetDocumentId ?? null,
        configurationId: values.configurationId ?? null,
        creationKey: values.creationKey ?? null,
        expiresAt: values.expiresAt ?? null,
      })
      .returning();
    return row as ConversationRow;
  }

  async updateConversation(
    tx: Tx,
    row: ConversationRow,
    patch: Partial<
      Pick<
        ConversationRow,
        "scopeSelection" | "contextRevision" | "status" | "expiresAt" | "targetDocumentId"
      >
    >,
  ) {
    await tx
      .update(aiConversations)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(aiConversations.userId, row.userId), eq(aiConversations.id, row.id)));
  }

  async listConversations(
    tx: Tx,
    filter: {
      userId: string;
      identityId?: string;
      visitorId?: string;
      siteId?: string;
      targetDocumentId?: string;
      limit: number;
    },
  ): Promise<ConversationRow[]> {
    return (await tx
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.userId, filter.userId),
          filter.identityId ? eq(aiConversations.identityId, filter.identityId) : undefined,
          filter.visitorId ? eq(aiConversations.visitorId, filter.visitorId) : undefined,
          filter.siteId ? eq(aiConversations.siteId, filter.siteId) : undefined,
          filter.targetDocumentId
            ? eq(aiConversations.targetDocumentId, filter.targetDocumentId)
            : undefined,
        ),
      )
      .orderBy(desc(aiConversations.createdAt), desc(aiConversations.id))
      .limit(filter.limit)) as ConversationRow[];
  }

  async findConversationByCreationKey(
    tx: Tx,
    filter: {
      userId: string;
      creationKey: string;
      identityId?: string;
      visitorId?: string;
      siteId?: string | null;
    },
  ) {
    const [row] = await tx
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.userId, filter.userId),
          eq(aiConversations.creationKey, filter.creationKey),
          filter.identityId ? eq(aiConversations.identityId, filter.identityId) : undefined,
          filter.visitorId ? eq(aiConversations.visitorId, filter.visitorId) : undefined,
          filter.siteId === null
            ? sql`${aiConversations.siteId} is null`
            : filter.siteId
              ? eq(aiConversations.siteId, filter.siteId)
              : undefined,
        ),
      )
      .limit(1);
    return row as ConversationRow | undefined;
  }

  async conversationTitle(tx: Tx, conversationId: string, userId: string): Promise<string | null> {
    const [row] = await tx
      .select({ part: aiMessages.parts })
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.userId, userId),
          eq(aiMessages.conversationId, conversationId),
          eq(aiMessages.role, "user"),
        ),
      )
      .orderBy(aiMessages.createdAt)
      .limit(1);
    const first = (row?.part as MessageRow["parts"] | undefined)?.find((p) => p.kind === "text");
    return first && first.kind === "text" ? first.text.slice(0, 80) : null;
  }

  async insertRun(
    tx: Tx,
    values: {
      id: string;
      userId: string;
      conversationId: string;
      idempotencyKey: string;
      inputHash: string;
      context: RunRow["context"];
      usage: RunUsage;
      expiresAt: Date;
    },
  ): Promise<RunRow> {
    const [row] = await tx
      .insert(aiRuns)
      .values({ ...values, status: "queued" })
      .returning();
    return row as RunRow;
  }

  async findRun(tx: Tx, userId: string, runId: string) {
    const [row] = await tx
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.userId, userId), eq(aiRuns.id, runId)))
      .limit(1);
    return row as RunRow | undefined;
  }

  async lockRun(tx: Tx, userId: string, runId: string) {
    const [row] = await tx
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.userId, userId), eq(aiRuns.id, runId)))
      .for("update")
      .limit(1);
    return row as RunRow | undefined;
  }

  async findRunByIdempotency(
    tx: Tx,
    userId: string,
    conversationId: string,
    idempotencyKey: string,
  ) {
    const [row] = await tx
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.userId, userId),
          eq(aiRuns.conversationId, conversationId),
          eq(aiRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row as RunRow | undefined;
  }

  async claimQueuedRun(
    tx: Tx,
    conversation: ConversationRow,
    owner: string,
    leaseExpiresAt: Date,
  ): Promise<RunRow | undefined> {
    // Fencing token comes from the conversation event clock: strictly monotonic per conversation.
    const fencing = conversation.eventSequence + 1n;
    // Postgres UPDATE cannot carry ORDER BY/LIMIT: pick the oldest queued run under the
    // conversation single-writer rule enforced by the caller's advisory lock.
    const [active] = await tx
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.userId, conversation.userId),
          eq(aiRuns.conversationId, conversation.id),
          inArray(aiRuns.status, ["running", "waiting-approval"]),
        ),
      )
      .limit(1);
    if (active) return;
    const [queued] = await tx
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.userId, conversation.userId),
          eq(aiRuns.conversationId, conversation.id),
          eq(aiRuns.status, "queued"),
        ),
      )
      .orderBy(aiRuns.createdAt, aiRuns.id)
      .limit(1);
    if (!queued) return;
    const [row] = await tx
      .update(aiRuns)
      .set({
        status: "running",
        leaseOwner: owner,
        leaseExpiresAt,
        fencingToken: fencing,
        updatedAt: new Date(),
      })
      .where(and(eq(aiRuns.userId, conversation.userId), eq(aiRuns.id, queued.id)))
      .returning();
    return row as RunRow | undefined;
  }

  /** Fenced execution-state write: only the current lease owner may patch its attempt. */
  async patchRunFenced(
    tx: Tx,
    run: RunRow,
    owner: string,
    patch: Partial<
      Pick<RunRow, "execution" | "usage" | "status" | "errorCode" | "expiresAt" | "leaseExpiresAt">
    > & {
      clearLease?: boolean;
    },
  ): Promise<RunRow | undefined> {
    const { clearLease, ...columns } = patch;
    const [row] = await tx
      .update(aiRuns)
      .set({
        ...columns,
        ...(clearLease ? { leaseOwner: null, leaseExpiresAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiRuns.userId, run.userId),
          eq(aiRuns.id, run.id),
          eq(aiRuns.attempt, run.attempt),
          eq(aiRuns.leaseOwner, owner),
          eq(aiRuns.fencingToken, run.fencingToken!),
          inArray(aiRuns.status, ["running", "waiting-approval"]),
        ),
      )
      .returning();
    return row as RunRow | undefined;
  }

  async setRunStatusUnleased(
    tx: Tx,
    userId: string,
    runId: string,
    status: RunStatus,
    errorCode?: string,
  ) {
    const [row] = await tx
      .update(aiRuns)
      .set({
        status,
        errorCode: errorCode ?? null,
        updatedAt: new Date(),
        cancelRequested: status === "cancelled" ? true : undefined,
      })
      .where(
        and(
          eq(aiRuns.userId, userId),
          eq(aiRuns.id, runId),
          inArray(aiRuns.status, ["queued", "running", "waiting-approval", "interrupted"]),
        ),
      )
      .returning();
    return row as RunRow | undefined;
  }

  async markCancelRequested(tx: Tx, userId: string, runId: string) {
    const [row] = await tx
      .update(aiRuns)
      .set({ cancelRequested: true, updatedAt: new Date() })
      .where(
        and(
          eq(aiRuns.userId, userId),
          eq(aiRuns.id, runId),
          inArray(aiRuns.status, ["queued", "running", "waiting-approval"]),
        ),
      )
      .returning();
    return row as RunRow | undefined;
  }

  async bumpRunAttempt(
    tx: Tx,
    userId: string,
    runId: string,
    statusFilter: RunStatus[],
  ): Promise<RunRow | undefined> {
    const [row] = await tx
      .update(aiRuns)
      .set({
        attempt: sql`${aiRuns.attempt} + 1`,
        status: "queued",
        errorCode: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(aiRuns.userId, userId), eq(aiRuns.id, runId), inArray(aiRuns.status, statusFilter)),
      )
      .returning();
    return row as RunRow | undefined;
  }

  async countRuns(
    tx: Tx,
    filter: {
      userId: string;
      statuses: readonly RunStatus[];
      identityId?: string;
      siteId?: string;
      since: Date;
    },
  ) {
    const rows = (await tx.execute(
      sql`select count(*)::text as count from ai_runs where
        user_id = ${filter.userId}
        and status in (${sql.join(
          filter.statuses.map((s) => sql`${s}`),
          sql`,`,
        )})
        and created_at >= ${filter.since}
        ${filter.identityId ? sql`and exists (select 1 from ai_conversations c where c.user_id = ai_runs.user_id and c.id = ai_runs.conversation_id and c.identity_id = ${filter.identityId})` : sql``}
        ${filter.siteId ? sql`and exists (select 1 from ai_conversations c where c.user_id = ai_runs.user_id and c.id = ai_runs.conversation_id and c.site_id = ${filter.siteId})` : sql``}`,
    )) as unknown as { count: string }[];
    return Number(rows[0]?.count ?? 0);
  }

  async countActiveByOwner(
    tx: Tx,
    filter: { userId: string; identityId?: string; visitorId?: string; siteId?: string },
  ) {
    const rows = (await tx.execute(
      sql`select count(*)::text as count from ai_runs r
        join ai_conversations c on c.user_id = r.user_id and c.id = r.conversation_id
        where r.user_id = ${filter.userId} and r.status in ('running','waiting-approval')
        ${filter.identityId ? sql`and c.identity_id = ${filter.identityId}` : sql``}
        ${filter.visitorId ? sql`and c.visitor_id = ${filter.visitorId}` : sql``}
        ${filter.siteId ? sql`and c.site_id = ${filter.siteId}` : sql``}`,
    )) as unknown as { count: string }[];
    return Number(rows[0]?.count ?? 0);
  }

  async listActiveRuns(tx: Tx, userId: string, conversationId: string): Promise<RunRow[]> {
    return (await tx
      .select()
      .from(aiRuns)
      .where(
        and(
          eq(aiRuns.userId, userId),
          eq(aiRuns.conversationId, conversationId),
          inArray(aiRuns.status, ["queued", "running", "waiting-approval", "interrupted"]),
        ),
      )
      .orderBy(aiRuns.createdAt)) as RunRow[];
  }

  async insertMessage(
    tx: Tx,
    values: {
      id: string;
      userId: string;
      conversationId: string;
      runId: string;
      role: "user" | "assistant";
      parts: MessageRow["parts"];
      clientMessageId?: string | null;
      state: MessageRow["state"];
      generationAttempt?: number | null;
      committedAt?: Date | null;
    },
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(aiMessages)
      .values({
        ...values,
        clientMessageId: values.clientMessageId ?? null,
        generationAttempt: values.generationAttempt ?? null,
        committedAt: values.committedAt ?? null,
      })
      .returning();
    return row as MessageRow;
  }

  async findMessageByClientId(
    tx: Tx,
    userId: string,
    conversationId: string,
    clientMessageId: string,
  ) {
    const [row] = await tx
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.userId, userId),
          eq(aiMessages.conversationId, conversationId),
          eq(aiMessages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1);
    return row as MessageRow | undefined;
  }

  async findMessage(tx: Tx, userId: string, id: string) {
    const [row] = await tx
      .select()
      .from(aiMessages)
      .where(and(eq(aiMessages.userId, userId), eq(aiMessages.id, id)))
      .limit(1);
    return row as MessageRow | undefined;
  }

  async assistantMessage(tx: Tx, userId: string, runId: string) {
    const [row] = await tx
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.userId, userId),
          eq(aiMessages.runId, runId),
          eq(aiMessages.role, "assistant"),
        ),
      )
      .limit(1);
    return row as MessageRow | undefined;
  }

  /** Direct hit on ai_messages_run_user_uq; never scan conversation pages for a Run input. */
  async userMessage(tx: Tx, userId: string, conversationId: string, runId: string) {
    const [row] = await tx
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.userId, userId),
          eq(aiMessages.conversationId, conversationId),
          eq(aiMessages.runId, runId),
          eq(aiMessages.role, "user"),
        ),
      )
      .limit(1);
    return row as MessageRow | undefined;
  }

  async upsertStagedAssistant(
    tx: Tx,
    values: {
      id: string;
      userId: string;
      conversationId: string;
      runId: string;
      parts: MessageRow["parts"];
      generationAttempt: number;
    },
  ): Promise<MessageRow> {
    const [row] = await tx
      .insert(aiMessages)
      .values({ ...values, role: "assistant", state: "staged" })
      .onConflictDoUpdate({
        target: [aiMessages.userId, aiMessages.conversationId, aiMessages.runId],
        targetWhere: sql`${aiMessages.role} = 'assistant'`,
        set: {
          parts: values.parts,
          generationAttempt: values.generationAttempt,
          state: "staged",
          committedAt: null,
        },
      })
      .returning();
    return row as MessageRow;
  }

  async commitMessage(tx: Tx, userId: string, messageId: string) {
    const [row] = await tx
      .update(aiMessages)
      .set({ state: "committed", committedAt: new Date() })
      .where(
        and(
          eq(aiMessages.userId, userId),
          eq(aiMessages.id, messageId),
          eq(aiMessages.state, "staged"),
        ),
      )
      .returning();
    return row as MessageRow | undefined;
  }

  async withdrawMessages(tx: Tx, userId: string, conversationId: string) {
    await tx
      .update(aiMessages)
      .set({ state: "withdrawn" })
      .where(
        and(
          eq(aiMessages.userId, userId),
          eq(aiMessages.conversationId, conversationId),
          eq(aiMessages.state, "staged"),
        ),
      );
  }

  async listMessages(
    tx: Tx,
    filter: { userId: string; conversationId: string; limit: number; before?: string },
  ) {
    return (await tx
      .select()
      .from(aiMessages)
      .where(
        and(
          eq(aiMessages.userId, filter.userId),
          eq(aiMessages.conversationId, filter.conversationId),
          eq(aiMessages.state, "committed"),
          filter.before
            ? sql`(${aiMessages.createdAt}, ${aiMessages.id}) < (
                select m.created_at, m.id from ai_messages m
                where m.user_id = ${filter.userId} and m.id = ${filter.before}
              )`
            : undefined,
        ),
      )
      .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
      .limit(filter.limit)) as MessageRow[];
  }

  async listRecentRuns(tx: Tx, userId: string, conversationId: string, limit: number) {
    return (await tx
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.userId, userId), eq(aiRuns.conversationId, conversationId)))
      .orderBy(desc(aiRuns.createdAt))
      .limit(limit)) as RunRow[];
  }

  async listArtifacts(tx: Tx, userId: string, conversationId: string, limit: number) {
    return (await tx
      .select()
      .from(aiArtifacts)
      .where(
        and(
          eq(aiArtifacts.userId, userId),
          eq(aiArtifacts.conversationId, conversationId),
          inArray(aiArtifacts.state, ["committed"]),
        ),
      )
      .orderBy(aiArtifacts.createdAt)
      .limit(limit)) as ArtifactRow[];
  }

  async findArtifact(tx: Tx, userId: string, id: string) {
    const [row] = await tx
      .select()
      .from(aiArtifacts)
      .where(and(eq(aiArtifacts.userId, userId), eq(aiArtifacts.id, id)))
      .limit(1);
    return row as ArtifactRow | undefined;
  }

  async lockArtifact(tx: Tx, userId: string, id: string) {
    const [row] = await tx
      .select()
      .from(aiArtifacts)
      .where(and(eq(aiArtifacts.userId, userId), eq(aiArtifacts.id, id)))
      .for("update")
      .limit(1);
    return row as ArtifactRow | undefined;
  }

  /** Idempotent producer write: the same (run, producerCallId, resultIndex) returns the original. */
  async insertArtifact(
    tx: Tx,
    values: {
      id: string;
      userId: string;
      conversationId: string;
      runId: string;
      producerCallId: string;
      resultIndex: number;
      kind: ArtifactRow["kind"];
      schemaVersion: number;
      state: ArtifactRow["state"];
      payload: unknown;
      evidenceRefs: ArtifactRow["evidenceRefs"];
      applicationState?: ProposalApplicationState | null;
    },
  ) {
    const inserted = await tx
      .insert(aiArtifacts)
      .values({
        ...values,
        applicationState: values.applicationState ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length) return { artifact: inserted[0] as ArtifactRow, created: true };
    const [existing] = await tx
      .select()
      .from(aiArtifacts)
      .where(
        and(
          eq(aiArtifacts.userId, values.userId),
          eq(aiArtifacts.runId, values.runId),
          eq(aiArtifacts.producerCallId, values.producerCallId),
          eq(aiArtifacts.resultIndex, values.resultIndex),
        ),
      )
      .limit(1);
    return { artifact: existing as ArtifactRow, created: false };
  }

  async commitArtifact(tx: Tx, userId: string, id: string) {
    const [row] = await tx
      .update(aiArtifacts)
      .set({ state: "committed" })
      .where(
        and(
          eq(aiArtifacts.userId, userId),
          eq(aiArtifacts.id, id),
          eq(aiArtifacts.state, "staged"),
        ),
      )
      .returning();
    return row as ArtifactRow | undefined;
  }

  async setArtifactPayload(
    tx: Tx,
    userId: string,
    id: string,
    patch: {
      payload?: unknown;
      evidenceRefs?: ArtifactRow["evidenceRefs"];
      state?: ArtifactRow["state"];
    },
  ) {
    const [row] = await tx
      .update(aiArtifacts)
      .set(patch)
      .where(and(eq(aiArtifacts.userId, userId), eq(aiArtifacts.id, id)))
      .returning();
    return row as ArtifactRow | undefined;
  }

  async recordArtifactReview(
    tx: Tx,
    row: ArtifactRow,
    patch: {
      reviewRevision: number;
      review: ProposalReview;
      applicationState: ProposalApplicationState;
      receipt?: StructureReceipt | null;
    },
  ) {
    const [updated] = await tx
      .update(aiArtifacts)
      .set({
        reviewRevision: patch.reviewRevision,
        review: patch.review,
        applicationState: patch.applicationState,
        ...(patch.receipt !== undefined ? { receipt: patch.receipt } : {}),
      })
      .where(
        and(
          eq(aiArtifacts.userId, row.userId),
          eq(aiArtifacts.id, row.id),
          sql`coalesce(${aiArtifacts.reviewRevision}, 0) = ${row.reviewRevision ?? 0}`,
        ),
      )
      .returning();
    return updated as ArtifactRow | undefined;
  }

  async appendEvent(
    tx: Tx,
    conversation: ConversationRow,
    event: {
      type: import("@zhishu/chat-contracts").AiEvent["type"];
      entityId: string;
      payload: unknown;
      eventId: string;
      createdAt: Date;
    },
  ) {
    const sequence = conversation.eventSequence + 1n;
    await tx
      .update(aiConversations)
      .set({ eventSequence: sequence, updatedAt: event.createdAt })
      .where(
        and(
          eq(aiConversations.userId, conversation.userId),
          eq(aiConversations.id, conversation.id),
        ),
      );
    await tx.insert(aiEvents).values({
      userId: conversation.userId,
      conversationId: conversation.id,
      sequence,
      type: event.type,
      entityId: event.entityId,
      payload: event.payload,
      createdAt: event.createdAt,
    });
    conversation.eventSequence = sequence;
    this.onEventsAppended?.(conversation.userId, conversation.id);
    return sequence;
  }

  async eventsAfter(tx: Tx, userId: string, conversationId: string, cursor: string, limit: number) {
    return (await tx
      .select()
      .from(aiEvents)
      .where(
        and(
          eq(aiEvents.userId, userId),
          eq(aiEvents.conversationId, conversationId),
          sql`${aiEvents.sequence} > ${cursor}`,
        ),
      )
      .orderBy(aiEvents.sequence)
      .limit(limit)) as {
      userId: string;
      conversationId: string;
      sequence: bigint;
      type: import("@zhishu/chat-contracts").AiEvent["type"];
      entityId: string;
      payload: unknown;
      createdAt: Date;
    }[];
  }

  async queuedRuns(limit = 64): Promise<RunRow[]> {
    return (await this.db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.status, "queued"))
      .orderBy(aiRuns.createdAt)
      .limit(limit)) as RunRow[];
  }

  async staleRuns(limit = 64): Promise<RunRow[]> {
    return (await this.db
      .select()
      .from(aiRuns)
      .where(
        sql`(${aiRuns.status} in ('queued') and ${aiRuns.expiresAt} < now())
          or (${aiRuns.status} in ('running','waiting-approval') and ${aiRuns.leaseExpiresAt} < now())
          or (${aiRuns.status} = 'interrupted' and ${aiRuns.expiresAt} < now())`,
      )
      .limit(limit)) as RunRow[];
  }

  async expiredConversations(limit = 32): Promise<ConversationRow[]> {
    return (await this.db
      .select()
      .from(aiConversations)
      .where(
        and(
          lt(aiConversations.expiresAt, new Date()),
          sql`${aiConversations.expiresAt} is not null`,
        ),
      )
      .limit(limit)) as ConversationRow[];
  }

  async listConversationsByIds(tx: Tx, userId: string, ids: string[]): Promise<ConversationRow[]> {
    return (await tx
      .select()
      .from(aiConversations)
      .where(
        and(eq(aiConversations.userId, userId), inArray(aiConversations.id, ids)),
      )) as ConversationRow[];
  }

  /**
   * Reference-ordered GC. Unsettled work (active Runs, unknown image results, unconfirmed
   * proposal applications) blocks deletion instead of cascading; the caller retries later.
   * Returns false when the conversation was retained.
   */
  async deleteConversationRows(tx: Tx, userId: string, conversationId: string): Promise<boolean> {
    const scope = and(eq(aiRuns.userId, userId), eq(aiRuns.conversationId, conversationId));
    const activeRuns = await tx
      .select({ id: aiRuns.id })
      .from(aiRuns)
      .where(
        and(
          scope,
          inArray(aiRuns.status, ["queued", "running", "waiting-approval", "interrupted"]),
        ),
      )
      .limit(1);
    if (activeRuns.length) return false;
    const unknownJobs = await tx
      .select({ id: aiImageJobs.id })
      .from(aiImageJobs)
      .where(
        and(
          eq(aiImageJobs.userId, userId),
          eq(aiImageJobs.conversationId, conversationId),
          eq(aiImageJobs.status, "unknown"),
        ),
      )
      .limit(1);
    if (unknownJobs.length) return false;
    const unconfirmedProposals = await tx
      .select({ id: aiArtifacts.id })
      .from(aiArtifacts)
      .where(
        and(
          eq(aiArtifacts.userId, userId),
          eq(aiArtifacts.conversationId, conversationId),
          inArray(aiArtifacts.applicationState, ["pending", "partial", "unknown"]),
        ),
      )
      .limit(1);
    if (unconfirmedProposals.length) return false;
    // Native sessions and image jobs reference Runs/conversations: release them before parents.
    await tx
      .delete(aiImageJobs)
      .where(and(eq(aiImageJobs.userId, userId), eq(aiImageJobs.conversationId, conversationId)));
    await tx
      .delete(aiSessions)
      .where(and(eq(aiSessions.userId, userId), eq(aiSessions.conversationId, conversationId)));
    await tx
      .delete(aiArtifacts)
      .where(and(eq(aiArtifacts.userId, userId), eq(aiArtifacts.conversationId, conversationId)));
    await tx
      .delete(aiMessages)
      .where(and(eq(aiMessages.userId, userId), eq(aiMessages.conversationId, conversationId)));
    await tx
      .delete(aiEvents)
      .where(and(eq(aiEvents.userId, userId), eq(aiEvents.conversationId, conversationId)));
    await tx.delete(aiRuns).where(scope);
    await tx
      .delete(aiConversations)
      .where(and(eq(aiConversations.userId, userId), eq(aiConversations.id, conversationId)));
    return true;
  }
}
