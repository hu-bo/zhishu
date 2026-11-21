import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ImageJob } from "@zhishu/ai-plugins/contracts";
import { aiConversations, aiRuns } from "./ai.table.js";

/**
 * Native DSH Session logs for every assistant conversation. Official SDK owns header/events
 * formats; rows exist only for native recovery and product projection, never a second
 * writable product snapshot, and are never directly readable by clients.
 */
export const aiSessions = pgTable(
  "ai_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    contextRevision: integer("context_revision").notNull(),
    header: jsonb("header").notNull(),
    inheritedEventCount: bigint("inherited_event_count", { mode: "number" }).notNull(),
    events: jsonb("events").notNull(),
    nextSeq: bigint("next_seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_sessions_conversation_revision_uq").on(
      t.tenantId,
      t.conversationId,
      t.contextRevision,
    ),
    foreignKey({
      name: "ai_sessions_conversation_fk",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [aiConversations.tenantId, aiConversations.id],
    }),
    check("ai_sessions_revision_check", sql`${t.contextRevision} >= 1`),
  ],
);

/**
 * External image side effects for internal conversations with the image plugin enabled.
 * The image artifact references job/asset identities; long base64 payloads and signed URLs
 * never enter messages or native logs.
 */
export const aiImageJobs = pgTable(
  "ai_image_jobs",
  {
    /** Server key `${runId}:${toolCallId}`; the provider job id lives inside providerResult. */
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    status: text("status").$type<ImageJob["status"]>().notNull(),
    assetId: text("asset_id"),
    // Bounded provider output and failure detail awaiting reconciliation; never in chat or native logs.
    providerResult: jsonb("provider_result").$type<unknown>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ai_image_jobs_run_tool_uq").on(t.tenantId, t.runId, t.toolCallId),
    foreignKey({
      name: "ai_image_jobs_run_fk",
      columns: [t.tenantId, t.conversationId, t.runId],
      foreignColumns: [aiRuns.tenantId, aiRuns.conversationId, aiRuns.id],
    }),
    check("ai_image_jobs_status_check", sql`${t.status} in ('pending','unknown','ready','failed')`),
    check("ai_image_jobs_ready_check", sql`${t.status} <> 'ready' or ${t.assetId} is not null`),
    index("ai_image_jobs_conversation_idx").on(t.tenantId, t.conversationId, t.status),
  ],
);
