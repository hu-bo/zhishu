CREATE TABLE "collaboration_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"update_hash" text NOT NULL,
	"update_bytes" "bytea" NOT NULL,
	"durable_seq" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"extensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"durable_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collaboration_updates" ADD CONSTRAINT "collaboration_updates_generation_id_document_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."document_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_generations" ADD CONSTRAINT "document_generations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_updates_generation_hash_uq" ON "collaboration_updates" USING btree ("generation_id","update_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_updates_generation_seq_uq" ON "collaboration_updates" USING btree ("generation_id","durable_seq");--> statement-breakpoint
CREATE INDEX "collaboration_updates_document_generation_seq_idx" ON "collaboration_updates" USING btree ("document_id","generation_id","durable_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "document_generations_document_id_id_uq" ON "document_generations" USING btree ("document_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_generations_one_active_per_document_uq" ON "document_generations" USING btree ("document_id") WHERE "document_generations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "document_generations_document_created_idx" ON "document_generations" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_tenant_created_idx" ON "documents" USING btree ("tenant_id","created_at","id");