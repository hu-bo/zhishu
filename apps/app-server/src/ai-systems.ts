import { Pool } from "pg";
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { FastifyInstance } from "fastify";
import type { LlmAdapter } from "@zhishu/ai-writing/kernel";
import type { AppConfig } from "./config.js";
import type { CollaborationOwner } from "./modules/collaboration/owner.js";
import { AssetObjectStorage } from "./modules/assets/asset-storage.js";
import { AiDocumentAccess } from "./modules/documents/index.js";
import { createRagClients } from "./modules/rag/rag.config.js";
import { RagRepository } from "./modules/rag/rag.repository.js";
import { RagService } from "./modules/rag/rag.service.js";
import { createAiInfra, type AiInfra } from "./modules/ai/index.js";
import { createQaService, type QaService } from "./modules/qa/index.js";
import {
  createWritingService,
  WritingImages,
  type WritingService,
} from "./modules/writing/index.js";
import {
  createQaSiteService,
  detachDocumentFromSites,
  type QaSiteService,
} from "./modules/qa-sites/index.js";
import type { DocumentPublicLinkage } from "./shared/public-linkage.js";
import { DomainError } from "./shared/domain-error.js";

export interface AiSystems {
  infra: AiInfra;
  rag: RagService | null;
  qa: QaService;
  writing: WritingService;
  sites: QaSiteService;
  publicLinkage: DocumentPublicLinkage;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Root assembly for every AI-backed capability: shared product store, rag worker,
 * the two business flows and public sites. Model credentials and the writing pool are
 * created here and nowhere else.
 */
export function assembleAiSystems(
  app: FastifyInstance,
  config: AppConfig,
  options: {
    exportMode?: boolean;
    collaborationOwner: CollaborationOwner;
    aiModel?: BaseChatModel;
    writingAdapter?: LlmAdapter;
    /** Test seam: scripted retrieval for the smoke runner; production never sets this. */
    ragStub?: RagService | null;
  },
): AiSystems {
  const exportMode = !!options.exportMode;
  const log = (event: string, meta: Record<string, unknown>) => app.log.error({ event, ...meta });
  const infra = createAiInfra(app.db, log);
  const model = exportMode
    ? null
    : (options.aiModel ??
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
  // Native writing sessions own dedicated writer connections; keep the shared pool free.
  const writingPool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.AI_MAX_CONCURRENT * 4 + 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  writingPool.on("error", (err) => app.log.error({ err }, "Writing storage connection failed"));
  const documentAccess = new AiDocumentAccess(app.db, options.collaborationOwner);
  const ragClients = exportMode ? null : createRagClients(config);
  const rag =
    options.ragStub ??
    (ragClients
      ? new RagService(
          new RagRepository(app.dbPool),
          documentAccess,
          app.db,
          ragClients,
          config,
          (code) => app.log.error({ code }, "Document vector indexing failed"),
        )
      : null);
  const imageStorage =
    !exportMode &&
    config.ASSET_STORAGE_ENDPOINT &&
    config.ASSET_STORAGE_ACCESS_KEY_ID &&
    config.ASSET_STORAGE_SECRET_ACCESS_KEY
      ? new AssetObjectStorage(config)
      : null;
  const writing = createWritingService({
    store: infra.service,
    bus: infra.bus,
    db: app.db,
    pool: writingPool,
    rag,
    owner: options.collaborationOwner,
    images: new WritingImages(writingPool, config, imageStorage),
    config,
    log,
  });
  if (options.writingAdapter) writing.adapter = options.writingAdapter;
  const qa = createQaService({
    store: infra.service,
    bus: infra.bus,
    db: app.db,
    rag,
    model,
    config,
    log,
  });
  qa.handoffPort = writing.handoffPort;
  const sites = createQaSiteService({ db: app.db, store: infra.service, config, log });
  qa.siteQuota = async (tenantId, siteId) => sites.messagesPerHourFor(tenantId, siteId);
  // qa-sites resolves live public audiences; the qa module never imports it directly.
  const liveSiteState = async (conversation: { tenantId: string; siteId: string | null }) => {
    if (!conversation.siteId) throw new DomainError("NOT_FOUND", "站点会话缺少站点");
    const site = await sites.findSiteById(conversation.siteId);
    if (!site || site.tenantId !== conversation.tenantId)
      throw new DomainError("AI_ACCESS_REVOKED", "站点不可用");
    if (site.status !== "active") throw new DomainError("AI_ACCESS_REVOKED", "站点当前不可访问");
    return { site, approved: await sites.approvedDocuments(site) };
  };
  qa.siteApproved = async (conversation) => (await liveSiteState(conversation)).approved;
  qa.siteStreamState = async (conversation) => {
    const { site, approved } = await liveSiteState(conversation);
    return { accessRevision: site.accessRevision, approved };
  };
  const publicLinkage: DocumentPublicLinkage = {
    detachDocuments: async (tx, tenantId, documentIds) => {
      for (const documentId of documentIds) await detachDocumentFromSites(tx, tenantId, documentId);
    },
  };
  return {
    infra,
    rag,
    qa,
    writing,
    sites,
    publicLinkage,
    async start() {
      if (exportMode) return;
      infra.start();
      rag?.start();
      qa.start();
      writing.start();
    },
    async stop() {
      await qa.stop();
      await writing.stop();
      await rag?.close();
      await infra.stop();
      await writingPool.end();
      imageStorage?.close();
    },
  };
}
