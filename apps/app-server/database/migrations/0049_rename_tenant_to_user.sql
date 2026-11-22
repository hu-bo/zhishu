-- 统一命名：所有租户隔离列 tenant_id 更名为 user_id（仅改名，取值与隔离语义不变）。
-- 索引与约束名同步由 *_tenant_* / *_tenant_id_* 更名为 *_user_* / *_user_id_*。
-- 数据无损：全部使用 RENAME，不改类型、默认值与既有约束定义。

-- columns
ALTER TABLE "ai_artifacts" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ai_conversations" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ai_events" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ai_image_jobs" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ai_messages" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ai_runs" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "ai_sessions" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "api_idempotency_records" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "asset_references" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "assets" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "authorization_events" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "catalogs" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_audit_events" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_comments" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_favorites" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_indexes" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_migration_snapshots" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_outbox" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_projection_snapshots" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_recents" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_shares" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "document_versions" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "documents" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "identity_profiles" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "knowledge_preset_installations" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "legacy_ai_conversation_origins" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "notifications" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "qa_site_documents" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "qa_site_sources" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "qa_sites" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "resource_acl" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "role_permissions" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "workspace_invitations" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME COLUMN "tenant_id" TO "user_id";--> statement-breakpoint

-- constraints
ALTER TABLE "ai_artifacts" RENAME CONSTRAINT "ai_artifacts_tenant_id_id_pk" TO "ai_artifacts_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "ai_conversations" RENAME CONSTRAINT "ai_conversations_tenant_id_id_pk" TO "ai_conversations_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "ai_events" RENAME CONSTRAINT "ai_events_tenant_id_conversation_id_sequence_pk" TO "ai_events_user_id_conversation_id_sequence_pk";--> statement-breakpoint
ALTER TABLE "ai_messages" RENAME CONSTRAINT "ai_messages_tenant_id_id_pk" TO "ai_messages_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "ai_runs" RENAME CONSTRAINT "ai_runs_tenant_id_id_pk" TO "ai_runs_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "asset_references" RENAME CONSTRAINT "asset_references_tenant_document_fk" TO "asset_references_user_document_fk";--> statement-breakpoint
ALTER TABLE "asset_references" RENAME CONSTRAINT "asset_references_tenant_id_document_id_generation_id_durable_se" TO "asset_references_user_id_document_id_generation_id_durable_se";--> statement-breakpoint
ALTER TABLE "catalogs" RENAME CONSTRAINT "catalogs_tenant_id_id_pk" TO "catalogs_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "document_favorites" RENAME CONSTRAINT "document_favorites_tenant_document_fk" TO "document_favorites_user_document_fk";--> statement-breakpoint
ALTER TABLE "document_favorites" RENAME CONSTRAINT "document_favorites_tenant_id_document_id_identity_id_pk" TO "document_favorites_user_id_document_id_identity_id_pk";--> statement-breakpoint
ALTER TABLE "document_indexes" RENAME CONSTRAINT "document_indexes_tenant_id_document_id_pk" TO "document_indexes_user_id_document_id_pk";--> statement-breakpoint
ALTER TABLE "document_migration_snapshots" RENAME CONSTRAINT "document_migration_snapshots_tenant_document_fk" TO "document_migration_snapshots_user_document_fk";--> statement-breakpoint
ALTER TABLE "document_migration_snapshots" RENAME CONSTRAINT "document_migration_snapshots_tenant_id_document_id_migration_id" TO "document_migration_snapshots_user_id_document_id_migration_id";--> statement-breakpoint
ALTER TABLE "document_outbox" RENAME CONSTRAINT "document_outbox_tenant_document_fk" TO "document_outbox_user_document_fk";--> statement-breakpoint
ALTER TABLE "document_projection_snapshots" RENAME CONSTRAINT "document_projection_snapshots_tenant_document_fk" TO "document_projection_snapshots_user_document_fk";--> statement-breakpoint
ALTER TABLE "document_projection_snapshots" RENAME CONSTRAINT "document_projection_snapshots_tenant_id_document_id_generation_" TO "document_projection_snapshots_user_id_document_id_generation_";--> statement-breakpoint
ALTER TABLE "document_recents" RENAME CONSTRAINT "document_recents_tenant_document_fk" TO "document_recents_user_document_fk";--> statement-breakpoint
ALTER TABLE "document_recents" RENAME CONSTRAINT "document_recents_tenant_id_document_id_identity_id_pk" TO "document_recents_user_id_document_id_identity_id_pk";--> statement-breakpoint
ALTER TABLE "document_shares" RENAME CONSTRAINT "document_shares_tenant_id_id_pk" TO "document_shares_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "document_versions" RENAME CONSTRAINT "document_versions_tenant_document_fk" TO "document_versions_user_document_fk";--> statement-breakpoint
ALTER TABLE "identity_profiles" RENAME CONSTRAINT "identity_profiles_tenant_id_identity_id_pk" TO "identity_profiles_user_id_identity_id_pk";--> statement-breakpoint
ALTER TABLE "knowledge_preset_installations" RENAME CONSTRAINT "knowledge_preset_installations_tenant_id_identity_id_workspace_" TO "knowledge_preset_installations_user_id_identity_id_workspace_";--> statement-breakpoint
ALTER TABLE "qa_site_documents" RENAME CONSTRAINT "qa_site_documents_tenant_id_id_pk" TO "qa_site_documents_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "qa_site_sources" RENAME CONSTRAINT "qa_site_sources_tenant_id_id_pk" TO "qa_site_sources_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "qa_sites" RENAME CONSTRAINT "qa_sites_tenant_id_id_pk" TO "qa_sites_user_id_id_pk";--> statement-breakpoint
ALTER TABLE "resource_acl" RENAME CONSTRAINT "resource_acl_tenant_id_catalog_id_catalogs_tenant_id_id_fk" TO "resource_acl_user_id_catalog_id_catalogs_user_id_id_fk";--> statement-breakpoint
ALTER TABLE "resource_acl" RENAME CONSTRAINT "resource_acl_tenant_id_document_id_documents_tenant_id_id_fk" TO "resource_acl_user_id_document_id_documents_user_id_id_fk";--> statement-breakpoint
ALTER TABLE "resource_acl" RENAME CONSTRAINT "resource_acl_tenant_id_document_id_source_share_id_document_sha" TO "resource_acl_user_id_document_id_source_share_id_document_sha";--> statement-breakpoint
ALTER TABLE "resource_acl" RENAME CONSTRAINT "resource_acl_tenant_id_workspace_id_workspaces_tenant_id_id_fk" TO "resource_acl_user_id_workspace_id_workspaces_user_id_id_fk";--> statement-breakpoint
ALTER TABLE "role_permissions" RENAME CONSTRAINT "role_permissions_tenant_id_workspace_id_resource_type_role_pk" TO "role_permissions_user_id_workspace_id_resource_type_role_pk";--> statement-breakpoint
ALTER TABLE "role_permissions" RENAME CONSTRAINT "role_permissions_tenant_id_workspace_id_workspaces_tenant_id_id" TO "role_permissions_user_id_workspace_id_workspaces_user_id_id";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "workspaces_tenant_id_id_pk" TO "workspaces_user_id_id_pk";--> statement-breakpoint

-- indexes
ALTER INDEX "ai_runs_tenant_conversation_id_uq" RENAME TO "ai_runs_user_conversation_id_uq";--> statement-breakpoint
ALTER INDEX "assets_tenant_document_id_uq" RENAME TO "assets_user_document_id_uq";--> statement-breakpoint
ALTER INDEX "document_audit_events_tenant_created_idx" RENAME TO "document_audit_events_user_created_idx";--> statement-breakpoint
ALTER INDEX "documents_tenant_created_idx" RENAME TO "documents_user_created_idx";--> statement-breakpoint
ALTER INDEX "documents_tenant_id_id_uq" RENAME TO "documents_user_id_id_uq";--> statement-breakpoint
ALTER INDEX "documents_tenant_workspace_id_uq" RENAME TO "documents_user_workspace_id_uq";--> statement-breakpoint
ALTER INDEX "qa_site_sources_tenant_id_workspace_uq" RENAME TO "qa_site_sources_user_id_workspace_uq";--> statement-breakpoint
ALTER INDEX "qa_sites_tenant_idx" RENAME TO "qa_sites_user_idx";--> statement-breakpoint

-- trigger functions hardcode column names and to_jsonb keys; replace them to match the renamed columns
CREATE OR REPLACE FUNCTION record_identity_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(718270, 1);
  UPDATE workspaces SET authorization_revision = authorization_revision + 1
    WHERE user_id = NEW.user_id;
  INSERT INTO authorization_events(user_id, workspace_id, operation, before, after)
    SELECT NEW.user_id, id, 'identity_profiles.lifecycle',
      jsonb_build_object('identityId', NEW.identity_id, 'active', OLD.active),
      jsonb_build_object('identityId', NEW.identity_id, 'active', NEW.active)
    FROM workspaces WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_authorization_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb; current_row jsonb; row_data jsonb; space_id text; old_space_id text; doc_id text; usr text;
BEGIN
  IF TG_OP <> 'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND prior = current_row THEN RETURN NEW; END IF;
  row_data := coalesce(current_row, prior); usr := row_data->>'user_id';
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
    SELECT user_id,workspace_id INTO usr,space_id FROM documents WHERE id = doc_id;
    IF prior->'status' IS NOT DISTINCT FROM current_row->'status' THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'catalogs' THEN
    old_space_id := prior->>'workspace_id';
    IF TG_OP = 'UPDATE' AND (prior->'access_mode',prior->'workspace_id',prior->'parent_id') IS NOT DISTINCT FROM (current_row->'access_mode',current_row->'workspace_id',current_row->'parent_id') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME = 'resource_acl' THEN
    IF space_id IS NULL AND row_data->>'catalog_id' IS NOT NULL THEN SELECT workspace_id INTO space_id FROM catalogs WHERE user_id = usr AND id = row_data->>'catalog_id'; END IF;
    IF space_id IS NULL THEN SELECT workspace_id INTO space_id FROM documents WHERE user_id = usr AND id = doc_id; END IF;
  ELSIF TG_TABLE_NAME = 'document_shares' THEN
    SELECT workspace_id INTO space_id FROM documents WHERE user_id = usr AND id = doc_id;
    IF TG_OP = 'UPDATE' AND (prior->'revoked_at',prior->'expires_at',prior->'permission',prior->'kind') IS NOT DISTINCT FROM (current_row->'revoked_at',current_row->'expires_at',current_row->'permission',current_row->'kind') THEN RETURN NEW; END IF;
  END IF;
  IF space_id IS NULL THEN RETURN coalesce(NEW,OLD); END IF;
  PERFORM pg_advisory_xact_lock(718270, 1);
  UPDATE workspaces SET authorization_revision = authorization_revision + 1 WHERE user_id = usr AND id IN (space_id, old_space_id);
  -- Never copy document content/titles into the permission audit stream.
  IF TG_TABLE_NAME = 'documents' THEN prior := prior - 'title' - 'tags' - 'icon'; current_row := current_row - 'title' - 'tags' - 'icon'; END IF;
  INSERT INTO authorization_events (user_id,workspace_id,document_id,actor_id,operation,"before","after")
    VALUES (usr,space_id,doc_id,nullif(current_setting('zhishu.actor_id',true),''),TG_TABLE_NAME || '.' || lower(TG_OP),prior,current_row);
  IF old_space_id IS NOT NULL AND old_space_id <> space_id THEN
    INSERT INTO authorization_events (user_id,workspace_id,document_id,actor_id,operation,"before","after")
      VALUES (usr,old_space_id,doc_id,nullif(current_setting('zhishu.actor_id',true),''),TG_TABLE_NAME || '.moved-out',prior,current_row);
  END IF;
  RETURN coalesce(NEW,OLD);
END $$;
