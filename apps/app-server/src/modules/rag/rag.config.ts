import { createHash } from "node:crypto";
import { OpenAIEmbeddings } from "@langchain/openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { configurationFingerprint, type IndexOptions } from "@zhishu/rag";
import type { AppConfig } from "../../config.js";

export function ragConfiguration(config: AppConfig) {
  const compatibleChat =
    config.AI_API_FORMAT !== "anthropic" && !config.AI_BASE_URL?.includes("/anthropic");
  const baseURL = config.AI_EMBEDDING_BASE_URL ?? (compatibleChat ? config.AI_BASE_URL : undefined);
  const apiKey =
    config.AI_EMBEDDING_API_KEY ?? (compatibleChat || baseURL ? config.AI_API_KEY : undefined);
  const reason = !config.AI_EMBEDDING_MODEL
    ? "请配置 AI_EMBEDDING_MODEL"
    : !apiKey || (!baseURL && !compatibleChat)
      ? "请配置独立的 AI_EMBEDDING_API_KEY 和 AI_EMBEDDING_BASE_URL；Token Plan 写作接口不提供向量化"
      : !config.QDRANT_URL
        ? "请配置 QDRANT_URL 并执行 pnpm ai:setup 初始化向量集合"
        : null;
  const index: IndexOptions = {
    collectionName: config.QDRANT_COLLECTION,
    embeddingFingerprint: configurationId([
      config.AI_EMBEDDING_MODEL,
      baseURL ?? "https://api.openai.com/v1",
    ]),
    dimensions: config.AI_EMBEDDING_DIMENSIONS,
    metric: "cosine",
    normalizerVersion: "rag-v2",
    chunkerVersion: "native-v1",
    targetTokens: 1500,
    maxTokens: 2400,
    overlapTokens: 180,
  };
  return { reason, index, fingerprint: configurationFingerprint(index), baseURL, apiKey };
}
function configurationId(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createRagClients(config: AppConfig) {
  const settings = ragConfiguration(config);
  if (settings.reason) return null;
  return {
    ...settings,
    client: new QdrantClient({
      url: config.QDRANT_URL!,
      apiKey: config.QDRANT_API_KEY,
      timeout: 15000,
      checkCompatibility: false,
    }),
    embeddings: new OpenAIEmbeddings({
      model: config.AI_EMBEDDING_MODEL!,
      apiKey: settings.apiKey!,
      configuration: { baseURL: settings.baseURL },
      dimensions: settings.index.dimensions,
      batchSize: config.AI_EMBEDDING_BATCH_SIZE,
      encodingFormat: "float",
      stripNewLines: false,
      maxRetries: 0,
      timeout: config.AI_TIMEOUT_MS,
    }),
  };
}
