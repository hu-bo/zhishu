import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import type { Embeddings } from "@langchain/core/embeddings";
import type { EvidenceBundle, EvidenceItem } from "@zhishu/ai-contracts";
import { configurationFingerprint, conservativeTokenCount, type IndexOptions } from "./chunks.js";
import { readPointEvidence, validAclKeys, validateVectors } from "./qdrant.js";

export interface KnowledgeRetriever<Scope> {
  retrieve(input: {
    query: string;
    scope: Scope;
    contextTokenBudget: number;
    signal: AbortSignal;
  }): Promise<EvidenceBundle>;
}
const fields = [
  "tenantId",
  "workspaceId",
  "documentId",
  "indexVersion",
  "generationId",
  "durableSeq",
  "metadataRevision",
  "aclRevision",
  "configFingerprint",
  "sourceState",
  "snapshotId",
] as const;
type Candidate = {
  pointId: string | number;
  score: number;
  tenantId: string;
  workspaceId: string;
  documentId: string;
  indexVersion: string;
  generationId: string;
  durableSeq: string;
  metadataRevision: string;
  aclRevision: string;
  configFingerprint: string;
  sourceState: string;
  snapshotId: string;
};
function metadataOf(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const m = payload?.metadata;
  return m && typeof m === "object" ? (m as Record<string, unknown>) : undefined;
}
/** Callbacks must read current authoritative relations. Scope is an application-owned server context. */
export function createKnowledgeRetriever<Scope>(options: {
  client: QdrantClient;
  embeddings: Embeddings;
  index: IndexOptions;
  resolveScope(
    scope: Scope,
    signal: AbortSignal,
  ): Promise<{
    tenantId: string;
    workspaceIds: readonly string[];
    documentIds?: readonly string[];
    readAclKeys: readonly string[];
  }>;
  authorizeCandidates(
    scope: Scope,
    candidates: readonly Candidate[],
    signal: AbortSignal,
  ): Promise<readonly (string | number)[]>;
  verifyEvidence(
    scope: Scope,
    items: readonly EvidenceItem[],
    signal: AbortSignal,
  ): Promise<boolean>;
  candidateLimit?: number;
  maxCandidates?: number;
  maxAclBatchBytes?: number;
  maxAclKeys?: number;
  maxQueryCalls?: number;
}): KnowledgeRetriever<Scope> {
  const fingerprint = configurationFingerprint(options.index),
    limit = options.candidateLimit ?? 32,
    maxCandidates = options.maxCandidates ?? 256,
    maxBytes = options.maxAclBatchBytes ?? 8_192;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < limit ||
    maxCandidates > 4096 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 256
  )
    throw new Error("INVALID_RETRIEVAL_OPTIONS");
  return {
    async retrieve(input) {
      const { signal } = input;
      signal.throwIfAborted();
      if (
        !input.query.trim() ||
        Buffer.byteLength(input.query) > 32_768 ||
        !Number.isSafeInteger(input.contextTokenBudget) ||
        input.contextTokenBudget < 0
      )
        throw new Error("INVALID_QUERY");
      const scope = await options.resolveScope(input.scope, signal);
      if (
        !scope.tenantId ||
        !scope.workspaceIds.length ||
        !scope.readAclKeys.length ||
        input.contextTokenBudget === 0 ||
        scope.documentIds?.length === 0
      )
        return { items: [], freshness: "current" };
      if (
        !validAclKeys(scope.readAclKeys) ||
        scope.readAclKeys.length > (options.maxAclKeys ?? 20_000)
      )
        throw new Error("INVALID_AUTHORIZATION_SCOPE");
      const batches: string[][] = [];
      let batch: string[] = [],
        bytes = 2;
      for (const key of new Set(scope.readAclKeys)) {
        const size = Buffer.byteLength(JSON.stringify(key)) + 1;
        if (size > maxBytes) throw new Error("AUTHORIZATION_KEY_TOO_LARGE");
        if (bytes + size > maxBytes) {
          batches.push(batch);
          batch = [];
          bytes = 2;
        }
        batch.push(key);
        bytes += size;
      }
      if (batch.length) batches.push(batch);
      const vector = await options.embeddings.embedQuery(input.query);
      signal.throwIfAborted();
      validateVectors([vector], 1, options.index.dimensions);
      const all = new Map<string | number, Candidate>();
      const seenByBatch = batches.map(() => new Set<string | number>());
      let queryCalls = 0;
      for (let offset = 0; offset < maxCandidates; offset += limit) {
        let more = false;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          const keys = batches[batchIndex]!,
            seen = seenByBatch[batchIndex]!;
          signal.throwIfAborted();
          if (++queryCalls > (options.maxQueryCalls ?? 128))
            throw new Error("RETRIEVAL_BUDGET_EXCEEDED");
          const must: Schemas["Condition"][] = [
            { key: "metadata.tenantId", match: { value: scope.tenantId } },
            { key: "metadata.workspaceId", match: { any: [...scope.workspaceIds] } },
            { key: "metadata.readAclKeys", match: { any: keys } },
            { key: "metadata.configFingerprint", match: { value: fingerprint } },
            { key: "metadata.sourceState", match: { value: "active" } },
          ];
          if (scope.documentIds)
            must.push({ key: "metadata.documentId", match: { any: [...scope.documentIds] } });
          const response = await options.client.query(options.index.collectionName, {
            query: vector,
            filter: { must, ...(seen.size ? { must_not: [{ has_id: [...seen] }] } : {}) },
            limit: Math.min(limit, maxCandidates - offset),
            with_vector: false,
            with_payload: { include: fields.map((key) => `metadata.${key}`) },
          });
          signal.throwIfAborted();
          more ||= response.points.length === limit;
          for (const point of response.points) {
            seen.add(point.id);
            const m = metadataOf(point.payload);
            if (
              !m ||
              !fields.every((key) => typeof m[key] === "string") ||
              !Number.isFinite(point.score) ||
              m.tenantId !== scope.tenantId ||
              !scope.workspaceIds.includes(String(m.workspaceId)) ||
              (scope.documentIds && !scope.documentIds.includes(String(m.documentId))) ||
              m.configFingerprint !== fingerprint ||
              m.sourceState !== "active"
            )
              continue;
            const candidate = { ...m, pointId: point.id, score: point.score } as Candidate;
            if (!all.has(point.id) || all.get(point.id)!.score < point.score)
              all.set(point.id, candidate);
          }
        }
        // Bound expansion, including stale builds occupying the first Top-K pages.
        if (!more) break;
      }
      const candidates = [...all.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, maxCandidates);
      const allowed = new Set(await options.authorizeCandidates(input.scope, candidates, signal));
      signal.throwIfAborted();
      const approved = candidates.filter((c) => allowed.has(c.pointId));
      const items: EvidenceItem[] = [],
        seen = new Set<string>();
      let used = 0;
      for (let offset = 0; offset < approved.length; offset += limit) {
        const group = approved.slice(offset, offset + limit);
        const points = await options.client.retrieve(options.index.collectionName, {
          ids: group.map((c) => c.pointId),
          with_vector: false,
          with_payload: true,
        });
        signal.throwIfAborted();
        const byId = new Map(points.map((point) => [point.id, point]));
        for (const candidate of group) {
          const point = byId.get(candidate.pointId),
            m = metadataOf(point?.payload);
          if (!m || !fields.every((key) => m[key] === candidate[key])) continue;
          const item = readPointEvidence(point?.payload);
          if (
            !item ||
            item.source.sourceId !== candidate.documentId ||
            item.source.snapshotId !== candidate.snapshotId ||
            seen.has(item.evidenceId)
          )
            continue;
          const cost =
            (options.index.countTokens ?? conservativeTokenCount)(JSON.stringify(item)) + 8;
          if (!Number.isSafeInteger(cost) || cost < 8) throw new Error("INVALID_TOKEN_COUNT");
          if (used + cost > input.contextTokenBudget) continue;
          used += cost;
          seen.add(item.evidenceId);
          items.push(item);
        }
      }
      if (!(await options.verifyEvidence(input.scope, items, signal)))
        throw new Error("ACCESS_REVOKED");
      signal.throwIfAborted();
      return { items, freshness: "current" };
    },
  };
}
