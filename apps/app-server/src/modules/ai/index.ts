import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AppConfig } from "../../config.js";
import type { CollaborationOwner } from "../collaboration/owner.js";
import { AiDocumentAccess } from "../documents/index.js";
import { AiRepository } from "./ai.repository.js";
import { AiService } from "./ai.service.js";
import { aiRoutes } from "./ai.routes.js";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { WritingService } from "../writing-chat/writing.service.js";
import { writingRoutes } from "../writing-chat/writing.routes.js";
import { WritingImages } from "../writing-chat/writing.image.js";
import { AssetObjectStorage } from "../assets/asset-storage.js";

export async function aiModule(
  app: FastifyInstance,
  config: AppConfig,
  owner: CollaborationOwner,
  exportMode = false,
  injectedModel?: BaseChatModel,
  writingAdapter?: LlmAdapter,
) {
  const saver = PostgresSaver.fromConnString(config.DATABASE_URL, { schema: "ai_checkpoint" });
  const leases = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.AI_MAX_CONCURRENT + 1,
    connectionTimeoutMillis: 5000,
  });
  const model = exportMode
    ? null
    : (injectedModel ??
      (config.AI_MODEL && config.AI_API_KEY
        ? (config.AI_API_FORMAT ??
            (config.AI_BASE_URL &&
            new URL(config.AI_BASE_URL).pathname.replace(/\/+$/, "").endsWith("/anthropic")
              ? "anthropic"
              : "openai")) === "anthropic"
          ? new ChatAnthropic({
              model: config.AI_MODEL,
              apiKey: config.AI_API_KEY,
              clientOptions: { baseURL: config.AI_BASE_URL, timeout: config.AI_TIMEOUT_MS },
              thinking: config.AI_THINKING ? { type: config.AI_THINKING } : undefined,
              outputConfig: config.AI_REASONING_EFFORT
                ? { effort: config.AI_REASONING_EFFORT }
                : undefined,
              maxTokens: 4096,
              maxRetries: 0,
            })
          : new ChatOpenAI({
              model: config.AI_MODEL,
              apiKey: config.AI_API_KEY,
              configuration: config.AI_BASE_URL ? { baseURL: config.AI_BASE_URL } : undefined,
              maxTokens: 4096,
              maxRetries: 0,
              timeout: config.AI_TIMEOUT_MS,
            })
        : null));
  const writingPool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.AI_MAX_CONCURRENT * 4 + 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  writingPool.on("error", () => app.log.error("Writing storage connection failed"));
  const documentAccess = new AiDocumentAccess(app.db, owner);
  const imageStorage =
    !exportMode &&
    config.ASSET_STORAGE_ENDPOINT &&
    config.ASSET_STORAGE_ACCESS_KEY_ID &&
    config.ASSET_STORAGE_SECRET_ACCESS_KEY
      ? new AssetObjectStorage(config)
      : null;
  const writing = new WritingService(
    writingPool,
    documentAccess,
    config,
    writingAdapter,
    new WritingImages(writingPool, config, imageStorage),
  );
  const service = new AiService(
    new AiRepository(app.db),
    documentAccess,
    owner,
    model,
    saver,
    leases,
    config,
    writing,
  );
  let timer: ReturnType<typeof setInterval> | undefined, maintenance: Promise<void> | undefined;
  if (!exportMode) {
    app.addHook("onReady", async () => {
      if (model) await saver.getTuple({ configurable: { thread_id: "__readiness__" } });
      await service.maintain();
      await writing.repository.recoverOrphans();
      timer = setInterval(() => {
        if (!maintenance) {
          maintenance = service
            .maintain()
            .catch(() => {
              app.log.error("AI task maintenance failed");
            })
            .finally(() => {
              maintenance = undefined;
            });
        }
      }, 3600000);
      timer.unref();
    });
    app.addHook("preClose", async () => {
      if (timer) clearInterval(timer);
      await service.close();
      await writing.close();
      if (maintenance) await maintenance;
    });
  }
  app.addHook("onClose", async () => {
    await leases.end();
    await saver.end();
    await writingPool.end();
    imageStorage?.close();
  });
  await app.register((scope) => aiRoutes(scope, service), { prefix: "/ai" });
  await app.register((scope) => writingRoutes(scope, writing), { prefix: "/writing" });
}
