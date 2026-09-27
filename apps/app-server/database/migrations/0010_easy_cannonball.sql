CREATE TABLE "document_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"durable_seq" bigint NOT NULL,
	"event_type" text DEFAULT 'document.update' NOT NULL,
	"update_hash" text NOT NULL,
	"content_changed" boolean NOT NULL,
	"summary" jsonb NOT NULL,
	"snapshot_content" jsonb,
	"content_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_token" uuid,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "document_outbox_seq_check" CHECK ("document_outbox"."durable_seq" > 0),
	CONSTRAINT "document_outbox_event_type_check" CHECK ("document_outbox"."event_type" = 'document.update'),
	CONSTRAINT "document_outbox_status_check" CHECK ("document_outbox"."status" in ('pending', 'processing', 'done', 'dead')),
	CONSTRAINT "document_outbox_attempts_check" CHECK ("document_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_projection_snapshots" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"durable_seq" bigint NOT NULL,
	"snapshot_revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"block_count" integer NOT NULL,
	"text_length" integer NOT NULL,
	"asset_count" integer NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_projection_snapshots_tenant_id_document_id_generation_id_pk" PRIMARY KEY("tenant_id","document_id","generation_id"),
	CONSTRAINT "document_projection_snapshots_seq_check" CHECK ("document_projection_snapshots"."durable_seq" >= 0),
	CONSTRAINT "document_projection_snapshots_revision_check" CHECK ("document_projection_snapshots"."snapshot_revision" > 0),
	CONSTRAINT "document_projection_snapshots_summary_check" CHECK ("document_projection_snapshots"."block_count" >= 0 and "document_projection_snapshots"."text_length" >= 0 and "document_projection_snapshots"."asset_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_outbox" ADD CONSTRAINT "document_outbox_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_outbox" ADD CONSTRAINT "document_outbox_generation_fk" FOREIGN KEY ("document_id","generation_id") REFERENCES "public"."document_generations"("document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_outbox" ADD CONSTRAINT "document_outbox_update_fk" FOREIGN KEY ("generation_id","durable_seq") REFERENCES "public"."collaboration_updates"("generation_id","durable_seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_projection_snapshots" ADD CONSTRAINT "document_projection_snapshots_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_projection_snapshots" ADD CONSTRAINT "document_projection_snapshots_generation_fk" FOREIGN KEY ("document_id","generation_id") REFERENCES "public"."document_generations"("document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_outbox_generation_seq_type_uq" ON "document_outbox" USING btree ("generation_id","durable_seq","event_type");--> statement-breakpoint
CREATE INDEX "document_outbox_ready_idx" ON "document_outbox" USING btree ("status","available_at","created_at");