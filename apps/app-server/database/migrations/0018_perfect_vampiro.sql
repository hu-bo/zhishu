CREATE TABLE "api_idempotency_records" (
	"tenant_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "api_idempotency_records_pk" PRIMARY KEY("tenant_id","subject_id","operation_id","key_hash"),
	CONSTRAINT "api_idempotency_records_hash_check" CHECK ("api_idempotency_records"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_idempotency_records_request_hash_check" CHECK ("api_idempotency_records"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "api_idempotency_records_status_check" CHECK ("api_idempotency_records"."response_status" between 200 and 299),
	CONSTRAINT "api_idempotency_records_expiry_check" CHECK ("api_idempotency_records"."expires_at" > "api_idempotency_records"."created_at")
);
--> statement-breakpoint
CREATE INDEX "api_idempotency_records_expiry_idx" ON "api_idempotency_records" USING btree ("expires_at");