CREATE TABLE "writing_image_jobs" (
	"key" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"job" jsonb NOT NULL,
	"provider_result" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "writing_image_jobs" ADD CONSTRAINT "writing_image_jobs_conversation_id_writing_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."writing_conversations"("id") ON DELETE cascade ON UPDATE no action;