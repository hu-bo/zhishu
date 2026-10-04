CREATE TABLE "document_json_version_asset_references" (
	"version_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"block_id" text NOT NULL,
	CONSTRAINT "document_json_version_asset_references_version_id_asset_id_block_id_pk" PRIMARY KEY("version_id","asset_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "document_json_version_snapshots" (
	"version_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"snapshot_revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_json_version_snapshots_revision_check" CHECK ("document_json_version_snapshots"."snapshot_revision" > 0),
	CONSTRAINT "document_json_version_snapshots_hash_check" CHECK ("document_json_version_snapshots"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "document_json_version_asset_references" ADD CONSTRAINT "document_json_version_asset_references_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_json_version_asset_references" ADD CONSTRAINT "document_json_version_asset_references_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_json_version_asset_references" ADD CONSTRAINT "document_json_version_asset_references_asset_fk" FOREIGN KEY ("tenant_id","document_id","asset_id") REFERENCES "public"."assets"("tenant_id","document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_json_version_snapshots" ADD CONSTRAINT "document_json_version_snapshots_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_json_version_snapshots" ADD CONSTRAINT "document_json_version_snapshots_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_json_version_asset_references_asset_idx" ON "document_json_version_asset_references" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "document_json_version_snapshots_document_idx" ON "document_json_version_snapshots" USING btree ("tenant_id","document_id");