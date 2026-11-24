import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { LlmAdapter } from "@zhishu/dsh-agent/kernel";
import type { AppConfig } from "./config.js";
import type { CollaborationOwner } from "./modules/collaboration/owner.js";
import type { CollaborationSessionRevoker } from "./modules/collaboration/session-revoker.js";
import { AssetObjectStorage } from "./modules/assets/asset-storage.js";
import { AiDocumentAccess, createDocumentService } from "./modules/documents/index.js";
import { createRagClients } from "./modules/rag/rag.config.js";
import { RagRepository } from "./modules/rag/rag.repository.js";
import { RagService } from "./modules/rag/rag.service.js";
import { createAiInfra, AiImages, AssistantService, type AiInfra } from "./modules/ai/index.js";
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
  assistant: AssistantService;
  sites: QaSiteService;
  publicLinkage: DocumentPublicLinkage;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Root assembly for every AI-backed capability: one shared product store, one rag worker,
 * one unified assistant (a single DSH execution with composable plugins) and public sites.
 * Model credentials and the native session pool are created here and nowhere else.
 */
export function assembleAiSystems(
  app: FastifyInstance,
  config: AppConfig,
  options: {
    exportMode?: boolean;
    collaborationOwner: CollaborationOwner;
    sessionRevoker: CollaborationSessionRevoker;
    assistantAdapter?: LlmAdapter;
    /** Test seam: scripted retrieval for the smoke runner; production never sets this. */
    ragStub?: RagService | null;
  },
): AiSystems {
  const exportMode = !!options.exportMode;
  const log = (event: string, meta: Record<string, unknown>) => app.log.error({ event, ...meta });
  const infra = createAiInfra(app.db, log);
  // Native assistant sessions own dedicated writer connections; keep the shared pool free.
  const assistantPool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.AI_MAX_CONCURRENT * 4 + 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  assistantPool.on("error", (err) => app.log.error({ err }, "Assistant storage connection failed"));
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
  const publicLinkage: DocumentPublicLinkage = {
    detachDocuments: async (tx, tenantId, documentIds) => {
      for (const documentId of documentIds) await detachDocumentFromSites(tx, tenantId, documentId);
    },
  };
  // The draft binding port is the documents module's own transaction-scoped creation; the
  // assistant never inserts document rows itself and documents never imports the assistant.
  const documents = createDocumentService(app.db, config, options.sessionRevoker, publicLinkage);
  const assistant = new AssistantService({
    store: infra.service,
    bus: infra.bus,
    db: app.db,
    pool: assistantPool,
    rag,
    owner: options.collaborationOwner,
    images: new AiImages(assistantPool, config, imageStorage),
    drafts: documents,
    config,
    log,
  });
  if (options.assistantAdapter) assistant.adapter = options.assistantAdapter;
  const sites = createQaSiteService({ db: app.db, store: infra.service, config, log });
  assistant.siteQuota = async (tenantId, siteId) => sites.messagesPerHourFor(tenantId, siteId);
  // qa-sites resolves live public audiences; the assistant never imports it directly.
  const liveSiteState = async (conversation: { tenantId: string; siteId: string | null }) => {
    if (!conversation.siteId) throw new DomainError("NOT_FOUND", "站点会话缺少站点");
    const site = await sites.findSiteById(conversation.siteId);
    if (!site || site.tenantId !== conversation.tenantId)
      throw new DomainError("AI_ACCESS_REVOKED", "站点不可用");
    if (site.status !== "active") throw new DomainError("AI_ACCESS_REVOKED", "站点当前不可访问");
    return { site, approved: await sites.approvedDocuments(site) };
  };
  assistant.siteApproved = async (conversation) => (await liveSiteState(conversation)).approved;
  assistant.siteStreamState = async (conversation) => {
    const { site, approved } = await liveSiteState(conversation);
    return { accessRevision: site.accessRevision, approved };
  };
  return {
    infra,
    rag,
    assistant,
    sites,
    publicLinkage,
    async start() {
      if (exportMode) return;
      infra.start();
      rag?.start();
      assistant.start();
    },
    async stop() {
      await assistant.stop();
      await rag?.close();
      await infra.stop();
      await assistantPool.end();
    },
  };
}
