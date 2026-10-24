import type { FastifyInstance } from "fastify";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  CALLOUT_DOCUMENT_SCHEMA_VERSION,
  LEGACY_DOCUMENT_SCHEMA_VERSION,
  SUPPORTED_DOCUMENT_SCHEMA_VERSIONS,
  TABLE_DOCUMENT_SCHEMA_VERSION,
  TASK_LIST_DOCUMENT_SCHEMA_VERSION,
  TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION,
  createContentMigrationExecutor,
  validateDocumentContent,
  validateDocumentContentForSchemaVersion,
} from "@zhishu/document-contracts";
import type { ContentMigration, ContentValidationResult } from "@zhishu/document-contracts";
import type { AppConfig } from "../../config.js";
import { CatalogRepository } from "./catalog.repository.js";
import { catalogRoutes } from "./catalog.routes.js";
import { CatalogService } from "./catalog.service.js";
import { DocumentRepository } from "./document.repository.js";
import { documentRoutes } from "./document.routes.js";
import { DocumentService } from "./document.service.js";
import type { CollaborationSessionRevoker } from "./document.service.js";
import { KnowledgeRepository } from "./knowledge.repository.js";
import { KnowledgeService } from "./knowledge.service.js";
import { knowledgeRoutes } from "./knowledge.routes.js";
import { AssetObjectStorage } from "../assets/asset-storage.js";
import { publicShareRoutes } from "./public-share.routes.js";
import { ShareRepository } from "./share.repository.js";
import { ShareService } from "./share.service.js";
import { shareRoutes } from "./share.routes.js";

export const currentSchemaVersion = CURRENT_DOCUMENT_SCHEMA_VERSION;
export { AiDocumentAccess } from "./ai-document-access.js";
const contentMigrations: readonly ContentMigration[] = [
  {
    id: "document-schema-v1-to-v2-task-list",
    summary: "Preserve existing content while enabling recursive task lists.",
    fromSchemaVersion: LEGACY_DOCUMENT_SCHEMA_VERSION,
    toSchemaVersion: TASK_LIST_DOCUMENT_SCHEMA_VERSION,
    migrate: (content) => content,
  },
  {
    id: "document-schema-v2-to-v3-tables",
    summary: "Preserve existing content while enabling rectangular tables.",
    fromSchemaVersion: TASK_LIST_DOCUMENT_SCHEMA_VERSION,
    toSchemaVersion: TABLE_DOCUMENT_SCHEMA_VERSION,
    migrate: (content) => content,
  },
  {
    id: "document-schema-v3-to-v4-text-formatting",
    summary: "Preserve existing content while enabling underline, highlight, and text alignment.",
    fromSchemaVersion: TABLE_DOCUMENT_SCHEMA_VERSION,
    toSchemaVersion: TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION,
    migrate: (content) => content,
  },
  {
    id: "document-schema-v4-to-v5-callouts",
    summary:
      "Preserve existing content while enabling callouts, inline status tags, and labeled dividers.",
    fromSchemaVersion: TEXT_FORMATS_DOCUMENT_SCHEMA_VERSION,
    toSchemaVersion: CALLOUT_DOCUMENT_SCHEMA_VERSION,
    migrate: (content) => content,
  },
];
const executeContentMigration = createContentMigrationExecutor(contentMigrations, {
  schemaVersion: currentSchemaVersion,
  validate: validateDocumentContent,
});

function validateMigrationSource(content: unknown, schemaVersion: number): ContentValidationResult {
  return validateDocumentContentForSchemaVersion(content, schemaVersion);
}

export function createDocumentService(
  repository: DocumentRepository,
  config: AppConfig,
  sessionRevoker: CollaborationSessionRevoker,
): DocumentService {
  return new DocumentService(
    repository,
    {
      tokenSecret: config.COLLABORATION_TOKEN_SECRET,
      sessionTtlSeconds: config.COLLABORATION_SESSION_TTL_SECONDS,
      providerUrl: config.COLLABORATION_PUBLIC_URL,
    },
    sessionRevoker,
    {
      targetSchemaVersion: currentSchemaVersion,
      supportedSchemaVersions: SUPPORTED_DOCUMENT_SCHEMA_VERSIONS,
      execute: executeContentMigration,
      validateSource: validateMigrationSource,
    },
    config.TENANT_MAX_DOCUMENTS,
  );
}

export async function documentsModule(
  app: FastifyInstance,
  config: AppConfig,
  sessionRevoker: CollaborationSessionRevoker,
  exportMode = false,
): Promise<void> {
  const repository = new DocumentRepository(app.db);
  const service = createDocumentService(repository, config, sessionRevoker);
  await app.register(async (scope) => documentRoutes(scope, service), { prefix: "/documents" });
  const knowledge = new KnowledgeService(
    new KnowledgeRepository(app.db),
    config.TENANT_MAX_DOCUMENTS,
  );
  await app.register(async (scope) => knowledgeRoutes(scope, knowledge), { prefix: "/knowledge" });
  const catalogs = new CatalogService(new CatalogRepository(app.db));
  await app.register(async (scope) => catalogRoutes(scope, catalogs), { prefix: "/knowledge" });
  // Anonymous share readers need presigned asset URLs; mirror the assetsModule storage gate.
  const shareStorage =
    config.ASSET_STORAGE_ENDPOINT &&
    config.ASSET_STORAGE_ACCESS_KEY_ID &&
    config.ASSET_STORAGE_SECRET_ACCESS_KEY &&
    !exportMode
      ? new AssetObjectStorage(config)
      : null;
  if (shareStorage) app.addHook("onClose", async () => shareStorage.close());
  const shares = new ShareService(new ShareRepository(app.db, repository), catalogs, shareStorage, {
    accessUrlTtlSeconds: config.ASSET_ACCESS_URL_TTL_SECONDS,
  });
  await app.register(async (scope) => shareRoutes(scope, shares), { prefix: "/documents" });
  await app.register(async (scope) => publicShareRoutes(scope, shares));
}
