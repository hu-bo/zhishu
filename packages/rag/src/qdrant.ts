import type { QdrantClient } from "@qdrant/js-client-rest";
import type { Embeddings } from "@langchain/core/embeddings";
import type { DocumentSnapshot } from "@zhishu/document-contracts";
import { validateEvidenceBundle, type EvidenceItem } from "@zhishu/ai-contracts";
import { configurationFingerprint, digest, prepareDocument, type IndexOptions } from "./chunks.js";
import type { RagDocumentSource, DocumentParseOptions, UploadedImage } from "./inputs.js";

export function deterministicPointId(
  tenantId: string,
  documentId: string,
  indexVersion: string,
  ordinal: number,
): string {
  const hash = digest([tenantId, documentId, indexVersion, ordinal]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function validateVectors(vectors: number[][], count: number, dimensions: number): void {
  if (
    vectors.length !== count ||
    vectors.some(
      (vector) => vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error("INVALID_EMBEDDING");
}
export async function initializeCollection(
  client: QdrantClient,
  options: IndexOptions,
): Promise<void> {
  configurationFingerprint(options);
  if (!(await client.collectionExists(options.collectionName)).exists)
    await client.createCollection(options.collectionName, {
      vectors: { size: options.dimensions, distance: "Cosine" },
    });
  const collection = await client.getCollection(options.collectionName),
    vectors = collection.config.params.vectors;
  if (
    !vectors ||
    !("size" in vectors) ||
    vectors.size !== options.dimensions ||
    vectors.distance !== "Cosine"
  )
    throw new Error("INCOMPATIBLE_COLLECTION");
  for (const key of [
    "tenantId",
    "workspaceId",
    "documentId",
    "indexVersion",
    "readAclKeys",
    "configFingerprint",
    "sourceState",
    "aclRevision",
    "generationId",
    "durableSeq",
    "metadataRevision",
  ])
    await client.createPayloadIndex(options.collectionName, {
      field_name: `metadata.${key}`,
      field_schema: "keyword",
      wait: true,
    });
  // Revisions are decimal strings to preserve the full database range. Conditional updates use an
  // exact previous revision, rather than Qdrant's floating point numeric range representation.
}
export async function writeDocumentIndex(
  input: {
    client: QdrantClient;
    embeddings: Embeddings;
    options: IndexOptions;
    parsing?: DocumentParseOptions;
    tenantId: string;
    workspaceId: string;
    indexVersion: string;
    metadataRevision: string;
    aclRevision: string;
    readAclKeys: readonly string[];
    signal: AbortSignal;
    batchSize?: number;
  } & (
    | { snapshot: DocumentSnapshot; source?: never; version?: never }
    | {
        source: RagDocumentSource;
        snapshot?: never;
        version: { generationId: string; durableSeq: string };
      }
  ),
): Promise<{
  chunkCount: number;
  contentDigest: string;
  snapshotId: string;
  images: UploadedImage[];
}> {
  const { client, options, signal } = input;
  if (
    !input.tenantId ||
    !input.workspaceId ||
    !input.indexVersion ||
    !validAclKeys(input.readAclKeys)
  )
    throw new Error("INVALID_INDEX_CONTEXT");
  decimal(input.aclRevision);
  decimal(input.metadataRevision);
  const source = input.snapshot ?? input.source;
  const documentId = "format" in source ? source.sourceId : source.documentId;
  const version = input.version ?? {
    generationId: "generationId" in source ? source.generationId : "",
    durableSeq: "durableSeq" in source ? String(source.durableSeq) : "0",
  };
  if (input.source && (!version.generationId || version.generationId.length > 160))
    throw new Error("INVALID_INDEX_CONTEXT");
  decimal(version.durableSeq);
  const prepared = await prepareDocument(source, options, { ...input.parsing, signal });
  const items = prepared.chunks,
    fingerprint = configurationFingerprint(options);
  const batchSize = input.batchSize ?? 32;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 128)
    throw new Error("INVALID_BATCH_SIZE");
  for (let offset = 0; offset < items.length; offset += batchSize) {
    signal.throwIfAborted();
    const batch = items.slice(offset, offset + batchSize),
      texts = batch.map(embeddingText);
    const vectors = await input.embeddings.embedDocuments(texts);
    signal.throwIfAborted();
    validateVectors(vectors, batch.length, options.dimensions);
    await client.upsert(options.collectionName, {
      wait: true,
      update_mode: "insert_only",
      points: batch.map((item, index) => ({
        id: deterministicPointId(input.tenantId, documentId, input.indexVersion, offset + index),
        vector: vectors[index]!,
        payload: {
          content: item.text,
          metadata: {
            ...item.source,
            evidenceId: item.evidenceId,
            title: item.title,
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            documentId,
            indexVersion: input.indexVersion,
            chunkOrdinal: offset + index,
            generationId: version.generationId,
            durableSeq: version.durableSeq,
            metadataRevision: input.metadataRevision,
            aclRevision: input.aclRevision,
            configFingerprint: fingerprint,
            sourceState: "active",
            readAclKeys: [...input.readAclKeys],
            textDigest: digest(item.text),
            embeddingDigest: digest(texts[index]),
          },
        },
      })),
    });
  }
  // Insert-only retries may find an existing point. Verify the immutable source/input identity
  // before a caller can publish this build; a successful write acknowledgement alone is insufficient.
  for (let offset = 0; offset < items.length; offset += batchSize) {
    signal.throwIfAborted();
    const batch = items.slice(offset, offset + batchSize);
    const ids = batch.map((_item, index) =>
      deterministicPointId(input.tenantId, documentId, input.indexVersion, offset + index),
    );
    const points = await client.retrieve(options.collectionName, {
      ids,
      with_payload: true,
      with_vector: false,
    });
    const byId = new Map(points.map((point) => [point.id, point]));
    for (const [index, item] of batch.entries()) {
      const point = byId.get(ids[index]!),
        m = point?.payload?.metadata as Record<string, unknown> | undefined;
      if (
        !m ||
        point?.payload?.content !== item.text ||
        m.tenantId !== input.tenantId ||
        m.workspaceId !== input.workspaceId ||
        m.documentId !== documentId ||
        m.indexVersion !== input.indexVersion ||
        m.snapshotId !== item.source.snapshotId ||
        m.configFingerprint !== fingerprint ||
        m.textDigest !== digest(item.text) ||
        m.embeddingDigest !== digest(embeddingText(item)) ||
        m.metadataRevision !== input.metadataRevision
      )
        throw new Error("INDEX_VERIFICATION_FAILED");
    }
  }
  signal.throwIfAborted();
  return {
    chunkCount: items.length,
    contentDigest: digest(items.map((item) => [item.evidenceId, digest(item.text)])),
    snapshotId: prepared.snapshotId,
    images: prepared.images,
  };
}
export const embeddingText = (item: EvidenceItem): string =>
  item.title ? `${item.title}\n${item.text}` : item.text;
export function decimal(value: string): string {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("INVALID_REVISION");
  return value;
}
export function validAclKeys(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => /^(space|user|document):[^\s:]{1,160}$/.test(key));
}
export async function updateIndexPolicy(input: {
  client: QdrantClient;
  options: IndexOptions;
  tenantId: string;
  documentId: string;
  indexVersion: string;
  previousRevision: string;
  aclRevision: string;
  readAclKeys: readonly string[];
  signal: AbortSignal;
}): Promise<void> {
  if (
    !validAclKeys(input.readAclKeys) ||
    !input.tenantId ||
    !input.documentId ||
    !input.indexVersion ||
    BigInt(decimal(input.aclRevision)) <= BigInt(decimal(input.previousRevision))
  )
    throw new Error("INVALID_INDEX_POLICY");
  input.signal.throwIfAborted();
  await input.client.setPayload(input.options.collectionName, {
    wait: true,
    key: "metadata",
    payload: { readAclKeys: [...input.readAclKeys], aclRevision: input.aclRevision },
    filter: {
      must: [
        { key: "metadata.tenantId", match: { value: input.tenantId } },
        { key: "metadata.documentId", match: { value: input.documentId } },
        { key: "metadata.indexVersion", match: { value: input.indexVersion } },
        { key: "metadata.aclRevision", match: { value: input.previousRevision } },
      ],
    },
  });
  input.signal.throwIfAborted();
}
export function readPointEvidence(
  payload: Record<string, unknown> | null | undefined,
): EvidenceItem | undefined {
  const metadata = payload?.metadata;
  if (!metadata || typeof metadata !== "object") return;
  const m = metadata as Record<string, unknown>;
  const item = {
    evidenceId: m.evidenceId,
    source: { sourceId: m.sourceId, snapshotId: m.snapshotId, locator: m.locator },
    title: m.title,
    text: payload?.content,
  };
  const validated = validateEvidenceBundle({ freshness: "current", items: [item] });
  if (!validated.success || digest(validated.data.items[0]!.text) !== m.textDigest) return;
  return validated.data.items[0];
}
