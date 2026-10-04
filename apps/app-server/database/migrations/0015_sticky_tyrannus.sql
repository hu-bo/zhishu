CREATE TABLE "document_json_asset_references" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"block_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_json_asset_references_tenant_id_document_id_asset_id_block_id_pk" PRIMARY KEY("tenant_id","document_id","asset_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "document_json_snapshots" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"snapshot_revision" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"block_count" integer NOT NULL,
	"text_length" integer NOT NULL,
	"asset_count" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_json_snapshots_tenant_id_document_id_pk" PRIMARY KEY("tenant_id","document_id"),
	CONSTRAINT "document_json_snapshots_revision_check" CHECK ("document_json_snapshots"."snapshot_revision" > 0),
	CONSTRAINT "document_json_snapshots_summary_check" CHECK ("document_json_snapshots"."block_count" >= 0 and "document_json_snapshots"."text_length" >= 0 and "document_json_snapshots"."asset_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_audit_events" DROP CONSTRAINT "document_audit_events_action_check";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "mode" text DEFAULT 'collaborative' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_json_asset_references" ADD CONSTRAINT "document_json_asset_references_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_json_asset_references" ADD CONSTRAINT "document_json_asset_references_asset_fk" FOREIGN KEY ("tenant_id","document_id","asset_id") REFERENCES "public"."assets"("tenant_id","document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_json_snapshots" ADD CONSTRAINT "document_json_snapshots_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_json_asset_references_asset_idx" ON "document_json_asset_references" USING btree ("tenant_id","asset_id");--> statement-breakpoint
ALTER TABLE "document_audit_events" ADD CONSTRAINT "document_audit_events_action_check" CHECK ("document_audit_events"."action" in ('document.created', 'document.imported', 'document.exported', 'document.collaboration-enabled', 'document.copied', 'document.title-updated', 'document.archived', 'document.trashed', 'document.restored', 'document.permanently-deleted', 'document.version-created', 'document.version-restored', 'document.acl-updated', 'document.acl-removed', 'document.schema-migrated', 'document.block-ids-repaired'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_mode_check" CHECK ("documents"."mode" in ('standard', 'collaborative'));