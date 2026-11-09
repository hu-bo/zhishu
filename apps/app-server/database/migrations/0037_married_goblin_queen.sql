CREATE TABLE "document_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"mention_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_profiles" (
	"tenant_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_profiles_tenant_id_identity_id_pk" PRIMARY KEY("tenant_id","identity_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"event_key" text NOT NULL,
	"workspace_id" text,
	"document_id" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('comment', 'mention', 'permission', 'share', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	CONSTRAINT "workspace_invitations_role_check" CHECK ("workspace_invitations"."role" in ('editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "document_acl" ADD COLUMN "granted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "access_mode" text DEFAULT 'restricted' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_comments_document_idx" ON "document_comments" USING btree ("tenant_id","document_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_recipient_event_uq" ON "notifications" USING btree ("tenant_id","recipient_id","event_key");--> statement-breakpoint
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("tenant_id","recipient_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("tenant_id","recipient_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_token_uq" ON "workspace_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_idx" ON "workspace_invitations" USING btree ("tenant_id","workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_workspace_access_idx" ON "documents" USING btree ("tenant_id","workspace_id","access_mode");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_access_mode_check" CHECK ("documents"."access_mode" in ('personal', 'workspace-inherited', 'restricted'));