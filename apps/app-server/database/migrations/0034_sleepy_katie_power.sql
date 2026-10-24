CREATE TABLE "writing_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"source_document_ids" jsonb NOT NULL,
	"source_context" jsonb NOT NULL,
	"state" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "writing_events" (
	"conversation_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "writing_events_conversation_id_sequence_pk" PRIMARY KEY("conversation_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "writing_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"header" jsonb NOT NULL,
	"inherited_event_count" bigint NOT NULL,
	"events" jsonb NOT NULL,
	"next_seq" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "writing_events" ADD CONSTRAINT "writing_events_conversation_id_writing_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."writing_conversations"("id") ON DELETE cascade ON UPDATE no action;