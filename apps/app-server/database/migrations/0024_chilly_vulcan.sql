CREATE TABLE "knowledge_preset_installations" (
	"tenant_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"preset_id" text NOT NULL,
	"document_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_preset_installations_tenant_id_identity_id_workspace_id_preset_id_pk" PRIMARY KEY("tenant_id","identity_id","workspace_id","preset_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "workspace_id" text DEFAULT 'ws_default' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "workspaces" ("tenant_id", "id", "name", "created_by")
SELECT DISTINCT "tenant_id", 'ws_default', '团队知识库', 'system' FROM "documents"
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE INDEX "knowledge_preset_installations_document_idx" ON "knowledge_preset_installations" USING btree ("tenant_id","document_id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_fk" FOREIGN KEY ("tenant_id","workspace_id") REFERENCES "public"."workspaces"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_workspace_tree_idx" ON "documents" USING btree ("tenant_id","workspace_id","parent_id","position","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_position_check" CHECK ("documents"."position" >= 0);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_self_check" CHECK ("documents"."parent_id" is null or "documents"."parent_id" <> "documents"."id");
