-- One-time upgrade archive (explicit migration; never part of runtime code paths).
-- Copies every legacy AI row into backup tables that the following create/backfill steps
-- read from. Rows that cannot be mapped to the new model are later exported by
-- `pnpm --dir apps/app-server ai:audit-migration` from these tables, and the tables are
-- dropped at the end of 0045. Business data outside AI tables is untouched.
CREATE TABLE "legacy_ai_runs" (LIKE "ai_runs" INCLUDING ALL);
INSERT INTO "legacy_ai_runs" SELECT * FROM "ai_runs";--> statement-breakpoint
CREATE TABLE "legacy_writing_conversations" (LIKE "writing_conversations" INCLUDING ALL);
INSERT INTO "legacy_writing_conversations" SELECT * FROM "writing_conversations";--> statement-breakpoint
CREATE TABLE "legacy_writing_events" (LIKE "writing_events" INCLUDING ALL);
INSERT INTO "legacy_writing_events" SELECT * FROM "writing_events";--> statement-breakpoint
CREATE TABLE "legacy_writing_sessions" (LIKE "writing_sessions" INCLUDING ALL);
INSERT INTO "legacy_writing_sessions" SELECT * FROM "writing_sessions";--> statement-breakpoint
CREATE TABLE "legacy_writing_image_jobs" (LIKE "writing_image_jobs" INCLUDING ALL);
INSERT INTO "legacy_writing_image_jobs" SELECT * FROM "writing_image_jobs";
