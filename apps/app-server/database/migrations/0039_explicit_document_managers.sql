-- Team-inherited documents follow current membership, including their creator.
-- Preserve private/legacy ownership as an explicit, revocable grant. Do not
-- manufacture a direct grant in normally inherited, governed team documents.
INSERT INTO resource_acl (tenant_id, document_id, identity_id, role, created_by, created_at)
SELECT d.tenant_id, d.id, d.created_by, 'manage', 'migration:explicit-document-managers', d.created_at
FROM documents d
JOIN workspaces w ON w.tenant_id = d.tenant_id AND w.id = d.workspace_id
WHERE d.access_mode <> 'workspace-inherited' OR w.kind <> 'team' OR w.created_by = 'system'
   OR EXISTS (
     WITH RECURSIVE parents AS (
       SELECT c.id, c.parent_id, c.access_mode, 0 AS depth FROM catalogs c
       WHERE c.tenant_id = d.tenant_id AND c.id = d.catalog_id
       UNION ALL SELECT c.id, c.parent_id, c.access_mode, p.depth + 1
       FROM catalogs c JOIN parents p ON c.id = p.parent_id
       WHERE c.tenant_id = d.tenant_id AND p.access_mode = 'inherit' AND p.depth < 17
     ) SELECT 1 FROM parents WHERE access_mode = 'restricted'
   )
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO document_audit_events (tenant_id, actor_identity_id, action, resource_id, details)
SELECT d.tenant_id, 'migration', 'document.acl-updated', d.id,
       jsonb_build_object('operation', 'explicit-document-manager', 'identityId', d.created_by,
                          'policy', CASE WHEN EXISTS (SELECT 1 FROM resource_acl a
                                         WHERE a.tenant_id = d.tenant_id AND a.document_id = d.id
                                           AND a.created_by = 'migration:explicit-document-managers')
                                         THEN 'explicit-management' ELSE 'current-membership' END)
FROM documents d;
