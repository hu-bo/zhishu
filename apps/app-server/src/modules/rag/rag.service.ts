import { createKnowledgeRetriever, writeDocumentIndex } from "@zhishu/rag";
import type { EvidenceBundle, EvidenceItem } from "@zhishu/ai-contracts";
import type { ScopeSelection } from "@zhishu/ai-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../../database/index.js";
import { documentGenerations, documents, workspaces } from "../../../database/schema/index.js";
import type { AiDocumentAccess } from "../documents/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { AppConfig } from "../../config.js";
import type { createRagClients } from "./rag.config.js";
import { RagRepository, type IndexJob, type PublishedIndex } from "./rag.repository.js";

type Clients = NonNullable<ReturnType<typeof createRagClients>>;
type Head = {
  documentId: string;
  workspaceId: string;
  title: string;
  metadataRevision: number;
  generationId: string;
  durableSeq: number;
};
export type WorkspaceLabel = { workspaceId: string; name: string };

/** Trusted retrieval scope: the current principal, or one site's pre-validated approved set. */
export type RetrievalScope =
  | { kind: "principal"; principal: Principal; selection: ScopeSelection }
  | {
      kind: "site";
      tenantId: string;
      /** Approved pairs resolved by qa-sites after continuous delegation validation. */
      approved: readonly { documentId: string; workspaceId: string; publicLabel: string }[];
      /** Optional in-site narrowing chosen by the visitor. */
      documentIds?: readonly string[];
    };

const currentIndex = (head: Head, index: PublishedIndex | undefined, fingerprint: string) =>
  !!index?.activeIndexVersion &&
  index.generationId === head.generationId &&
  index.durableSeq === String(head.durableSeq) &&
  index.metadataRevision === head.metadataRevision &&
  index.configFingerprint === fingerprint;

export class RagService {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private shutdown = new AbortController();
  constructor(
    private readonly repository: RagRepository,
    private readonly documents: AiDocumentAccess,
    private readonly db: Database,
    private readonly clients: Clients,
    private readonly config: AppConfig,
    private readonly logFailure: (code: string) => void,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }
  async close() {
    this.stopped = true;
    this.shutdown.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
  private async tick() {
    if (this.stopped) return;
    this.running = this.processNext()
      .then(() => undefined)
      .catch(() => this.logFailure("INDEX_WORKER_FAILED"));
    await this.running;
    this.running = undefined;
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.tick(), this.config.RAG_POLL_INTERVAL_MS);
      this.timer.unref();
    }
  }
  async processNext() {
    const job = await this.repository.claim(
      this.clients.fingerprint,
      this.config.AI_TIMEOUT_MS + 30000,
      this.config.RAG_INDEX_QUIET_MS,
      this.config.RAG_INDEX_MAX_WAIT_MS,
    );
    if (!job) return false;
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(this.config.AI_TIMEOUT_MS),
    ]);
    try {
      if (!job.workspaceId) {
        await this.clients.client.delete(this.clients.index.collectionName, {
          wait: true,
          filter: {
            must: [
              { key: "metadata.tenantId", match: { value: job.tenantId } },
              { key: "metadata.documentId", match: { value: job.documentId } },
            ],
          },
        });
        await this.repository.release(job, "DOCUMENT_REMOVED", true);
      } else {
        const durableSeq = Number(job.durableSeq);
        if (!Number.isSafeInteger(durableSeq)) throw new Error("UNSAFE_DURABLE_SEQ");
        const summary = await writeDocumentIndex({
          ...this.clients,
          options: this.clients.index,
          tenantId: job.tenantId,
          workspaceId: job.workspaceId,
          documentTitle: job.documentTitle ?? job.documentId,
          indexVersion: job.leaseToken,
          metadataRevision: String(job.metadataRevision),
          aclRevision: "1",
          readAclKeys: [`document:${job.documentId}`],
          signal,
          batchSize: this.config.AI_EMBEDDING_BATCH_SIZE,
          snapshot: {
            documentId: job.documentId,
            generationId: job.generationId!,
            durableSeq,
            schemaVersion: job.schemaVersion,
            snapshotRevision: job.snapshotRevision,
            extensions: job.extensions,
            content: job.content,
          },
        });
        if (!(await this.repository.publish(job, this.clients.fingerprint, summary)))
          await this.repository.release(job, null);
        await this.cleanup(job);
      }
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error ? error.status : undefined;
      let code = "INDEX_PROVIDER_FAILED";
      if (status === 401 || status === 403) code = "EMBEDDING_AUTH_FAILED";
      else if (status === 404) code = "RAG_ENDPOINT_NOT_FOUND";
      else if (signal.aborted) code = "INDEX_TIMEOUT";
      else if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) code = error.message;
      await this.repository.release(job, code);
      this.logFailure(code);
      await this.cleanup(job).catch(() => undefined);
    }
    return true;
  }
  private async cleanup(job: IndexJob) {
    // Only delete versions already observed in Qdrant and subsequently proven unprotected in SQL.
    const points = await this.clients.client.scroll(this.clients.index.collectionName, {
      limit: 256,
      with_vector: false,
      with_payload: { include: ["metadata.indexVersion"] },
      filter: {
        must: [
          { key: "metadata.tenantId", match: { value: job.tenantId } },
          { key: "metadata.documentId", match: { value: job.documentId } },
        ],
      },
    });
    const protectedVersions = new Set(
      await this.repository.protectedVersions(job.tenantId, job.documentId),
    );
    const obsolete = new Set(
      points.points.flatMap((p) => {
        const metadata = p.payload?.metadata as Record<string, unknown> | undefined;
        return typeof metadata?.indexVersion === "string" &&
          !protectedVersions.has(metadata.indexVersion)
          ? [metadata.indexVersion]
          : [];
      }),
    );
    for (const version of obsolete)
      await this.clients.client.delete(this.clients.index.collectionName, {
        wait: true,
        filter: {
          must: [
            { key: "metadata.tenantId", match: { value: job.tenantId } },
            { key: "metadata.documentId", match: { value: job.documentId } },
            { key: "metadata.indexVersion", match: { value: version } },
          ],
        },
      });
  }

  /** Heads for one trusted scope. Vector ACLs are only candidate prefilters, never authority. */
  private async heads(scope: RetrievalScope): Promise<Head[]> {
    if (scope.kind === "principal") {
      const selection = scope.selection;
      if (selection.kind === "workspaces") {
        const per: Head[] = [];
        for (const workspaceId of selection.workspaceIds)
          per.push(...(await this.headsForWorkspace(scope.principal, workspaceId)));
        return per;
      }
      if (selection.kind === "documents")
        return this.headsForWorkspace(scope.principal, undefined, selection.documentIds);
      return this.headsForWorkspace(scope.principal);
    }
    const ids = scope.documentIds ?? scope.approved.map((a) => a.documentId);
    if (!ids.length) return [];
    const pairs = scope.approved.filter((a) => ids.includes(a.documentId));
    if (!pairs.length) return [];
    const rows = await this.db
      .select({
        documentId: documents.id,
        workspaceId: documents.workspaceId,
        title: documents.title,
        metadataRevision: documents.metadataRevision,
        generationId: documentGenerations.id,
        durableSeq: documentGenerations.durableSeq,
      })
      .from(documents)
      .innerJoin(
        documentGenerations,
        and(
          eq(documentGenerations.documentId, documents.id),
          eq(documentGenerations.status, "active"),
        ),
      )
      .where(
        and(
          eq(documents.tenantId, scope.tenantId),
          eq(documents.status, "active"),
          inArray(documents.id, [...ids]),
          sql`(${documents.workspaceId}, ${documents.id}) in (${sql.join(
            pairs.map((p) => sql`(${p.workspaceId}, ${p.documentId})`),
            sql`, `,
          )})`,
        ),
      )
      .limit(10001);
    return rows.map((r) => ({
      documentId: r.documentId,
      workspaceId: r.workspaceId,
      title: r.title,
      metadataRevision: r.metadataRevision,
      generationId: r.generationId,
      durableSeq: Number(r.durableSeq),
    }));
  }

  private async headsForWorkspace(
    principal: Principal,
    workspaceId?: string,
    documentIds?: readonly string[],
  ): Promise<Head[]> {
    const heads = await this.documents.readableHeads(principal, workspaceId, documentIds);
    if (heads.length > 10000)
      throw new DomainError("VALIDATION_ERROR", "资料范围过大，请选择具体空间或文档");
    if (documentIds?.some((id) => !heads.some((h) => h.documentId === id)))
      throw new DomainError("AI_ACCESS_REVOKED", "所选文档已不可访问或没有 AI 权限");
    return heads.map((h) => ({
      documentId: h.documentId,
      workspaceId: h.workspaceId,
      title: h.title,
      metadataRevision: h.metadataRevision,
      generationId: h.generationId,
      durableSeq: Number(h.durableSeq),
    }));
  }

  /** Coverage per scope: ready-only retrieval with explicit X/Y. */
  async coverage(
    scope: RetrievalScope,
  ): Promise<{ totalDocuments: number; readyDocuments: number }> {
    const heads = await this.heads(scope);
    const indexes = await this.repository.indexes(
      scope.kind === "principal" ? scope.principal.tenantId : scope.tenantId,
      heads.map((h) => h.documentId),
    );
    const ready = heads.filter((h) =>
      currentIndex(
        h,
        indexes.find((i) => i.documentId === h.documentId),
        this.clients.fingerprint,
      ),
    ).length;
    return { totalDocuments: heads.length, readyDocuments: ready };
  }

  private async verifyItems(
    scope: RetrievalScope,
    items: readonly EvidenceItem[],
    heads: Head[],
  ): Promise<boolean> {
    if (!items.length) return true;
    const tenantId = scope.kind === "principal" ? scope.principal.tenantId : scope.tenantId;
    return this.repository
      .indexes(tenantId, [...new Set(items.map((i) => i.sourceId))])
      .then((indexes) =>
        items.every((item) => {
          const head = heads.find((h) => h.documentId === item.sourceId);
          const index = indexes.find((i) => i.documentId === item.sourceId);
          return (
            !!head &&
            currentIndex(head, index, this.clients.fingerprint) &&
            index?.snapshotId === item.snapshotId
          );
        }),
      );
  }

  async retrieve(
    scope: RetrievalScope,
    query: string,
    contextTokenBudget: number,
    signal: AbortSignal,
  ): Promise<{
    evidence: EvidenceBundle;
    coverage: { totalDocuments: number; readyDocuments: number };
  }> {
    const heads = await this.heads(scope);
    const indexes = await this.repository.indexes(
      scope.kind === "principal" ? scope.principal.tenantId : scope.tenantId,
      heads.map((h) => h.documentId),
    );
    const readyHeads = heads.filter((h) =>
      currentIndex(
        h,
        indexes.find((i) => i.documentId === h.documentId),
        this.clients.fingerprint,
      ),
    );
    const coverage = { totalDocuments: heads.length, readyDocuments: readyHeads.length };
    if (!heads.length) throw new DomainError("VALIDATION_ERROR", "所选范围内没有可用资料");
    if (!readyHeads.length)
      throw new DomainError("SERVICE_UNAVAILABLE", "资料尚未完成索引，请稍后再试");
    const workspaceNames = await this.workspaceNames(
      scope.kind === "principal" ? scope.principal.tenantId : scope.tenantId,
      readyHeads,
      scope.kind === "site" ? scope.approved : undefined,
    );
    const retriever = createKnowledgeRetriever<RetrievalScope>({
      ...this.clients,
      index: this.clients.index,
      candidateLimit: 16,
      maxCandidates: 64,
      resolveScope: async (s) => {
        const resolved = await this.heads(s);
        const ids = new Set(resolved.map((h) => h.documentId));
        return {
          tenantId: s.kind === "principal" ? s.principal.tenantId : s.tenantId,
          workspaceIds: [...new Set(resolved.map((h) => h.workspaceId))],
          documentIds:
            s.kind === "principal" && s.selection.kind === "documents"
              ? s.selection.documentIds.filter((id) => ids.has(id))
              : [...ids],
          readAclKeys: resolved.map((h) => `document:${h.documentId}`),
        };
      },
      authorizeCandidates: async (s, candidates) => {
        const resolved = await this.heads(s);
        const indexesNow = await this.repository.indexes(
          s.kind === "principal" ? s.principal.tenantId : s.tenantId,
          [...new Set(candidates.map((c) => c.documentId))],
        );
        return candidates
          .filter((c) => {
            const head = resolved.find((h) => h.documentId === c.documentId);
            const index = indexesNow.find((i) => i.documentId === c.documentId);
            return (
              !!head &&
              currentIndex(head, index, this.clients.fingerprint) &&
              c.indexVersion === index?.activeIndexVersion &&
              c.snapshotId === index.snapshotId &&
              c.generationId === head.generationId &&
              c.durableSeq === String(head.durableSeq) &&
              c.metadataRevision === String(head.metadataRevision)
            );
          })
          .map((c) => c.pointId);
      },
      verifyEvidence: async (s, items) => {
        const resolved = await this.heads(s);
        return this.verifyItems(s, items, resolved);
      },
      describeWorkspace: async (_s, workspaceId) => workspaceNames.get(workspaceId) ?? null,
    });
    try {
      const evidence = await retriever.retrieve({ query, scope, contextTokenBudget, signal });
      // Bind versions to the evidence actually retrieved, never to a newer document head.
      if (
        !verifyBundleBindings(evidence, await this.heads(scope), indexes, this.clients.fingerprint)
      )
        throw new DomainError("AI_ACCESS_REVOKED", "资料在检索期间已更新，请重新提问");
      return { evidence, coverage };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "知识检索暂不可用，请检查向量模型与 Qdrant 配置后重试",
      );
    }
  }

  /** Labels the current audience may see: internal space names, site public labels. */
  private async workspaceNames(
    tenantId: string,
    heads: Head[],
    approvedSitePairs?: readonly { documentId: string; workspaceId: string; publicLabel: string }[],
  ): Promise<Map<string, string>> {
    if (approvedSitePairs) {
      return new Map(approvedSitePairs.map((p) => [p.workspaceId, p.publicLabel]));
    }
    const ids = [...new Set(heads.map((h) => h.workspaceId))];
    if (!ids.length) return new Map();
    const rows = await this.db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), inArray(workspaces.id, ids)));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** Delivery-bound re-authorization for evidence stored in artifacts (revocation checks). */
  async verifyStoredEvidence(
    scope: RetrievalScope,
    items: readonly EvidenceItem[],
  ): Promise<boolean> {
    const heads = await this.heads(scope);
    return this.verifyItems(scope, items, heads);
  }
}

function verifyBundleBindings(
  evidence: EvidenceBundle,
  heads: Head[],
  indexes: PublishedIndex[],
  fingerprint: string,
): boolean {
  return evidence.items.every((item) => {
    const head = heads.find((h) => h.documentId === item.sourceId);
    const index = indexes.find((i) => i.documentId === item.sourceId);
    return (
      !!head && currentIndex(head, index, fingerprint) && index?.snapshotId === item.snapshotId
    );
  });
}
