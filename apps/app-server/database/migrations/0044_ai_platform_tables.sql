CREATE TABLE "ai_artifacts" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"purpose" text NOT NULL,
	"producer_call_id" text NOT NULL,
	"result_index" integer NOT NULL,
	"kind" text NOT NULL,
	"schema_version" integer NOT NULL,
	"state" text NOT NULL,
	"payload" jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_revision" integer,
	"review" jsonb,
	"application_state" text,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_artifacts_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "ai_artifacts_kind_check" CHECK ("ai_artifacts"."kind" in ('evidence','draft','proposal','image')),
	CONSTRAINT "ai_artifacts_purpose_check" CHECK ("ai_artifacts"."purpose" in ('qa','writing')),
	CONSTRAINT "ai_artifacts_state_check" CHECK ("ai_artifacts"."state" in ('staged','committed','withdrawn')),
	CONSTRAINT "ai_artifacts_qa_kind_check" CHECK ("ai_artifacts"."purpose" <> 'qa' or "ai_artifacts"."kind" = 'evidence'),
	CONSTRAINT "ai_artifacts_proposal_fields_check" CHECK (("ai_artifacts"."kind" = 'proposal' and "ai_artifacts"."application_state" is not null) or ("ai_artifacts"."kind" <> 'proposal' and "ai_artifacts"."application_state" is null and "ai_artifacts"."review" is null and "ai_artifacts"."review_revision" is null and "ai_artifacts"."receipt" is null)),
	CONSTRAINT "ai_artifacts_application_state_check" CHECK ("ai_artifacts"."application_state" is null or "ai_artifacts"."application_state" in ('pending','partial','applied','rejected','conflict','unknown'))
);--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"identity_id" text,
	"visitor_id" text,
	"site_id" text,
	"scope_selection" jsonb NOT NULL,
	"context_revision" integer DEFAULT 1 NOT NULL,
	"target_document_id" text,
	"configuration_id" text,
	"creation_key" text,
	"origin" jsonb,
	"event_sequence" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "ai_conversations_purpose_check" CHECK ("ai_conversations"."purpose" in ('qa', 'writing')),
	CONSTRAINT "ai_conversations_owner_check" CHECK (("ai_conversations"."identity_id" is not null) <> ("ai_conversations"."visitor_id" is not null)),
	CONSTRAINT "ai_conversations_visitor_site_check" CHECK ("ai_conversations"."visitor_id" is null or "ai_conversations"."site_id" is not null),
	CONSTRAINT "ai_conversations_site_purpose_check" CHECK ("ai_conversations"."site_id" is null or "ai_conversations"."purpose" = 'qa'),
	CONSTRAINT "ai_conversations_target_purpose_check" CHECK ("ai_conversations"."target_document_id" is null or "ai_conversations"."purpose" = 'writing'),
	CONSTRAINT "ai_conversations_context_revision_check" CHECK ("ai_conversations"."context_revision" >= 1),
	CONSTRAINT "ai_conversations_status_check" CHECK ("ai_conversations"."status" in ('active','target-unavailable','closed'))
);--> statement-breakpoint
CREATE TABLE "ai_events" (
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_events_tenant_id_conversation_id_sequence_pk" PRIMARY KEY("tenant_id","conversation_id","sequence"),
	CONSTRAINT "ai_events_type_check" CHECK ("ai_events"."type" in ('message.created','run.updated','artifact.created','artifact.application-updated','scope.changed')),
	CONSTRAINT "ai_events_sequence_check" CHECK ("ai_events"."sequence" > 0)
);--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"client_message_id" text,
	"state" text NOT NULL,
	"generation_attempt" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	CONSTRAINT "ai_messages_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "ai_messages_role_check" CHECK ("ai_messages"."role" in ('user','assistant')),
	CONSTRAINT "ai_messages_state_check" CHECK ("ai_messages"."state" in ('staged','committed','withdrawn')),
	CONSTRAINT "ai_messages_client_role_check" CHECK ("ai_messages"."client_message_id" is null or "ai_messages"."role" = 'user'),
	CONSTRAINT "ai_messages_committed_at_check" CHECK ("ai_messages"."state" = 'committed' or "ai_messages"."committed_at" is null)
);--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"purpose" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"context" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"fencing_token" bigint,
	"execution" jsonb,
	"usage" jsonb NOT NULL,
	"error_code" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_runs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "ai_runs_status_check" CHECK ("ai_runs"."status" in ('queued','running','waiting-approval','completed','interrupted','failed','cancelled')),
	CONSTRAINT "ai_runs_attempt_check" CHECK ("ai_runs"."attempt" > 0),
	CONSTRAINT "ai_runs_purpose_check" CHECK ("ai_runs"."purpose" in ('qa','writing')),
	CONSTRAINT "ai_runs_waiting_approval_purpose_check" CHECK ("ai_runs"."status" <> 'waiting-approval' or "ai_runs"."purpose" = 'writing'),
	CONSTRAINT "ai_runs_input_hash_check" CHECK ("ai_runs"."input_hash" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "ai_runs_error_code_check" CHECK ("ai_runs"."error_code" is null or "ai_runs"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);--> statement-breakpoint
CREATE TABLE "qa_site_documents" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"source_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"document_id" text NOT NULL,
	"approved_by" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"suspension_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_site_documents_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "qa_site_documents_state_check" CHECK ("qa_site_documents"."state" in ('active','suspended')),
	CONSTRAINT "qa_site_documents_suspension_check" CHECK ("qa_site_documents"."state" <> 'suspended' or "qa_site_documents"."suspension_reason" is not null)
);--> statement-breakpoint
CREATE TABLE "qa_site_sources" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"site_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"public_label" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_site_sources_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);--> statement-breakpoint
CREATE TABLE "qa_sites" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"welcome" text DEFAULT '' NOT NULL,
	"suggested_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_mode" text DEFAULT 'public' NOT NULL,
	"access_code_hash" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"access_revision" integer DEFAULT 1 NOT NULL,
	"quota_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qa_sites_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "qa_sites_access_mode_check" CHECK ("qa_sites"."access_mode" in ('public','code')),
	CONSTRAINT "qa_sites_access_code_check" CHECK ("qa_sites"."access_mode" <> 'code' or "qa_sites"."access_code_hash" is not null),
	CONSTRAINT "qa_sites_status_check" CHECK ("qa_sites"."status" in ('draft','pending','active','paused','disabled')),
	CONSTRAINT "qa_sites_revision_check" CHECK ("qa_sites"."revision" >= 1 and "qa_sites"."access_revision" >= 1)
);--> statement-breakpoint
CREATE TABLE "writing_image_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"purpose" text DEFAULT 'writing' NOT NULL,
	"tool_call_id" text NOT NULL,
	"status" text NOT NULL,
	"asset_id" text,
	"provider_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writing_image_jobs_purpose_check" CHECK ("writing_image_jobs"."purpose" = 'writing'),
	CONSTRAINT "writing_image_jobs_status_check" CHECK ("writing_image_jobs"."status" in ('pending','unknown','ready','failed')),
	CONSTRAINT "writing_image_jobs_ready_check" CHECK ("writing_image_jobs"."status" <> 'ready' or "writing_image_jobs"."asset_id" is not null)
);--> statement-breakpoint
CREATE TABLE "writing_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"purpose" text DEFAULT 'writing' NOT NULL,
	"context_revision" integer NOT NULL,
	"header" jsonb NOT NULL,
	"inherited_event_count" bigint NOT NULL,
	"events" jsonb NOT NULL,
	"next_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "writing_sessions_purpose_check" CHECK ("writing_sessions"."purpose" = 'writing'),
	CONSTRAINT "writing_sessions_revision_check" CHECK ("writing_sessions"."context_revision" >= 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_artifacts_producer_result_uq" ON "ai_artifacts" USING btree ("tenant_id","run_id","producer_call_id","result_index");--> statement-breakpoint
CREATE INDEX "ai_artifacts_conversation_kind_idx" ON "ai_artifacts" USING btree ("tenant_id","conversation_id","kind","state");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_tenant_id_purpose_uq" ON "ai_conversations" USING btree ("tenant_id","id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_identity_creation_uq" ON "ai_conversations" USING btree ("tenant_id","identity_id","purpose",coalesce("site_id", ''),"creation_key") WHERE "ai_conversations"."creation_key" is not null and "ai_conversations"."identity_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversations_visitor_creation_uq" ON "ai_conversations" USING btree ("tenant_id","visitor_id","purpose","site_id","creation_key") WHERE "ai_conversations"."creation_key" is not null and "ai_conversations"."visitor_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_conversations_identity_recent_idx" ON "ai_conversations" USING btree ("tenant_id","identity_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ai_conversations_site_idx" ON "ai_conversations" USING btree ("tenant_id","site_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ai_conversations_expires_idx" ON "ai_conversations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_client_id_uq" ON "ai_messages" USING btree ("tenant_id","conversation_id","client_message_id") WHERE "ai_messages"."client_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_run_user_uq" ON "ai_messages" USING btree ("tenant_id","conversation_id","run_id") WHERE "ai_messages"."role" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_run_assistant_uq" ON "ai_messages" USING btree ("tenant_id","conversation_id","run_id") WHERE "ai_messages"."role" = 'assistant';--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_page_idx" ON "ai_messages" USING btree ("tenant_id","conversation_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_tenant_conversation_id_uq" ON "ai_runs" USING btree ("tenant_id","conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_tenant_conversation_id_purpose_uq" ON "ai_runs" USING btree ("tenant_id","conversation_id","id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_idempotency_uq" ON "ai_runs" USING btree ("tenant_id","conversation_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_conversation_active_uq" ON "ai_runs" USING btree ("tenant_id","conversation_id") WHERE "ai_runs"."status" in ('running','waiting-approval');--> statement-breakpoint
CREATE INDEX "ai_runs_conversation_recent_idx" ON "ai_runs" USING btree ("tenant_id","conversation_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ai_runs_expiry_idx" ON "ai_runs" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "ai_runs_lease_idx" ON "ai_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "ai_runs_purpose_created_idx" ON "ai_runs" USING btree ("tenant_id","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_site_documents_source_document_uq" ON "qa_site_documents" USING btree ("tenant_id","source_id","document_id");--> statement-breakpoint
CREATE INDEX "qa_site_documents_document_idx" ON "qa_site_documents" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE INDEX "qa_site_documents_workspace_idx" ON "qa_site_documents" USING btree ("tenant_id","workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_site_sources_site_workspace_uq" ON "qa_site_sources" USING btree ("tenant_id","site_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_site_sources_tenant_id_workspace_uq" ON "qa_site_sources" USING btree ("tenant_id","id","workspace_id");--> statement-breakpoint
CREATE INDEX "qa_site_sources_workspace_idx" ON "qa_site_sources" USING btree ("tenant_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_sites_slug_uq" ON "qa_sites" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "qa_sites_id_uq" ON "qa_sites" USING btree ("id");--> statement-breakpoint
CREATE INDEX "qa_sites_tenant_idx" ON "qa_sites" USING btree ("tenant_id","owner_workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "writing_image_jobs_run_tool_uq" ON "writing_image_jobs" USING btree ("tenant_id","run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "writing_image_jobs_conversation_idx" ON "writing_image_jobs" USING btree ("tenant_id","conversation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "writing_sessions_conversation_revision_uq" ON "writing_sessions" USING btree ("tenant_id","conversation_id","context_revision");--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD CONSTRAINT "ai_artifacts_run_fk" FOREIGN KEY ("tenant_id","conversation_id","run_id","purpose") REFERENCES "public"."ai_runs"("tenant_id","conversation_id","id","purpose") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_identity_fk" FOREIGN KEY ("tenant_id","identity_id") REFERENCES "public"."identity_profiles"("tenant_id","identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."qa_sites"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_target_document_fk" FOREIGN KEY ("tenant_id","target_document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_events" ADD CONSTRAINT "ai_events_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."ai_conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."ai_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_run_fk" FOREIGN KEY ("tenant_id","conversation_id","run_id") REFERENCES "public"."ai_runs"("tenant_id","conversation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id","purpose") REFERENCES "public"."ai_conversations"("tenant_id","id","purpose") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_site_documents" ADD CONSTRAINT "qa_site_documents_source_fk" FOREIGN KEY ("tenant_id","source_id","workspace_id") REFERENCES "public"."qa_site_sources"("tenant_id","id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_site_documents" ADD CONSTRAINT "qa_site_documents_document_fk" FOREIGN KEY ("tenant_id","workspace_id","document_id") REFERENCES "public"."documents"("tenant_id","workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_site_sources" ADD CONSTRAINT "qa_site_sources_site_fk" FOREIGN KEY ("tenant_id","site_id") REFERENCES "public"."qa_sites"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_site_sources" ADD CONSTRAINT "qa_site_sources_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_sites" ADD CONSTRAINT "qa_sites_owner_workspace_fk" FOREIGN KEY ("tenant_id","owner_workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writing_image_jobs" ADD CONSTRAINT "writing_image_jobs_run_fk" FOREIGN KEY ("tenant_id","conversation_id","run_id","purpose") REFERENCES "public"."ai_runs"("tenant_id","conversation_id","id","purpose") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "writing_sessions" ADD CONSTRAINT "writing_sessions_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id","purpose") REFERENCES "public"."ai_conversations"("tenant_id","id","purpose") ON DELETE no action ON UPDATE no action;
