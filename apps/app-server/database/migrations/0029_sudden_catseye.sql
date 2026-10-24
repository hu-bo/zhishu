CREATE TABLE "workspace_members" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_tenant_id_workspace_id_identity_id_pk" PRIMARY KEY("tenant_id","workspace_id","identity_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" in ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;