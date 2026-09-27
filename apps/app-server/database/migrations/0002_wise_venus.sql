ALTER TABLE "collaboration_updates" DROP CONSTRAINT "collaboration_updates_generation_id_document_generations_id_fk";
--> statement-breakpoint
ALTER TABLE "collaboration_updates" ADD CONSTRAINT "collaboration_updates_generation_fk" FOREIGN KEY ("document_id","generation_id") REFERENCES "public"."document_generations"("document_id","id") ON DELETE cascade ON UPDATE no action;