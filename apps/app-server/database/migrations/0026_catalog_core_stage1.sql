CREATE TABLE "catalogs" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"icon" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogs_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "catalogs_position_check" CHECK ("catalogs"."position" >= 0),
	CONSTRAINT "catalogs_parent_self_check" CHECK ("catalogs"."parent_id" is null or "catalogs"."parent_id" <> "catalogs"."id")
);
--> statement-breakpoint
CREATE TABLE "document_shares" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"document_id" text NOT NULL,
	"permission" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"join_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_shares_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "document_shares_permission_check" CHECK ("document_shares"."permission" in ('read', 'edit')),
	CONSTRAINT "document_shares_expiry_check" CHECK ("document_shares"."expires_at" > "document_shares"."created_at"),
	CONSTRAINT "document_shares_join_count_check" CHECK ("document_shares"."join_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_parent_self_check";--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_parent_fk";
--> statement-breakpoint
DROP INDEX "documents_workspace_tree_idx";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."catalogs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalogs_workspace_root_uq" ON "catalogs" USING btree ("tenant_id","workspace_id") WHERE "catalogs"."parent_id" is null;--> statement-breakpoint
CREATE INDEX "catalogs_workspace_parent_idx" ON "catalogs" USING btree ("tenant_id","workspace_id","parent_id","position","id");--> statement-breakpoint
CREATE INDEX "document_shares_document_created_idx" ON "document_shares" USING btree ("tenant_id","document_id","created_at");--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "parent_id";