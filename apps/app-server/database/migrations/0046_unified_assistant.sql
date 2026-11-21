-- Unified DSH assistant: remove the qa/writing purpose fork, generalize the native session
-- and image job tables, and rebuild tenant/session composite foreign keys without purpose.
-- Forward-only: published 0042-0045 are never rewritten. Completed history keeps its original
-- conversationId; unfinished legacy runs become explicit interruptions for the new runtime.

-- A. Migration audit export of cross-purpose handoff origins (not a business table).
-- Read/dropped by the explicit ai:audit-origins script; never parsed by the runtime.
CREATE TABLE "legacy_ai_conversation_origins" AS
SELECT "tenant_id", "id" AS "conversation_id", "purpose", "origin", "created_at"
FROM "ai_conversations"
WHERE "origin" IS NOT NULL;--> statement-breakpoint

-- B. Unfinished legacy flows are explicitly interrupted; inputs, evidence, drafts, receipts
-- and unknown costs stay on the row. New retries use the current runtime only.
UPDATE "ai_runs"
SET "status" = 'interrupted',
    "error_code" = 'LEGACY_INTERRUPTED',
    "lease_owner" = NULL,
    "lease_expires_at" = NULL,
    "updated_at" = now()
WHERE "status" IN ('queued','running','waiting-approval');--> statement-breakpoint

-- C. Normalize Run contexts to the unified acceptance shape (command/intent/plugins), keeping
-- the original scope, capture, request and reference identities. Historical rows stay auditable.
UPDATE "ai_runs" r
SET "context" = jsonb_strip_nulls(jsonb_build_object(
    'contextRevision', r."context"->'contextRevision',
    'configurationId', r."context"->'configurationId',
    'command', 'chat',
    'intentHint', CASE WHEN r."purpose" = 'qa' THEN 'qa' ELSE 'writing' END,
    'plugins', CASE WHEN r."purpose" = 'qa' THEN '["scope","rag"]'::jsonb ELSE '["scope","rag","research","writing"]'::jsonb END,
    'scope', coalesce(r."context"->'scope', c."scope_selection"),
    'webSearch', coalesce(r."context"->'webSearch', 'false'::jsonb),
    'capture', r."context"->'capture',
    'request', r."context"->'request',
    'referenceArtifactIds', r."context"->'referenceArtifactIds'
))
FROM "ai_conversations" c
WHERE c."tenant_id" = r."tenant_id" AND c."id" = r."conversation_id";--> statement-breakpoint

-- D. Normalize execution ledgers to the unified shape; drop retired QA-only fields.
UPDATE "ai_runs"
SET "execution" = jsonb_strip_nulls(jsonb_build_object(
    'nativeSessionId', "execution"->'nativeSessionId',
    'nativeMessageId', "execution"->'nativeMessageId',
    'deliveryConfirmed', "execution"->'deliveryConfirmed',
    'turn', "execution"->'turn',
    'approval', "execution"->'approval',
    'evidenceRefs', coalesce("execution"->'evidenceRefs', '[]'::jsonb),
    'evidenceArtifactIds', coalesce("execution"->'evidenceArtifactIds', '[]'::jsonb),
    'proposalArtifactIds', coalesce("execution"->'proposalArtifactIds', '[]'::jsonb),
    'stagedMessageId', "execution"->'stagedMessageId',
    'steps', coalesce("execution"->'steps', '[]'::jsonb)
))
WHERE "execution" IS NOT NULL;--> statement-breakpoint

-- E. Drop purpose-aligned foreign keys before removing the column.
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_conversation_fk";--> statement-breakpoint
ALTER TABLE "ai_artifacts" DROP CONSTRAINT "ai_artifacts_run_fk";--> statement-breakpoint
ALTER TABLE "writing_sessions" DROP CONSTRAINT "writing_sessions_conversation_fk";--> statement-breakpoint
ALTER TABLE "writing_image_jobs" DROP CONSTRAINT "writing_image_jobs_run_fk";--> statement-breakpoint

-- F. Drop purpose-era indexes and checks.
DROP INDEX "ai_conversations_tenant_id_purpose_uq";--> statement-breakpoint
DROP INDEX "ai_runs_tenant_conversation_id_purpose_uq";--> statement-breakpoint
DROP INDEX "ai_runs_purpose_created_idx";--> statement-breakpoint
DROP INDEX "ai_conversations_identity_creation_uq";--> statement-breakpoint
DROP INDEX "ai_conversations_visitor_creation_uq";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP CONSTRAINT "ai_conversations_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP CONSTRAINT "ai_conversations_site_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP CONSTRAINT "ai_conversations_target_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_waiting_approval_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_artifacts" DROP CONSTRAINT "ai_artifacts_purpose_check";--> statement-breakpoint
ALTER TABLE "ai_artifacts" DROP CONSTRAINT "ai_artifacts_qa_kind_check";--> statement-breakpoint
ALTER TABLE "writing_sessions" DROP CONSTRAINT "writing_sessions_purpose_check";--> statement-breakpoint
ALTER TABLE "writing_image_jobs" DROP CONSTRAINT "writing_image_jobs_purpose_check";--> statement-breakpoint

-- G. Remove the purpose fork and the retired handoff origin column.
ALTER TABLE "ai_conversations" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP COLUMN "origin";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "ai_artifacts" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "writing_sessions" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "writing_image_jobs" DROP COLUMN "purpose";--> statement-breakpoint

-- H. Generalize the native session and image job tables (rename, keep every row).
ALTER TABLE "writing_sessions" RENAME TO "ai_sessions";--> statement-breakpoint
ALTER TABLE "writing_image_jobs" RENAME TO "ai_image_jobs";--> statement-breakpoint
ALTER TABLE "ai_sessions" RENAME CONSTRAINT "writing_sessions_pkey" TO "ai_sessions_pkey";--> statement-breakpoint
ALTER TABLE "ai_sessions" RENAME CONSTRAINT "writing_sessions_revision_check" TO "ai_sessions_revision_check";--> statement-breakpoint
ALTER INDEX "writing_sessions_conversation_revision_uq" RENAME TO "ai_sessions_conversation_revision_uq";--> statement-breakpoint
ALTER TABLE "ai_image_jobs" RENAME CONSTRAINT "writing_image_jobs_pkey" TO "ai_image_jobs_pkey";--> statement-breakpoint
ALTER TABLE "ai_image_jobs" RENAME CONSTRAINT "writing_image_jobs_status_check" TO "ai_image_jobs_status_check";--> statement-breakpoint
ALTER TABLE "ai_image_jobs" RENAME CONSTRAINT "writing_image_jobs_ready_check" TO "ai_image_jobs_ready_check";--> statement-breakpoint
ALTER INDEX "writing_image_jobs_run_tool_uq" RENAME TO "ai_image_jobs_run_tool_uq";--> statement-breakpoint
ALTER INDEX "writing_image_jobs_conversation_idx" RENAME TO "ai_image_jobs_conversation_idx";--> statement-breakpoint

-- I. Rebuild tenant/session composite foreign keys without purpose.
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "ai_conversations"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD CONSTRAINT "ai_artifacts_run_fk" FOREIGN KEY ("tenant_id","conversation_id","run_id") REFERENCES "ai_runs"("tenant_id","conversation_id","id");--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "ai_conversations"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "ai_image_jobs" ADD CONSTRAINT "ai_image_jobs_run_fk" FOREIGN KEY ("tenant_id","conversation_id","run_id") REFERENCES "ai_runs"("tenant_id","conversation_id","id");--> statement-breakpoint

-- J. Public site conversations never carry an editor target; creation dedup keeps working
-- for internal (NULL site) and visitor entries without a purpose component.
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_site_target_check" CHECK ("site_id" is null or "target_document_id" is null);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_identity_creation_uq" ON "ai_conversations" ("tenant_id","identity_id",coalesce("site_id", ''),"creation_key") WHERE "creation_key" is not null and "identity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_visitor_creation_uq" ON "ai_conversations" ("tenant_id","visitor_id","site_id","creation_key") WHERE "creation_key" is not null and "visitor_id" is not null;--> statement-breakpoint

-- K. The product outbox gains the conversation binding event.
ALTER TABLE "ai_events" DROP CONSTRAINT "ai_events_type_check";--> statement-breakpoint
ALTER TABLE "ai_events" ADD CONSTRAINT "ai_events_type_check" CHECK ("type" in ('message.created','run.updated','artifact.created','artifact.application-updated','scope.changed','conversation.updated'));