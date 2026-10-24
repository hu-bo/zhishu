ALTER TABLE "document_json_asset_references" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_json_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_json_version_asset_references" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_json_version_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "document_json_asset_references" CASCADE;--> statement-breakpoint
DROP TABLE "document_json_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE "document_json_version_asset_references" CASCADE;--> statement-breakpoint
DROP TABLE "document_json_version_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_mode_check";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "mode";