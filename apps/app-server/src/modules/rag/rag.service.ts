import { createKnowledgeRetriever, writeDocumentIndex } from "@zhishu/rag";
import type { EvidenceItem } from "@zhishu/ai-contracts";
import type { AiDocumentAccess } from "../documents/index.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import type { AppConfig } from "../../config.js";
import type { createRagClients } from "./rag.config.js";
import { RagRepository, type IndexJob, type PublishedIndex } from "./rag.repository.js";

type Clients = NonNullable<ReturnType<typeof createRagClients>>;
type Head = Awaited<ReturnType<AiDocumentAccess["readableHeads"]>>[number];
type Scope = { principal: Principal; workspaceId?: string; documentIds?: string[] };
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
      const code =
        status === 401 || status === 403
          ? "EMBEDDING_AUTH_FAILED"
          : status === 404
            ? "RAG_ENDPOINT_NOT_FOUND"
            : signal.aborted
              ? "INDEX_TIMEOUT"
              : error instanceof Error && /^[A-Z_]+$/.test(error.message)
                ? error.message
                : "INDEX_PROVIDER_FAILED";
      await this.repository.release(job, code);
      this.logFailure(code);
      await this.cleanup(job).catch(() => undefined);
    }
    return true;
  }
  private async cleanup(job: IndexJob) {
    // Only delete versions already observed in Qdrant and subsequently proven unprotected in SQL.
    // A filter excluding "current" versions could race a newly claimed build.
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
  private async heads(scope: Scope) {
    const heads = await this.documents.readableHeads(
      scope.principal,
      scope.workspaceId,
      scope.documentIds,
    );
    if (heads.length > 10000)
      throw new DomainError("VALIDATION_ERROR", "资料范围过大，请选择具体空间或文档");
    if (scope.documentIds?.some((id) => !heads.some((h) => h.documentId === id)))
      throw new DomainError("AI_ACCESS_REVOKED", "所选文档已不可访问或没有 AI 权限");
    return heads;
  }
  async status(scope: Scope) {
    const heads = await this.heads(scope),
      indexes = await this.repository.indexes(
        scope.principal.tenantId,
        heads.map((h) => h.documentId),
      );
    let ready = 0,
      failed = 0;
    const errors = new Set<string>();
    for (const head of heads) {
      const index = indexes.find((i) => i.documentId === head.documentId);
      if (currentIndex(head, index, this.clients.fingerprint)) ready++;
      else if (index?.lastErrorCode) {
        failed++;
        errors.add(index.lastErrorCode);
      }
    }
    return {
      total: heads.length,
      ready,
      pending: heads.length - ready - failed,
      failed,
      errors: [...errors],
    };
  }
  async retrieve(scope: Scope, query: string, signal: AbortSignal) {
    const retriever = createKnowledgeRetriever<Scope>({
      ...this.clients,
      index: this.clients.index,
      candidateLimit: 16,
      maxCandidates: 64,
      resolveScope: async (s) => {
        const heads = await this.heads(s);
        return {
          tenantId: s.principal.tenantId,
          workspaceIds: [...new Set(heads.map((h) => h.workspaceId))],
          documentIds: s.documentIds,
          readAclKeys: heads.map((h) => `document:${h.documentId}`),
        };
      },
      authorizeCandidates: async (s, candidates) => {
        const heads = await this.heads(s),
          indexes = await this.repository.indexes(s.principal.tenantId, [
            ...new Set(candidates.map((c) => c.documentId)),
          ]);
        return candidates
          .filter((c) => {
            const head = heads.find((h) => h.documentId === c.documentId),
              index = indexes.find((i) => i.documentId === c.documentId);
            return (
              head &&
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
      verifyEvidence: async (s, items) => this.verifyEvidence(s, items),
    });
    try {
      const status = await this.status(scope);
      if (status.pending || status.failed)
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          status.failed ? "资料向量化失败，请检查索引状态后重试" : "资料正在向量化，请稍后再提问",
        );
      const evidence = await retriever.retrieve({
        query,
        scope,
        contextTokenBudget: 12000,
        signal,
      });
      const ids = [...new Set(evidence.items.map((i) => i.source.sourceId))];
      const heads = await this.heads({ ...scope, documentIds: ids });
      const indexes = await this.repository.indexes(scope.principal.tenantId, ids);
      // Bind versions to the evidence actually retrieved, never to a newer document head.
      if (
        !evidence.items.every((item) => {
          const index = indexes.find((i) => i.documentId === item.source.sourceId),
            head = heads.find((h) => h.documentId === item.source.sourceId);
          return (
            head &&
            currentIndex(head, index, this.clients.fingerprint) &&
            item.source.snapshotId === index?.snapshotId
          );
        })
      )
        throw new DomainError("AI_ACCESS_REVOKED", "资料在检索期间已更新，请重新提问");
      return {
        evidence,
        sourceVersions: indexes.map((i) => ({
          documentId: i.documentId,
          generationId: i.generationId!,
          durableSeq: Number(i.durableSeq),
          metadataRevision: i.metadataRevision!,
        })),
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "知识检索暂不可用，请检查向量模型与 Qdrant 配置后重试",
      );
    }
  }
  private async verifyEvidence(scope: Scope, items: readonly EvidenceItem[]) {
    const heads = await this.heads(scope),
      indexes = await this.repository.indexes(
        scope.principal.tenantId,
        items.map((i) => i.source.sourceId),
      );
    return items.every((item) => {
      const head = heads.find((h) => h.documentId === item.source.sourceId),
        index = indexes.find((i) => i.documentId === item.source.sourceId);
      return (
        head &&
        currentIndex(head, index, this.clients.fingerprint) &&
        index?.snapshotId === item.source.snapshotId
      );
    });
  }
}
