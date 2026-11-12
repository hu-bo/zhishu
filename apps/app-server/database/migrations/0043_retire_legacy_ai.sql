ALTER TABLE "ai_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "writing_conversations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "writing_events" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "writing_image_jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "writing_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ai_runs" CASCADE;--> statement-breakpoint
DROP TABLE "projects" CASCADE;--> statement-breakpoint
DROP TABLE "writing_conversations" CASCADE;--> statement-breakpoint
DROP TABLE "writing_events" CASCADE;--> statement-breakpoint
DROP TABLE "writing_image_jobs" CASCADE;--> statement-breakpoint
DROP TABLE "writing_sessions" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_workspace_id_uq" ON "documents" USING btree ("tenant_id","workspace_id","id");
-- Retire the LangGraph checkpoint schema owned by the legacy engine (SDK-managed tables).
DROP SCHEMA IF EXISTS ai_checkpoint CASCADE;
