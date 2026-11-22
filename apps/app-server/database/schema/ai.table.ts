import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  AssistantExecution,
  AssistantRunContext,
  EvidenceRef,
  ProposalApplicationState,
  ProposalReview,
  RunUsage,
  ScopeSelection,
} from "@zhishu/ai-contracts";
import type { StructureReceipt } from "@zhishu/document-contracts";
import type { MessagePart, RunStatus } from "@zhishu/chat-contracts";
import { documents, identityProfiles } from "./document.table.js";
import { qaSites } from "./qa-site.table.js";

/**
 * Shared assistant product storage. One conversation combines question answering, research
 * and writing; the accepted command/intent lives in the Run context, never in a purpose
 * column. Column types import from the pure contracts only; no server module or engine
 * package may be referenced from here.
 */

export const aiConversations = pgTable(
  "ai_conversations",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    identityId: text("identity_id"),
    visitorId: text("visitor_id"),
    siteId: text("site_id"),
    scopeSelection: jsonb("scope_selection").$type<ScopeSelection>().notNull(),
    contextRevision: integer("context_revision").notNull().default(1),
    targetDocumentId: text("target_document_id"),
    configurationId: text("configuration_id"),
    /** Dedup key for session creation; NULLs excluded by partial indexes. */
    creationKey: text("creation_key"),
    eventSequence: bigint("event_sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    status: text("status")
      .$type<"active" | "target-unavailable" | "closed">()
      .notNull()
      .default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: "ai_conversations_identity_fk",
      columns: [t.userId, t.identityId],
      foreignColumns: [identityProfiles.userId, identityProfiles.identityId],
    }),
    foreignKey({
      name: "ai_conversations_site_fk",
      columns: [t.userId, t.siteId],
      foreignColumns: [qaSites.userId, qaSites.id],
    }),
    foreignKey({
      name: "ai_conversations_target_document_fk",
      columns: [t.userId, t.targetDocumentId],
      foreignColumns: [documents.userId, documents.id],
    }),
    check(
      "ai_conversations_owner_check",
      sql`(${t.identityId} is not null) <> (${t.visitorId} is not null)`,
    ),
    check(
      "ai_conversations_visitor_site_check",
      sql`${t.visitorId} is null or ${t.siteId} is not null`,
    ),
    // Public site conversations are read-only approved material: never an editor target.
    check(
      "ai_conversations_site_target_check",
      sql`${t.siteId} is null or ${t.targetDocumentId} is null`,
    ),
    check("ai_conversations_context_revision_check", sql`${t.contextRevision} >= 1`),
    check(
      "ai_conversations_status_check",
      sql`${t.status} in ('active','target-unavailable','closed')`,
    ),
    // Creation dedup runs separately for internal owners and public visitors. The coalesce
    // expressions make a NULL siteId an explicit part of the internal-entry tuple so public
    // and internal contexts can never collide (NULLS NOT DISTINCT emulation for pg-core).
    uniqueIndex("ai_conversations_identity_creation_uq")
      .on(t.userId, t.identityId, sql`coalesce(${t.siteId}, '')`, t.creationKey)
      .where(sql`${t.creationKey} is not null and ${t.identityId} is not null`),
    uniqueIndex("ai_conversations_visitor_creation_uq")
      .on(t.userId, t.visitorId, t.siteId, t.creationKey)
      .where(sql`${t.creationKey} is not null and ${t.visitorId} is not null`),
    index("ai_conversations_identity_recent_idx").on(t.userId, t.identityId, t.createdAt, t.id),
    index("ai_conversations_site_idx").on(t.userId, t.siteId, t.createdAt, t.id),
    index("ai_conversations_expires_idx").on(t.expiresAt),
  ],
);

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    context: jsonb("context").$type<AssistantRunContext>().notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    attempt: integer("attempt").notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fencingToken: bigint("fencing_token", { mode: "bigint" }),
    execution: jsonb("execution").$type<AssistantExecution>(),
    usage: jsonb("usage").$type<RunUsage>().notNull(),
    errorCode: text("error_code"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    uniqueIndex("ai_runs_user_conversation_id_uq").on(t.userId, t.conversationId, t.id),
    foreignKey({
      name: "ai_runs_conversation_fk",
      columns: [t.userId, t.conversationId],
      foreignColumns: [aiConversations.userId, aiConversations.id],
    }),
    uniqueIndex("ai_runs_idempotency_uq").on(t.userId, t.conversationId, t.idempotencyKey),
    // One executing run per conversation; queued rows are handled by the admission budget.
    uniqueIndex("ai_runs_conversation_active_uq")
      .on(t.userId, t.conversationId)
      .where(sql`${t.status} in ('running','waiting-approval')`),
    check(
      "ai_runs_status_check",
      sql`${t.status} in ('queued','running','waiting-approval','completed','interrupted','failed','cancelled')`,
    ),
    check("ai_runs_attempt_check", sql`${t.attempt} > 0`),
    check("ai_runs_input_hash_check", sql`${t.inputHash} ~ '^sha256:[a-f0-9]{64}$'`),
    check(
      "ai_runs_error_code_check",
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
    index("ai_runs_conversation_recent_idx").on(t.userId, t.conversationId, t.createdAt, t.id),
    index("ai_runs_expiry_idx").on(t.status, t.expiresAt),
    index("ai_runs_lease_idx").on(t.status, t.leaseExpiresAt),
  ],
);

export const aiMessages = pgTable(
  "ai_messages",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    role: text("role").$type<"user" | "assistant">().notNull(),
    parts: jsonb("parts").$type<MessagePart[]>().notNull(),
    clientMessageId: text("client_message_id"),
    state: text("state").$type<"staged" | "committed" | "withdrawn">().notNull(),
    /** Assistant generation attempt that wrote this body; with the Run fencing token it blocks stale writes. */
    generationAttempt: integer("generation_attempt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: "ai_messages_conversation_fk",
      columns: [t.userId, t.conversationId],
      foreignColumns: [aiConversations.userId, aiConversations.id],
    }),
    foreignKey({
      name: "ai_messages_run_fk",
      columns: [t.userId, t.conversationId, t.runId],
      foreignColumns: [aiRuns.userId, aiRuns.conversationId, aiRuns.id],
    }),
    uniqueIndex("ai_messages_client_id_uq")
      .on(t.userId, t.conversationId, t.clientMessageId)
      .where(sql`${t.clientMessageId} is not null`),
    uniqueIndex("ai_messages_run_user_uq")
      .on(t.userId, t.conversationId, t.runId)
      .where(sql`${t.role} = 'user'`),
    uniqueIndex("ai_messages_run_assistant_uq")
      .on(t.userId, t.conversationId, t.runId)
      .where(sql`${t.role} = 'assistant'`),
    check("ai_messages_role_check", sql`${t.role} in ('user','assistant')`),
    check("ai_messages_state_check", sql`${t.state} in ('staged','committed','withdrawn')`),
    check("ai_messages_client_role_check", sql`${t.clientMessageId} is null or ${t.role} = 'user'`),
    check(
      "ai_messages_committed_at_check",
      sql`${t.state} = 'committed' or ${t.committedAt} is null`,
    ),
    index("ai_messages_conversation_page_idx").on(t.userId, t.conversationId, t.createdAt, t.id),
  ],
);

export const aiArtifacts = pgTable(
  "ai_artifacts",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    /** Server execution identity (stepId/toolCallId); never model-authored. */
    producerCallId: text("producer_call_id").notNull(),
    resultIndex: integer("result_index").notNull(),
    kind: text("kind").$type<"evidence" | "draft" | "proposal" | "image">().notNull(),
    schemaVersion: integer("schema_version").notNull(),
    state: text("state").$type<"staged" | "committed" | "withdrawn">().notNull(),
    payload: jsonb("payload").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<EvidenceRef[]>().notNull().default([]),
    reviewRevision: integer("review_revision"),
    review: jsonb("review").$type<ProposalReview>(),
    applicationState: text("application_state").$type<ProposalApplicationState>(),
    receipt: jsonb("receipt").$type<StructureReceipt>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      name: "ai_artifacts_run_fk",
      columns: [t.userId, t.conversationId, t.runId],
      foreignColumns: [aiRuns.userId, aiRuns.conversationId, aiRuns.id],
    }),
    uniqueIndex("ai_artifacts_producer_result_uq").on(
      t.userId,
      t.runId,
      t.producerCallId,
      t.resultIndex,
    ),
    check("ai_artifacts_kind_check", sql`${t.kind} in ('evidence','draft','proposal','image')`),
    check("ai_artifacts_state_check", sql`${t.state} in ('staged','committed','withdrawn')`),
    check(
      "ai_artifacts_proposal_fields_check",
      sql`(${t.kind} = 'proposal' and ${t.applicationState} is not null) or (${t.kind} <> 'proposal' and ${t.applicationState} is null and ${t.review} is null and ${t.reviewRevision} is null and ${t.receipt} is null)`,
    ),
    check(
      "ai_artifacts_application_state_check",
      sql`${t.applicationState} is null or ${t.applicationState} in ('pending','partial','applied','rejected','conflict','unknown')`,
    ),
    index("ai_artifacts_conversation_kind_idx").on(t.userId, t.conversationId, t.kind, t.state),
  ],
);

export const aiEvents = pgTable(
  "ai_events",
  {
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    type: text("type")
      .$type<
        | "message.created"
        | "run.updated"
        | "artifact.created"
        | "artifact.application-updated"
        | "scope.changed"
        | "conversation.updated"
      >()
      .notNull(),
    entityId: text("entity_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.conversationId, t.sequence] }),
    foreignKey({
      name: "ai_events_conversation_fk",
      columns: [t.userId, t.conversationId],
      foreignColumns: [aiConversations.userId, aiConversations.id],
    }).onDelete("cascade"),
    check(
      "ai_events_type_check",
      sql`${t.type} in ('message.created','run.updated','artifact.created','artifact.application-updated','scope.changed','conversation.updated')`,
    ),
    check("ai_events_sequence_check", sql`${t.sequence} > 0`),
  ],
);
