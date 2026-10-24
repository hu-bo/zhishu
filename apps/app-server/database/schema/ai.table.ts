import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
  AiTaskRequestV2,
  AuthoringProposal,
  ChatResult,
  EvidenceBundle,
  ReplacementReview,
} from "@zhishu/ai-contracts";
import type { DocumentSnapshot } from "@zhishu/document-contracts";
import type { StructureReceipt } from "../../src/modules/collaboration/owner.js";
import type { GenerationLimits } from "@zhishu/ai-runtime";
export type AiRunResult = AuthoringProposal | ChatResult;

export interface AiRunInput {
  /** Missing means the existing LangChain checkpoint protocol. */
  engine?: "dsh-v1" | "langchain-v1";
  request: AiTaskRequestV2;
  previousRequestIds: string[];
  sourceDocumentIds: string[];
  sourceVersions: { documentId: string; generationId: string; durableSeq: number }[];
  snapshot?: DocumentSnapshot & { generationId: string; durableSeq: number };
  evidence: EvidenceBundle;
  history: { role: "user" | "assistant"; content: string }[];
  modelVersion: string;
  limits: GenerationLimits;
}
export const aiRuns = pgTable(
  "ai_runs",
  {
    tenantId: text("tenant_id").notNull(),
    subjectId: text("subject_id").notNull(),
    requestId: text("request_id").notNull(),
    documentId: text("document_id"),
    inputHash: text("input_hash").notNull(),
    input: jsonb("input").$type<AiRunInput>().notNull(),
    status: text("status")
      .$type<"running" | "interrupted" | "completed" | "failed" | "cancelled">()
      .notNull(),
    ownerId: text("owner_id"),
    attempt: integer("attempt").notNull().default(1),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    result: jsonb("result").$type<AiRunResult>(),
    review: jsonb("review").$type<
      ReplacementReview & {
        receipts: Record<string, string>;
      }
    >(),
    usage: jsonb("usage")
      .$type<{
        modelCalls: number;
        inputTokens: number;
        outputTokens: number;
        searchCalls: number;
        sourceReads: number;
      }>()
      .notNull(),
    errorCode: text("error_code"),
    applicationState: text("application_state")
      .$type<"none" | "pending" | "partial" | "rejected" | "applied" | "conflict" | "blocked">()
      .notNull()
      .default("none"),
    applicationCode: text("application_code"),
    receipt: jsonb("receipt").$type<StructureReceipt>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.subjectId, t.requestId] }),
    uniqueIndex("ai_runs_subject_running_uq")
      .on(t.tenantId, t.subjectId)
      .where(sql`${t.status} = 'running'`),
    index("ai_runs_expires_idx").on(t.expiresAt),
    check(
      "ai_runs_status_check",
      sql`${t.status} in ('running','interrupted','completed','failed','cancelled')`,
    ),
    check("ai_runs_result_check", sql`(${t.status} = 'completed') = (${t.result} is not null)`),
    check(
      "ai_runs_application_check",
      sql`${t.applicationState} in ('none','pending','partial','rejected','applied','conflict','blocked')`,
    ),
    check("ai_runs_attempt_check", sql`${t.attempt} > 0`),
  ],
);
