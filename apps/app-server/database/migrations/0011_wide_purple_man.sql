CREATE TABLE "document_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"actor_identity_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text DEFAULT 'document' NOT NULL,
	"resource_id" text NOT NULL,
	"generation_id" text,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_audit_events_action_check" CHECK ("document_audit_events"."action" in ('document.created', 'document.copied', 'document.title-updated', 'document.archived', 'document.trashed', 'document.restored', 'document.permanently-deleted', 'document.version-created', 'document.version-restored', 'document.acl-updated', 'document.acl-removed', 'document.schema-migrated', 'document.block-ids-repaired')),
	CONSTRAINT "document_audit_events_resource_type_check" CHECK ("document_audit_events"."resource_type" = 'document')
);
--> statement-breakpoint
CREATE INDEX "document_audit_events_tenant_created_idx" ON "document_audit_events" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "document_audit_events_resource_created_idx" ON "document_audit_events" USING btree ("tenant_id","resource_id","created_at","id");