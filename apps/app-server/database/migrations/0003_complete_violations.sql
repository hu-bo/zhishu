CREATE TABLE "document_acl" (
	"tenant_id" text NOT NULL,
	"document_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"action" text NOT NULL,
	"granted_by" text NOT NULL,
	CONSTRAINT "document_acl_action_check" CHECK ("document_acl"."action" in ('read', 'write', 'comment', 'share', 'export', 'ai'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_id_id_uq" ON "documents" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "document_acl" ADD CONSTRAINT "document_acl_tenant_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_acl_subject_action_uq" ON "document_acl" USING btree ("tenant_id","document_id","identity_id","action");--> statement-breakpoint
CREATE INDEX "document_acl_subject_document_idx" ON "document_acl" USING btree ("tenant_id","identity_id","document_id");--> statement-breakpoint
