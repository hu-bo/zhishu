CREATE TABLE "asset_references" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"block_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_references_tenant_id_document_id_generation_id_asset_id_block_id_pk" PRIMARY KEY("tenant_id","document_id","generation_id","asset_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"object_key" text NOT NULL,
	"file_name" text NOT NULL,
	"media_type" text NOT NULL,
	"declared_size" integer NOT NULL,
	"actual_size" integer,
	"sha256" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"uploaded_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "assets_size_check" CHECK ("assets"."declared_size" > 0 and "assets"."actual_size" >= 0),
	CONSTRAINT "assets_status_check" CHECK ("assets"."status" in ('uploading', 'receiving', 'uploaded', 'ready', 'cancelled', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_generation_fk" FOREIGN KEY ("document_id","generation_id") REFERENCES "public"."document_generations"("document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_document_id_uq" ON "assets" USING btree ("tenant_id","document_id","id");--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_asset_fk" FOREIGN KEY ("tenant_id","document_id","asset_id") REFERENCES "public"."assets"("tenant_id","document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_references_asset_idx" ON "asset_references" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_object_key_uq" ON "assets" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "assets_upload_cleanup_idx" ON "assets" USING btree ("status","upload_expires_at");
