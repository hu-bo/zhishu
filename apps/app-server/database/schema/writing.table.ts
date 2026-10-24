import { bigint, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { ChatRecord } from "@zhishu/dsh-agent";
import type { ChatEvent } from "@zhishu/chat-contracts";

export const writingConversations = pgTable("writing_conversations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subjectId: text("subject_id").notNull(),
  sourceDocumentIds: jsonb("source_document_ids").$type<string[]>().notNull(),
  sourceContext: jsonb("source_context")
    .$type<{ sourceVersions: { documentId: string; generationId: string; durableSeq: number }[] }>()
    .notNull(),
  state: jsonb("state").$type<ChatRecord>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const writingEvents = pgTable(
  "writing_events",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => writingConversations.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    event: jsonb("event").$type<ChatEvent>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.sequence] })],
);
export const writingSessions = pgTable("writing_sessions", {
  id: text("id").primaryKey(),
  header: jsonb("header").notNull(),
  inheritedEventCount: bigint("inherited_event_count", { mode: "number" }).notNull(),
  events: jsonb("events").notNull(),
  nextSeq: bigint("next_seq", { mode: "number" }).notNull(),
});
export const writingImageJobs = pgTable("writing_image_jobs", {
  key: text("key").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => writingConversations.id, { onDelete: "cascade" }),
  job: jsonb("job").notNull(),
  // Bounded provider output waiting for object storage; never part of chat or native logs.
  providerResult: jsonb("provider_result"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
