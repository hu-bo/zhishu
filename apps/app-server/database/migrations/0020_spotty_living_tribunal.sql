CREATE TABLE "document_migration_snapshots" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"migration_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"step_id" text NOT NULL,
	"summary" text NOT NULL,
	"from_schema_version" integer NOT NULL,
	"to_schema_version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_migration_snapshots_tenant_id_document_id_migration_id_step_index_pk" PRIMARY KEY("tenant_id","document_id","migration_id","step_index"),
	CONSTRAINT "document_migration_snapshots_step_index_check" CHECK ("document_migration_snapshots"."step_index" >= 0),
	CONSTRAINT "document_migration_snapshots_version_range_check" CHECK ("document_migration_snapshots"."from_schema_version" > 0 and "document_migration_snapshots"."to_schema_version" > "document_migration_snapshots"."from_schema_version")
);
--> statement-breakpoint
ALTER TABLE "document_migration_snapshots" ADD CONSTRAINT "document_migration_snapshots_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_migration_snapshots_document_created_idx" ON "document_migration_snapshots" USING btree ("tenant_id","document_id","created_at");