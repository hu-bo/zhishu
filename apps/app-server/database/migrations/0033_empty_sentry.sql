ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_application_check";--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "ai_runs" DROP COLUMN "auto_apply_blocked";--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_application_check" CHECK ("ai_runs"."application_state" in ('none','pending','partial','rejected','applied','conflict','blocked'));