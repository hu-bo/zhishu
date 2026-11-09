ALTER TABLE "identity_profiles" ADD COLUMN "active" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE FUNCTION record_identity_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(718270, 1);
  UPDATE workspaces SET authorization_revision = authorization_revision + 1
    WHERE tenant_id = NEW.tenant_id;
  INSERT INTO authorization_events(tenant_id, workspace_id, operation, before, after)
    SELECT NEW.tenant_id, id, 'identity_profiles.lifecycle',
      jsonb_build_object('identityId', NEW.identity_id, 'active', OLD.active),
      jsonb_build_object('identityId', NEW.identity_id, 'active', NEW.active)
    FROM workspaces WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER identity_lifecycle AFTER UPDATE OF active ON identity_profiles
  FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active)
  EXECUTE FUNCTION record_identity_lifecycle();
