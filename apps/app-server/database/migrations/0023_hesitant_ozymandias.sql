ALTER TABLE "documents" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;