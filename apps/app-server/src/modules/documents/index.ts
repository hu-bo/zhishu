import type { FastifyInstance } from "fastify";
import {
  createContentMigrationExecutor,
  validateDocumentContent,
} from "@zhishu/document-contracts";
import type { ContentMigration, ContentValidationResult } from "@zhishu/document-contracts";
import type { AppConfig } from "../../config.js";
import { DocumentRepository } from "./document.repository.js";
import { documentRoutes } from "./document.routes.js";
import { DocumentService } from "./document.service.js";
import type { CollaborationSessionRevoker } from "./document.service.js";

export const currentSchemaVersion = 1;
const contentMigrations: readonly ContentMigration[] = [];
const executeContentMigration = createContentMigrationExecutor(contentMigrations, {
  schemaVersion: currentSchemaVersion,
  validate: validateDocumentContent,
});

function validateMigrationSource(content: unknown, schemaVersion: number): ContentValidationResult {
  if (schemaVersion === 1) return validateDocumentContent(content);
  return {
    success: false,
    issues: [
      {
        code: "invalid-content",
        path: "$",
        message: "No source validator is registered for this schema version.",
        recoverable: false,
      },
    ],
  };
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
): Promise<void> {
  const service = createDocumentService(new DocumentRepository(app.db), config, sessionRevoker);
  await app.register(async (scope) => documentRoutes(scope, service), { prefix: "/documents" });
}
