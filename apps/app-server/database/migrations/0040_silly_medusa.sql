CREATE TABLE "authorization_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "authorization_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"document_id" text,
	"actor_id" text,
	"operation" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "resource_acl_document_subject_role_uq";--> statement-breakpoint
ALTER TABLE "document_shares" ADD COLUMN "kind" text DEFAULT 'invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_acl" ADD COLUMN "source_share_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "owner_identity_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "authorization_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "offline_cache_allowed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "authorization_events_workspace_idx" ON "authorization_events" USING btree ("tenant_id","workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_shares_resource_uq" ON "document_shares" USING btree ("tenant_id","document_id","id");--> statement-breakpoint
ALTER TABLE "resource_acl" ADD CONSTRAINT "resource_acl_tenant_id_document_id_source_share_id_document_shares_tenant_id_document_id_id_fk" FOREIGN KEY ("tenant_id","document_id","source_share_id") REFERENCES "public"."document_shares"("tenant_id","document_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_acl_document_source_role_uq" ON "resource_acl" USING btree ("tenant_id","document_id","identity_id","role","source_share_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_acl_document_subject_role_uq" ON "resource_acl" USING btree ("tenant_id","document_id","identity_id","role") WHERE "resource_acl"."source_share_id" is null;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_kind_check" CHECK ("document_shares"."kind" in ('invite', 'access'));--> statement-breakpoint
ALTER TABLE "resource_acl" ADD CONSTRAINT "resource_acl_source_check" CHECK ("resource_acl"."source_share_id" is null or ("resource_acl"."document_id" is not null and "resource_acl"."role" in ('read','write','comment')));
--> statement-breakpoint
UPDATE workspaces SET owner_identity_id = CASE WHEN kind = 'personal' THEN personal_owner_id WHEN created_by NOT IN ('system','migration') THEN created_by END;
--> statement-breakpoint
CREATE FUNCTION record_authorization_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb; current_row jsonb; row_data jsonb; space_id text; old_space_id text; doc_id text; tenant text;
BEGIN
  IF TG_OP <> 'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND prior = current_row THEN RETURN NEW; END IF;
  row_data := coalesce(current_row, prior); tenant := row_data->>'tenant_id';
  space_id := row_data->>'workspace_id'; doc_id := row_data->>'document_id';
  IF TG_TABLE_NAME = 'workspaces' THEN
    space_id := row_data->>'id';
    IF TG_OP = 'UPDATE' AND (prior->'owner_identity_id',prior->'offline_cache_allowed') IS NOT DISTINCT FROM (current_row->'owner_identity_id',current_row->'offline_cache_allowed') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'documents' THEN
    doc_id := row_data->>'id'; old_space_id := prior->>'workspace_id';
    IF TG_OP = 'UPDATE' AND (prior->'access_mode',prior->'workspace_id',prior->'catalog_id',prior->'status') IS NOT DISTINCT FROM (current_row->'access_mode',current_row->'workspace_id',current_row->'catalog_id',current_row->'status') THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
      prior := prior || jsonb_build_object('generationIds', (SELECT jsonb_agg(id) FROM document_generations WHERE document_id = doc_id));
    END IF;
  ELSIF TG_TABLE_NAME = 'document_generations' THEN
    SELECT tenant_id,workspace_id INTO tenant,space_id FROM documents WHERE id = doc_id;
    IF prior->'status' IS NOT DISTINCT FROM current_row->'status' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'catalogs' THEN
    old_space_id := prior->>'workspace_id';
    IF TG_OP = 'UPDATE' AND (prior->'access_mode',prior->'workspace_id',prior->'parent_id') IS NOT DISTINCT FROM (current_row->'access_mode',current_row->'workspace_id',current_row->'parent_id') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'resource_acl' THEN
    IF space_id IS NULL AND row_data->>'catalog_id' IS NOT NULL THEN SELECT workspace_id INTO space_id FROM catalogs WHERE tenant_id = tenant AND id = row_data->>'catalog_id'; END IF;
    IF space_id IS NULL THEN SELECT workspace_id INTO space_id FROM documents WHERE tenant_id = tenant AND id = doc_id; END IF;
  ELSIF TG_TABLE_NAME = 'document_shares' THEN
    SELECT workspace_id INTO space_id FROM documents WHERE tenant_id = tenant AND id = doc_id;
    IF TG_OP = 'UPDATE' AND (prior->'revoked_at',prior->'expires_at',prior->'permission',prior->'kind') IS NOT DISTINCT FROM (current_row->'revoked_at',current_row->'expires_at',current_row->'permission',current_row->'kind') THEN RETURN NEW; END IF;
  END IF;
  IF space_id IS NULL THEN RETURN coalesce(NEW,OLD); END IF;
  PERFORM pg_advisory_xact_lock(718270, 1);
  UPDATE workspaces SET authorization_revision = authorization_revision + 1 WHERE tenant_id = tenant AND id IN (space_id, old_space_id);
  -- Never copy document content/titles into the permission audit stream.
  IF TG_TABLE_NAME = 'documents' THEN prior := prior - 'title' - 'tags' - 'icon'; current_row := current_row - 'title' - 'tags' - 'icon'; END IF;
  INSERT INTO authorization_events (tenant_id,workspace_id,document_id,actor_id,operation,"before","after")
    VALUES (tenant,space_id,doc_id,nullif(current_setting('zhishu.actor_id',true),''),TG_TABLE_NAME || '.' || lower(TG_OP),prior,current_row);
  IF old_space_id IS NOT NULL AND old_space_id <> space_id THEN
    INSERT INTO authorization_events (tenant_id,workspace_id,document_id,actor_id,operation,"before","after")
      VALUES (tenant,old_space_id,doc_id,nullif(current_setting('zhishu.actor_id',true),''),TG_TABLE_NAME || '.moved-out',prior,current_row);
  END IF;
  RETURN coalesce(NEW,OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER resource_acl_authorization AFTER INSERT OR UPDATE OR DELETE ON resource_acl FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER role_permissions_authorization AFTER INSERT OR UPDATE OR DELETE ON role_permissions FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER shares_authorization AFTER INSERT OR UPDATE OR DELETE ON document_shares FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER documents_authorization AFTER UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER documents_delete_authorization BEFORE DELETE ON documents FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER generations_authorization AFTER UPDATE OF status ON document_generations FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER catalogs_authorization AFTER UPDATE OR DELETE ON catalogs FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
CREATE TRIGGER workspaces_authorization AFTER UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION record_authorization_change();
