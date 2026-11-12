-- One-time data upgrade into the new AI platform tables (explicit migration only; this
-- transformation never runs in request paths or startup). Rules follow docs §14:
--  * legacy writing ChatRecord snapshots split into conversations/runs/messages;
--  * legacy chat tasks rebuild QA conversations per provable subject;
--  * legacy authoring tasks rebuild writing conversations with evidence/proposal artifacts;
--  * non-finished legacy runs become interrupted, never resumable through the old engine;
--  * anything that cannot be mapped provably stays in the 0042 archive until audited.
--> statement-breakpoint
-- A. Writing conversations from the legacy ChatRecord snapshot.
INSERT INTO "ai_conversations"
  ("id","tenant_id","purpose","identity_id","visitor_id","site_id","scope_selection","context_revision",
   "target_document_id","configuration_id","creation_key","origin","event_sequence","status","created_at","updated_at")
SELECT w.id, w.tenant_id, 'writing', w.subject_id, NULL, NULL,
  CASE WHEN jsonb_typeof(w.source_document_ids) = 'array' AND jsonb_array_length(w.source_document_ids) > 0
    THEN jsonb_build_object('kind','documents','documentIds', w.source_document_ids)
    ELSE jsonb_build_object('kind','all') END,
  1, NULL, NULLIF(w.state->>'configurationId',''), NULL, NULL,
  COALESCE((w.state->'snapshot'->>'cursor')::bigint, 0), 'active', w.updated_at, w.updated_at
FROM "legacy_writing_conversations" w;--> statement-breakpoint
INSERT INTO "ai_runs"
  ("id","tenant_id","conversation_id","purpose","idempotency_key","input_hash","context","status","attempt",
   "usage","error_code","cancel_requested","execution","created_at","updated_at","expires_at")
SELECT r->>'id', w.tenant_id, w.id, 'writing',
  COALESCE(NULLIF(r->>'idempotencyKey',''), r->>'id'),
  CASE WHEN COALESCE(r->>'inputHash','') ~ '^sha256:[a-f0-9]{64}$' THEN r->>'inputHash'
       ELSE 'sha256:'||md5(COALESCE(r->>'inputHash', r->>'id'))||md5(COALESCE(r->>'inputHash', r->>'id')||'#2') END,
  jsonb_build_object('contextRevision',1,'webSearch',false),
  CASE WHEN r->>'status' IN ('completed','failed','cancelled') THEN r->>'status' ELSE 'interrupted' END,
  GREATEST(COALESCE((r->>'attempt')::int,1),1),
  jsonb_build_object('modelCalls',COALESCE((r->>'modelCalls')::int,0),'inputTokens',0,'outputTokens',0,
    'searchCalls',0,'sourceReads',0,'webSearchCalls',0,'webReadCalls',0,'unknownCalls',0),
  CASE WHEN r->>'status' IN ('completed','failed','cancelled') THEN NULLIF(r->>'errorCode','')
       ELSE 'LEGACY_INTERRUPTED' END,
  COALESCE((r->>'cancelRequested')::boolean,false),
  jsonb_strip_nulls(jsonb_build_object(
    'nativeMessageId', NULLIF(r->>'nativeMessageId',''),
    'turn', CASE WHEN jsonb_typeof(r->'turn')='number' THEN (r->>'turn')::int END,
    'deliveryConfirmed', CASE WHEN NULLIF(r->>'nativeMessageId','') IS NOT NULL THEN true END,
    'evidenceRefs','[]'::jsonb,'evidenceArtifactIds','[]'::jsonb,'proposalArtifactIds','[]'::jsonb,'steps','[]'::jsonb,
    'approval', (
      SELECT jsonb_build_object(
        'id', a->>'id','attempt', COALESCE((a->>'attempt')::int,1),'action', a->>'action',
        'status', CASE WHEN a->>'status'='pending' THEN 'expired' ELSE a->>'status' END,
        'requestedAt', COALESCE(a->>'createdAt', w.updated_at::text),
        'expiresAt', COALESCE(a->>'expiresAt', w.updated_at::text))
      FROM jsonb_array_elements(w.state->'snapshot'->'approvals') a
      WHERE a->>'runId' = r->>'id'
      ORDER BY a->>'expiresAt' DESC LIMIT 1))),
  COALESCE((r->>'createdAt')::timestamptz, w.updated_at), w.updated_at, now() + interval '7 days'
FROM "legacy_writing_conversations" w, jsonb_array_elements(w.state->'snapshot'->'runs') r;--> statement-breakpoint
INSERT INTO "ai_messages"
  ("id","tenant_id","conversation_id","run_id","role","parts","client_message_id","state","generation_attempt","created_at","committed_at")
SELECT m->>'id', w.tenant_id, w.id, m->>'runId', m->>'role',
  jsonb_build_array(jsonb_build_object('kind','text','text', COALESCE(m->>'text',''))),
  CASE WHEN m->>'role'='user' THEN m->>'id' END,
  CASE WHEN COALESCE(m->>'status','committed')='committed' THEN 'committed' ELSE 'withdrawn' END,
  CASE WHEN m->>'role'='assistant'
    THEN COALESCE((SELECT (r->>'attempt')::int FROM jsonb_array_elements(w.state->'snapshot'->'runs') r
                   WHERE r->>'id' = m->>'runId' LIMIT 1),1) END,
  COALESCE((m->>'createdAt')::timestamptz, w.updated_at),
  CASE WHEN COALESCE(m->>'status','committed')='committed' THEN COALESCE((m->>'createdAt')::timestamptz, w.updated_at) END
FROM "legacy_writing_conversations" w, jsonb_array_elements(w.state->'snapshot'->'messages') m
WHERE m->>'role' IN ('user','assistant');--> statement-breakpoint
-- B. Legacy chat tasks rebuild QA conversations per provable subject.
INSERT INTO "ai_conversations"
  ("id","tenant_id","purpose","identity_id","visitor_id","site_id","scope_selection","context_revision",
   "target_document_id","configuration_id","creation_key","origin","event_sequence","status","created_at","updated_at")
SELECT 'ai_'||md5('qa:'||tenant_id||':'||subject_id), tenant_id, 'qa', subject_id, NULL, NULL,
  jsonb_build_object('kind','all'), 1, NULL, NULL, NULL, NULL, 0, 'active', min(created_at), max(updated_at)
FROM "legacy_ai_runs" WHERE input->'request'->>'kind' = 'chat'
GROUP BY tenant_id, subject_id;--> statement-breakpoint
INSERT INTO "ai_runs"
  ("id","tenant_id","conversation_id","purpose","idempotency_key","input_hash","context","status","attempt",
   "usage","error_code","cancel_requested","execution","created_at","updated_at","expires_at")
SELECT 'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), tenant_id,
  'ai_'||md5('qa:'||tenant_id||':'||subject_id), 'qa', request_id,
  CASE WHEN input_hash ~ '^sha256:[a-f0-9]{64}$' THEN input_hash WHEN input_hash ~ '^[a-f0-9]{64}$' THEN 'sha256:'||input_hash ELSE 'sha256:'||md5(input_hash)||md5(input_hash||'#2') END,
  jsonb_build_object('contextRevision',1,'scope',CASE WHEN jsonb_array_length(COALESCE(input->'sourceDocumentIds','[]'::jsonb))>0
    THEN jsonb_build_object('kind','documents','documentIds', input->'sourceDocumentIds')
    ELSE jsonb_build_object('kind','all') END,'retrieval',
    jsonb_build_object('contextTokenBudget',12000,'maxEvidenceItems',32,'maxRepairRounds',1)),
  CASE WHEN status='completed' AND result IS NOT NULL THEN 'completed' ELSE 'interrupted' END,
  GREATEST(attempt,1),
  jsonb_build_object('modelCalls',COALESCE((usage->>'modelCalls')::int,0),
    'inputTokens',COALESCE((usage->>'inputTokens')::int,0),'outputTokens',COALESCE((usage->>'outputTokens')::int,0),
    'searchCalls',COALESCE((usage->>'searchCalls')::int,0),'sourceReads',COALESCE((usage->>'sourceReads')::int,0),
    'webSearchCalls',0,'webReadCalls',0,'unknownCalls',
    CASE WHEN status='interrupted' AND error_code IS NULL THEN 1 ELSE 0 END),
  CASE WHEN status='completed' AND result IS NOT NULL THEN NULL ELSE COALESCE(NULLIF(error_code,''),'LEGACY_INTERRUPTED') END,
  cancel_requested,
  jsonb_strip_nulls(jsonb_build_object('evidenceRefs','[]'::jsonb,'steps','[]'::jsonb,
    'evidenceArtifactIds', CASE WHEN jsonb_typeof(input->'evidence'->'items')='array' AND jsonb_array_length(input->'evidence'->'items')>0
      THEN jsonb_build_array('art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|ev')) ELSE '[]'::jsonb END)),
  created_at, updated_at, now() + interval '7 days'
FROM "legacy_ai_runs" WHERE input->'request'->>'kind' = 'chat';--> statement-breakpoint
INSERT INTO "ai_messages"
  ("id","tenant_id","conversation_id","run_id","role","parts","client_message_id","state","generation_attempt","created_at","committed_at")
SELECT 'msg_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|u'), tenant_id,
  'ai_'||md5('qa:'||tenant_id||':'||subject_id), 'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'user',
  jsonb_build_array(jsonb_build_object('kind','text','text', COALESCE(input->'request'->>'message',''))),
  'legacy-'||request_id, 'committed', NULL, created_at, created_at
FROM "legacy_ai_runs" WHERE input->'request'->>'kind' = 'chat';--> statement-breakpoint
INSERT INTO "ai_messages"
  ("id","tenant_id","conversation_id","run_id","role","parts","state","generation_attempt","created_at","committed_at")
SELECT 'amsg_run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), tenant_id,
  'ai_'||md5('qa:'||tenant_id||':'||subject_id), 'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'assistant',
  jsonb_build_array(jsonb_build_object('kind','text','text', COALESCE(result->>'text',''))) ,
  'committed', attempt, updated_at, updated_at
FROM "legacy_ai_runs"
WHERE input->'request'->>'kind' = 'chat' AND status='completed' AND result IS NOT NULL;--> statement-breakpoint
-- Legacy chat evidence artifacts (converted to the sources+items contract; versions bound to
-- archived sourceVersions, never to a guessed current head).
INSERT INTO "ai_artifacts"
  ("id","tenant_id","conversation_id","run_id","purpose","producer_call_id","result_index","kind",
   "schema_version","state","payload","evidence_refs","created_at")
WITH expanded AS (
  SELECT r.tenant_id, r.subject_id, r.request_id, r.created_at,
    i.value AS item, r.input->'sourceVersions' AS versions
  FROM "legacy_ai_runs" r
  CROSS JOIN LATERAL jsonb_array_elements(r.input->'evidence'->'items') i(value)
  WHERE r.input->'request'->>'kind' = 'chat'
    AND jsonb_typeof(r.input->'evidence'->'items')='array'
), bundled AS (
  SELECT e.tenant_id, e.subject_id, e.request_id, e.created_at,
    jsonb_agg(jsonb_build_object(
        'evidenceId', e.item->>'evidenceId','sourceId', e.item->'source'->>'sourceId',
        'snapshotId', e.item->'source'->>'snapshotId','locator', e.item->'source'->'locator',
        'text', e.item->>'text')) AS items,
    jsonb_agg(DISTINCT jsonb_build_object(
      'sourceKind','document',
      'sourceId', e.item->'source'->>'sourceId',
      'snapshotId', e.item->'source'->>'snapshotId',
      'title', COALESCE(NULLIF(d.title,''), e.item->'source'->>'sourceId'),
      'workspaceId', COALESCE(d.workspace_id, 'removed'),
      'documentId', e.item->'source'->>'sourceId',
      'generationId', COALESCE((SELECT sv->>'generationId' FROM jsonb_array_elements(e.versions) sv
        WHERE sv->>'documentId' = e.item->'source'->>'sourceId' LIMIT 1), 'legacy'),
      'durableSeq', COALESCE((SELECT sv->>'durableSeq' FROM jsonb_array_elements(e.versions) sv
        WHERE sv->>'documentId' = e.item->'source'->>'sourceId' LIMIT 1), '0'),
      'metadataRevision', COALESCE((SELECT sv->>'metadataRevision' FROM jsonb_array_elements(e.versions) sv
        WHERE sv->>'documentId' = e.item->'source'->>'sourceId' LIMIT 1), '0'),
      'indexVersion', 'legacy')) AS sources
  FROM expanded e
  LEFT JOIN "documents" d ON d.tenant_id = e.tenant_id AND d.id = e.item->'source'->>'sourceId'
  GROUP BY 1,2,3,4
)
SELECT 'art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|ev'), tenant_id,
  'ai_'||md5('qa:'||tenant_id||':'||subject_id), 'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'qa',
  'legacy:evidence', 0, 'evidence', 1, 'committed',
  jsonb_build_object('freshness','current','items', items, 'sources', sources),
  (SELECT jsonb_agg(jsonb_build_object('evidenceArtifactId','art_'||md5(b.tenant_id||'|'||b.subject_id||'|'||b.request_id||'|ev'),
      'evidenceId', j->>'evidenceId'))
   FROM jsonb_array_elements(b.items) j),
  created_at
FROM bundled b;--> statement-breakpoint
-- C. Legacy authoring tasks rebuild writing conversations, evidence and proposal artifacts.
INSERT INTO "ai_conversations"
  ("id","tenant_id","purpose","identity_id","visitor_id","site_id","scope_selection","context_revision",
   "target_document_id","configuration_id","creation_key","origin","event_sequence","status","created_at","updated_at")
SELECT 'ai_'||md5('authoring:'||tenant_id||':'||subject_id||'|'||request_id), tenant_id, 'writing', subject_id,
  NULL, NULL,
  CASE WHEN jsonb_array_length(COALESCE(input->'sourceDocumentIds','[]'::jsonb))>0
    THEN jsonb_build_object('kind','documents','documentIds', input->'sourceDocumentIds')
    ELSE jsonb_build_object('kind','all') END,
  1, document_id, NULL, NULL, NULL, 0,
  CASE WHEN document_id IS NULL OR EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id=legacy_ai_runs.tenant_id AND d.id=legacy_ai_runs.document_id)
    THEN 'active' ELSE 'target-unavailable' END,
  created_at, updated_at
FROM "legacy_ai_runs" WHERE input->'request'->>'kind' = 'authoring';--> statement-breakpoint
INSERT INTO "ai_runs"
  ("id","tenant_id","conversation_id","purpose","idempotency_key","input_hash","context","status","attempt",
   "usage","error_code","cancel_requested","execution","created_at","updated_at","expires_at")
SELECT 'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), tenant_id,
  'ai_'||md5('authoring:'||tenant_id||':'||subject_id||'|'||request_id), 'writing', request_id,
  CASE WHEN input_hash ~ '^sha256:[a-f0-9]{64}$' THEN input_hash WHEN input_hash ~ '^[a-f0-9]{64}$' THEN 'sha256:'||input_hash ELSE 'sha256:'||md5(input_hash)||md5(input_hash||'#2') END,
  jsonb_strip_nulls(jsonb_build_object(
    'contextRevision',1,'webSearch',false,
    'scope', CASE WHEN jsonb_array_length(COALESCE(input->'sourceDocumentIds','[]'::jsonb))>0
      THEN jsonb_build_object('kind','documents','documentIds', input->'sourceDocumentIds')
      ELSE jsonb_build_object('kind','all') END,
    'capture', CASE WHEN input->'request'->'document' IS NOT NULL THEN jsonb_build_object(
      'document', input->'request'->'document',
      'structureRevision', COALESCE((input->'request'->>'baseStructureRevision')::int,0)) END,
    'request', CASE WHEN input->'request'->'target' IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
      'intent', input->'request'->>'intent','instruction',
      COALESCE(input->'request'->>'instruction','（旧任务迁移）'),
      'target', input->'request'->'target')) END)),
  CASE WHEN status='completed' AND result IS NOT NULL THEN 'completed' ELSE 'interrupted' END,
  GREATEST(attempt,1),
  jsonb_build_object('modelCalls',COALESCE((usage->>'modelCalls')::int,0),
    'inputTokens',COALESCE((usage->>'inputTokens')::int,0),'outputTokens',COALESCE((usage->>'outputTokens')::int,0),
    'searchCalls',COALESCE((usage->>'searchCalls')::int,0),'sourceReads',COALESCE((usage->>'sourceReads')::int,0),
    'webSearchCalls',0,'webReadCalls',0,'unknownCalls',
    CASE WHEN status='interrupted' THEN 1 ELSE 0 END),
  CASE WHEN status='completed' AND result IS NOT NULL THEN NULL ELSE COALESCE(NULLIF(error_code,''),'LEGACY_INTERRUPTED') END,
  cancel_requested,
  jsonb_build_object('evidenceRefs','[]'::jsonb,'steps','[]'::jsonb,
    'evidenceArtifactIds', CASE WHEN jsonb_typeof(input->'evidence'->'items')='array' AND jsonb_array_length(input->'evidence'->'items')>0
      THEN jsonb_build_array('art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|ev')) ELSE '[]'::jsonb END,
    'proposalArtifactIds', CASE WHEN result IS NOT NULL AND status='completed'
      THEN jsonb_build_array('art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|proposal')) ELSE '[]'::jsonb END),
  created_at, updated_at, now() + interval '7 days'
FROM "legacy_ai_runs" WHERE input->'request'->>'kind' = 'authoring';--> statement-breakpoint
INSERT INTO "ai_messages"
  ("id","tenant_id","conversation_id","run_id","role","parts","client_message_id","state","created_at","committed_at")
SELECT 'msg_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|a'), tenant_id,
  'ai_'||md5('authoring:'||tenant_id||':'||subject_id||'|'||request_id),
  'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'user',
  jsonb_build_array(jsonb_build_object('kind','text','text', COALESCE(input->'request'->>'instruction',''))),
  'legacy-'||request_id, 'committed', created_at, created_at
FROM "legacy_ai_runs" WHERE input->'request'->>'kind' = 'authoring';--> statement-breakpoint
INSERT INTO "ai_artifacts"
  ("id","tenant_id","conversation_id","run_id","purpose","producer_call_id","result_index","kind",
   "schema_version","state","payload","evidence_refs","created_at")
WITH expanded AS (
  SELECT r.tenant_id, r.subject_id, r.request_id, r.created_at,
    i.value AS item, r.input->'sourceVersions' AS versions
  FROM "legacy_ai_runs" r
  CROSS JOIN LATERAL jsonb_array_elements(r.input->'evidence'->'items') i(value)
  WHERE r.input->'request'->>'kind' = 'authoring'
    AND jsonb_typeof(r.input->'evidence'->'items')='array'
), bundled AS (
  SELECT e.tenant_id, e.subject_id, e.request_id, e.created_at,
    jsonb_agg(jsonb_build_object(
        'evidenceId', e.item->>'evidenceId','sourceId', e.item->'source'->>'sourceId',
        'snapshotId', e.item->'source'->>'snapshotId','locator', e.item->'source'->'locator',
        'text', e.item->>'text')) AS items,
    jsonb_agg(DISTINCT jsonb_build_object(
      'sourceKind','document',
      'sourceId', e.item->'source'->>'sourceId',
      'snapshotId', e.item->'source'->>'snapshotId',
      'title', COALESCE(NULLIF(d.title,''), e.item->'source'->>'sourceId'),
      'workspaceId', COALESCE(d.workspace_id, 'removed'),
      'documentId', e.item->'source'->>'sourceId',
      'generationId', COALESCE((SELECT sv->>'generationId' FROM jsonb_array_elements(e.versions) sv
        WHERE sv->>'documentId' = e.item->'source'->>'sourceId' LIMIT 1), 'legacy'),
      'durableSeq', COALESCE((SELECT sv->>'durableSeq' FROM jsonb_array_elements(e.versions) sv
        WHERE sv->>'documentId' = e.item->'source'->>'sourceId' LIMIT 1), '0'),
      'metadataRevision', COALESCE((SELECT sv->>'metadataRevision' FROM jsonb_array_elements(e.versions) sv
        WHERE sv->>'documentId' = e.item->'source'->>'sourceId' LIMIT 1), '0'),
      'indexVersion', 'legacy')) AS sources
  FROM expanded e
  LEFT JOIN "documents" d ON d.tenant_id = e.tenant_id AND d.id = e.item->'source'->>'sourceId'
  GROUP BY 1,2,3,4
)
SELECT 'art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|ev'), tenant_id,
  'ai_'||md5('authoring:'||tenant_id||':'||subject_id||'|'||request_id),
  'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'writing',
  'legacy:evidence', 0, 'evidence', 1, 'committed',
  jsonb_build_object('freshness','current','items', items, 'sources', sources),
  (SELECT jsonb_agg(jsonb_build_object('evidenceArtifactId','art_'||md5(b.tenant_id||'|'||b.subject_id||'|'||b.request_id||'|ev'),
      'evidenceId', j->>'evidenceId'))
   FROM jsonb_array_elements(b.items) j),
  created_at
FROM bundled b;--> statement-breakpoint
INSERT INTO "ai_artifacts"
  ("id","tenant_id","conversation_id","run_id","purpose","producer_call_id","result_index","kind",
   "schema_version","state","payload","evidence_refs","review_revision","review","application_state","receipt","created_at")
SELECT 'art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|proposal'), tenant_id,
  'ai_'||md5('authoring:'||tenant_id||':'||subject_id||'|'||request_id),
  'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'writing',
  'legacy:proposal', 0, 'proposal', 1, 'committed',
  jsonb_build_object(
    'document', result->'document',
    'baseStructureRevision', COALESCE((input->'request'->>'baseStructureRevision')::int,0),
    'target', result->'target',
    'operationBatch', result->'operationBatch',
    'summary', COALESCE(result->>'summary','（历史提案）'),
    'citations', COALESCE((SELECT jsonb_agg(
        jsonb_build_object(
          'citationId', c->>'citationId',
          'evidenceArtifactId', 'art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|ev'),
          'evidenceId', (SELECT i->>'evidenceId' FROM jsonb_array_elements(input->'evidence'->'items') i
            WHERE i->'source'->>'sourceId' = c->'source'->>'sourceId'
              AND i->'source'->>'snapshotId' = c->'source'->>'snapshotId'
              AND position(COALESCE(c->>'quote','') in COALESCE(i->>'text','')) > 0
            LIMIT 1),
          'locator', c->'source'->'locator',
          'quote', c->>'quote'))
      FROM jsonb_array_elements(result->'citations') c
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(input->'evidence'->'items') i
        WHERE i->'source'->>'sourceId' = c->'source'->>'sourceId'
          AND i->'source'->>'snapshotId' = c->'source'->>'snapshotId'
          AND position(COALESCE(c->>'quote','') in COALESCE(i->>'text','')) > 0)
    ), '[]'::jsonb)),
  COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
      'evidenceArtifactId','art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|ev'),
      'evidenceId', c2->>'evidenceId'))
    FROM jsonb_array_elements(result->'citations') c2), '[]'::jsonb),
  COALESCE((review->>'revision')::int, 0),
  CASE WHEN review IS NULL THEN NULL ELSE jsonb_build_object(
    'revision', COALESCE((review->>'revision')::int,0),
    'decisions', COALESCE(review->'decisions','[]'::jsonb),
    'receipts', COALESCE(review->'receipts','{}'::jsonb)) END,
  CASE
    WHEN receipt IS NOT NULL THEN 'applied'
    WHEN application_state IN ('partial','applied','rejected','conflict') THEN application_state
    WHEN application_state IN ('pending','blocked') THEN 'pending'
    ELSE 'pending' END,
  receipt, updated_at
FROM "legacy_ai_runs"
WHERE input->'request'->>'kind' = 'authoring' AND status='completed' AND result IS NOT NULL;--> statement-breakpoint
INSERT INTO "ai_messages"
  ("id","tenant_id","conversation_id","run_id","role","parts","state","generation_attempt","created_at","committed_at")
SELECT 'amsg_run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), tenant_id,
  'ai_'||md5('authoring:'||tenant_id||':'||subject_id||'|'||request_id),
  'run_'||md5(tenant_id||'|'||subject_id||'|'||request_id), 'assistant',
  jsonb_build_array(
    jsonb_build_object('kind','text','text', COALESCE(result->>'summary','文章提案已生成，等待确认。')),
    jsonb_build_object('kind','artifact','artifactId','art_'||md5(tenant_id||'|'||subject_id||'|'||request_id||'|proposal'),
      'artifactKind','proposal','summary', COALESCE(result->>'summary',''))),
  'committed', attempt, updated_at, updated_at
FROM "legacy_ai_runs"
WHERE input->'request'->>'kind' = 'authoring' AND status='completed' AND result IS NOT NULL;--> statement-breakpoint
-- D. Finish archive cleanup: legacy native sessions never restore into the new runtime;
-- unresolvable image jobs remain only in the pre-migration audit export.
DELETE FROM "legacy_writing_sessions";--> statement-breakpoint
DROP TABLE "legacy_writing_events";--> statement-breakpoint
DROP TABLE "legacy_writing_sessions";--> statement-breakpoint
DROP TABLE "legacy_writing_image_jobs";--> statement-breakpoint
DROP TABLE "legacy_ai_runs";--> statement-breakpoint
DROP TABLE "legacy_writing_conversations";
