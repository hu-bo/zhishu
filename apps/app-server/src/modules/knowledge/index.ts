import { SessionInvalidator } from "../authorization/permissions.js";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { KnowledgeService } from "./knowledge.service.js";
import { knowledgeRoutes } from "./knowledge.routes.js";
export async function knowledgeModule(
  app: FastifyInstance,
  config: AppConfig,
  revoker: CollaborationSessionRevoker,
) {
  const service = new KnowledgeService(
    app.db,
    config.TENANT_MAX_DOCUMENTS,
    new SessionInvalidator(app.db, revoker),
  );
  await app.register((scope) => knowledgeRoutes(scope, service), { prefix: "/knowledge" });
}
