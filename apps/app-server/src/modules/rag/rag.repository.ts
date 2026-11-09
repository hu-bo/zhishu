import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DocumentContent, DocumentSnapshot } from "@zhishu/document-contracts";

export interface IndexJob {
  tenantId: string;
  documentId: string;
  workspaceId: string | null;
  leaseToken: string;
  generationId: string | null;
  durableSeq: string | null;
  metadataRevision: number | null;
  schemaVersion: number;
  snapshotRevision: number;
  extensions: DocumentSnapshot["extensions"];
  content: DocumentContent;
}
export interface PublishedIndex {
  documentId: string;
  activeIndexVersion: string | null;
  generationId: string | null;
  durableSeq: string | null;
  metadataRevision: number | null;
  configFingerprint: string | null;
  snapshotId: string | null;
  chunkCount: number;
  lastErrorCode: string | null;
}
export class RagRepository {
  constructor(private readonly pool: Pool) {}
  async claim(fingerprint: string, leaseMs: number): Promise<IndexJob | undefined> {
    // Discover dirty durable projections without competing with the document outbox consumer.
    await this.pool.query(`insert into document_indexes (tenant_id, document_id)
      select d.tenant_id, d.id from documents d where d.status = 'active'
      and not exists (select 1 from document_indexes i where i.tenant_id=d.tenant_id and i.document_id=d.id)
      limit 100 on conflict do nothing`);
    const leaseToken = randomUUID();
    const result = await this.pool.query<IndexJob>(
      `with candidate as (
      select i.tenant_id, i.document_id from document_indexes i
      left join documents d on d.tenant_id=i.tenant_id and d.id=i.document_id
      left join document_generations g on g.document_id=d.id and g.status='active'
      left join document_projection_snapshots p on p.tenant_id=d.tenant_id and p.document_id=d.id and p.generation_id=g.id
      where (i.lease_until is null or i.lease_until < now())
      and (i.available_at <= now() or (i.last_error_code='DOCUMENT_REMOVED' and d.status='active'))
      and (d.id is null or d.status <> 'active' or (p.durable_seq=g.durable_seq and (
        i.active_index_version is null or i.generation_id is distinct from g.id
        or i.durable_seq is distinct from g.durable_seq::text or i.metadata_revision is distinct from d.metadata_revision
        or i.config_fingerprint is distinct from $1)))
      order by i.available_at, i.updated_at limit 1 for update of i skip locked
    ), claimed as (
      update document_indexes i set lease_token=$2, lease_until=now()+$3*interval '1 millisecond', updated_at=now()
      from candidate c where i.tenant_id=c.tenant_id and i.document_id=c.document_id returning i.*
    ) select i.tenant_id as "tenantId", i.document_id as "documentId", i.lease_token as "leaseToken",
      case when d.status='active' then d.workspace_id else null end as "workspaceId",
      g.id as "generationId", g.durable_seq::text as "durableSeq", d.metadata_revision as "metadataRevision",
      g.schema_version as "schemaVersion", p.snapshot_revision as "snapshotRevision", g.extensions, p.content
      from claimed i left join documents d on d.tenant_id=i.tenant_id and d.id=i.document_id
      left join document_generations g on g.document_id=d.id and g.status='active'
      left join document_projection_snapshots p on p.tenant_id=d.tenant_id and p.document_id=d.id and p.generation_id=g.id`,
      [fingerprint, leaseToken, leaseMs],
    );
    return result.rows[0];
  }
  async publish(
    job: IndexJob,
    fingerprint: string,
    summary: { snapshotId: string; chunkCount: number },
  ) {
    const result = await this.pool.query(
      `update document_indexes i set active_index_version=$3,
      generation_id=$4, durable_seq=$5, metadata_revision=$6, config_fingerprint=$7,
      snapshot_id=$8, chunk_count=$9, lease_token=null, lease_until=null, attempts=0,
      last_error_code=null, available_at=now(), updated_at=now()
      where i.tenant_id=$1 and i.document_id=$2 and i.lease_token=$3 and i.lease_until > now()
      and exists (select 1 from documents d join document_generations g on g.document_id=d.id and g.status='active'
        where d.tenant_id=$1 and d.id=$2 and d.status='active' and d.workspace_id=$10
        and g.id=$4 and g.durable_seq::text=$5 and d.metadata_revision=$6)`,
      [
        job.tenantId,
        job.documentId,
        job.leaseToken,
        job.generationId,
        job.durableSeq,
        job.metadataRevision,
        fingerprint,
        summary.snapshotId,
        summary.chunkCount,
        job.workspaceId,
      ],
    );
    return result.rowCount === 1;
  }
  async release(job: IndexJob, error: string | null, removed = false) {
    await this.pool.query(
      `update document_indexes set lease_token=null, lease_until=null,
      active_index_version=case when $5 then null else active_index_version end,
      attempts=case when $4::text is null then 0 else least(attempts+1,10) end, last_error_code=$4,
      available_at=now()+(case when $5 then 60000 when $4::text is null then 0 else least(300000,1000*power(2,least(attempts,8))) end)*interval '1 millisecond', updated_at=now()
      where tenant_id=$1 and document_id=$2 and lease_token=$3`,
      [job.tenantId, job.documentId, job.leaseToken, error, removed],
    );
  }
  async protectedVersions(tenantId: string, documentId: string) {
    const result = await this.pool.query<{ version: string | null }>(
      `select active_index_version::text as version from document_indexes where tenant_id=$1 and document_id=$2
      union select lease_token::text from document_indexes where tenant_id=$1 and document_id=$2`,
      [tenantId, documentId],
    );
    return result.rows.flatMap((r) => (r.version ? [r.version] : []));
  }
  async indexes(tenantId: string, ids: readonly string[]): Promise<PublishedIndex[]> {
    if (!ids.length) return [];
    const result = await this.pool.query<PublishedIndex>(
      `select document_id as "documentId", active_index_version as "activeIndexVersion",
      generation_id as "generationId", durable_seq as "durableSeq", metadata_revision as "metadataRevision",
      config_fingerprint as "configFingerprint", snapshot_id as "snapshotId", chunk_count as "chunkCount", last_error_code as "lastErrorCode"
      from document_indexes where tenant_id=$1 and document_id=any($2::text[])`,
      [tenantId, ids],
    );
    return result.rows;
  }
}
