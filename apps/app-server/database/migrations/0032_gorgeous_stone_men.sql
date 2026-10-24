CREATE TABLE "ai_runs" (
	"tenant_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"request_id" text NOT NULL,
	"document_id" text,
	"input_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"owner_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"auto_apply_blocked" boolean DEFAULT false NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"usage" jsonb NOT NULL,
	"error_code" text,
	"application_state" text DEFAULT 'none' NOT NULL,
	"application_code" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_runs_tenant_id_subject_id_request_id_pk" PRIMARY KEY("tenant_id","subject_id","request_id"),
	CONSTRAINT "ai_runs_status_check" CHECK ("ai_runs"."status" in ('running','interrupted','completed','failed','cancelled')),
	CONSTRAINT "ai_runs_result_check" CHECK (("ai_runs"."status" = 'completed') = ("ai_runs"."result" is not null)),
	CONSTRAINT "ai_runs_application_check" CHECK ("ai_runs"."application_state" in ('none','pending','applied','conflict','blocked')),
	CONSTRAINT "ai_runs_attempt_check" CHECK ("ai_runs"."attempt" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_subject_running_uq" ON "ai_runs" USING btree ("tenant_id","subject_id") WHERE "ai_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "ai_runs_expires_idx" ON "ai_runs" USING btree ("expires_at");