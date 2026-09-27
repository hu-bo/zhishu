CREATE TABLE "document_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"name" text NOT NULL,
	"durable_seq" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_durable_seq_check" CHECK ("document_versions"."durable_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_generation_fk" FOREIGN KEY ("document_id","generation_id") REFERENCES "public"."document_generations"("document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_name_uq" ON "document_versions" USING btree ("document_id","name");--> statement-breakpoint
CREATE INDEX "document_versions_document_created_idx" ON "document_versions" USING btree ("tenant_id","document_id","created_at");