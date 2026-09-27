CREATE TABLE "document_favorites" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_favorites_tenant_id_document_id_identity_id_pk" PRIMARY KEY("tenant_id","document_id","identity_id")
);
--> statement-breakpoint
CREATE TABLE "document_recents" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_recents_tenant_id_document_id_identity_id_pk" PRIMARY KEY("tenant_id","document_id","identity_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_favorites" ADD CONSTRAINT "document_favorites_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_recents" ADD CONSTRAINT "document_recents_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_favorites_identity_created_idx" ON "document_favorites" USING btree ("tenant_id","identity_id","created_at");--> statement-breakpoint
CREATE INDEX "document_recents_identity_opened_idx" ON "document_recents" USING btree ("tenant_id","identity_id","last_opened_at");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('active', 'archived', 'trashed'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_metadata_revision_check" CHECK ("documents"."metadata_revision" > 0);