CREATE TABLE "document_generation_checkpoints" (
	"document_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"durable_seq" bigint NOT NULL,
	"state_bytes" "bytea" NOT NULL,
	"state_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_generation_checkpoints_document_id_generation_id_pk" PRIMARY KEY("document_id","generation_id"),
	CONSTRAINT "document_generation_checkpoints_durable_seq_check" CHECK ("document_generation_checkpoints"."durable_seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_version_checkpoints" (
	"version_id" text PRIMARY KEY NOT NULL,
	"state_bytes" "bytea" NOT NULL,
	"state_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collaboration_updates" ALTER COLUMN "update_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "document_generation_checkpoints" ADD CONSTRAINT "document_generation_checkpoints_generation_fk" FOREIGN KEY ("document_id","generation_id") REFERENCES "public"."document_generations"("document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_version_checkpoints" ADD CONSTRAINT "document_version_checkpoints_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_generation_checkpoints_document_idx" ON "document_generation_checkpoints" USING btree ("document_id","durable_seq");