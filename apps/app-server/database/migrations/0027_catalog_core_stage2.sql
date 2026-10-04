-- Backfill: give every workspace its root catalog node before documents.catalog_id becomes NOT NULL.
INSERT INTO "catalogs" ("tenant_id", "id", "workspace_id", "parent_id", "name", "position", "created_by")
SELECT "tenant_id", 'cat_root_' || "id", "id", NULL, '根目录', 0, "created_by" FROM "workspaces"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "catalog_id" text;--> statement-breakpoint
-- Old doc-to-doc nesting is intentionally flattened into the workspace root (no legacy compatibility required).
UPDATE "documents" SET "catalog_id" = 'cat_root_' || "workspace_id" WHERE "catalog_id" IS NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "catalog_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_catalog_fk" FOREIGN KEY ("tenant_id","catalog_id") REFERENCES "public"."catalogs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_catalog_idx" ON "documents" USING btree ("tenant_id","workspace_id","catalog_id","position","id");
