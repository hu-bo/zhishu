CREATE TABLE "resource_acl" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text,
	"catalog_id" text,
	"document_id" text,
	"identity_id" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_acl_one_resource_check" CHECK (num_nonnulls("resource_acl"."workspace_id", "resource_acl"."catalog_id", "resource_acl"."document_id") = 1),
	CONSTRAINT "resource_acl_role_check" CHECK ("resource_acl"."role" in ('admin','editor','viewer','read','write','comment','share','export','ai','manage','move') and ("resource_acl"."workspace_id" is null or "resource_acl"."role" in ('admin','editor','viewer')))
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"role" text NOT NULL,
	"actions" text[] NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_tenant_id_workspace_id_resource_type_role_pk" PRIMARY KEY("tenant_id","workspace_id","resource_type","role"),
	CONSTRAINT "role_permissions_kind_check" CHECK ("role_permissions"."resource_type" in ('space','catalog','document')),
	CONSTRAINT "role_permissions_role_check" CHECK ("role_permissions"."role" in ('admin','editor','viewer')),
	CONSTRAINT "role_permissions_actions_check" CHECK ("role_permissions"."actions" <@ array['read','write','comment','share','export','ai','manage','move']::text[])
);
--> statement-breakpoint
ALTER TABLE "document_acl" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalogs" ADD COLUMN "access_mode" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_acl" ADD CONSTRAINT "resource_acl_tenant_id_workspace_id_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_acl" ADD CONSTRAINT "resource_acl_tenant_id_catalog_id_catalogs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","catalog_id") REFERENCES "public"."catalogs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_acl" ADD CONSTRAINT "resource_acl_tenant_id_document_id_documents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_id_workspace_id_workspaces_tenant_id_id_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_acl_workspace_subject_uq" ON "resource_acl" USING btree ("tenant_id","workspace_id","identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_acl_catalog_subject_role_uq" ON "resource_acl" USING btree ("tenant_id","catalog_id","identity_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_acl_document_subject_role_uq" ON "resource_acl" USING btree ("tenant_id","document_id","identity_id","role");--> statement-breakpoint
CREATE INDEX "resource_acl_subject_idx" ON "resource_acl" USING btree ("tenant_id","identity_id");--> statement-breakpoint
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_access_mode_check" CHECK ("catalogs"."access_mode" in ('inherit', 'restricted'));
-- Merge both legacy grant stores before removing them. Do not promote action grants to roles.
INSERT INTO resource_acl (tenant_id, workspace_id, identity_id, role, created_by, created_at, updated_at)
SELECT tenant_id, workspace_id, identity_id, role, 'migration', created_at, created_at FROM workspace_members;
--> statement-breakpoint
INSERT INTO resource_acl (tenant_id, document_id, identity_id, role, created_by, created_at, updated_at)
SELECT tenant_id, document_id, identity_id, action, granted_by, granted_at, granted_at FROM document_acl;
--> statement-breakpoint
DROP TABLE "document_acl";--> statement-breakpoint
DROP TABLE "workspace_members";--> statement-breakpoint
