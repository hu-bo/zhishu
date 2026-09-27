ALTER TABLE "asset_references" ADD COLUMN "durable_seq" bigint;--> statement-breakpoint
UPDATE "asset_references" AS refs SET "durable_seq" = COALESCE((SELECT updates."durable_seq" FROM "collaboration_updates" AS updates WHERE updates."generation_id" = refs."generation_id" AND updates."created_at" <= refs."created_at" ORDER BY updates."created_at" DESC, updates."durable_seq" DESC LIMIT 1), (SELECT MAX(updates."durable_seq") FROM "collaboration_updates" AS updates WHERE updates."generation_id" = refs."generation_id"));--> statement-breakpoint
DELETE FROM "asset_references" AS refs WHERE refs."durable_seq" IS NULL;--> statement-breakpoint
ALTER TABLE "asset_references" ALTER COLUMN "durable_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "asset_references" DROP CONSTRAINT "asset_references_tenant_id_document_id_generation_id_asset_id_block_id_pk";--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_tenant_id_document_id_generation_id_durable_seq_asset_id_block_id_pk" PRIMARY KEY("tenant_id","document_id","generation_id","durable_seq","asset_id","block_id");--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_update_fk" FOREIGN KEY ("generation_id","durable_seq") REFERENCES "public"."collaboration_updates"("generation_id","durable_seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_references" ADD CONSTRAINT "asset_references_durable_seq_check" CHECK ("durable_seq" >= 0);--> statement-breakpoint
CREATE INDEX "asset_references_generation_seq_idx" ON "asset_references" USING btree ("tenant_id","document_id","generation_id","durable_seq");
