CREATE TABLE "document_indexes" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"active_index_version" uuid,
	"generation_id" text,
	"durable_seq" text,
	"metadata_revision" integer,
	"config_fingerprint" text,
	"snapshot_id" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_indexes_tenant_id_document_id_pk" PRIMARY KEY("tenant_id","document_id")
);
--> statement-breakpoint
CREATE INDEX "document_indexes_ready_idx" ON "document_indexes" USING btree ("available_at","lease_until");