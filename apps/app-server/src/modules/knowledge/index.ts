import { SessionInvalidator } from "../authorization/permissions.js";
import type { FastifyInstance } from "fastify";
import { TENANT_MAX_DOCUMENTS } from "../../config.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { KnowledgeService } from "./knowledge.service.js";
import { knowledgeRoutes } from "./knowledge.routes.js";
export async function knowledgeModule(
  app: FastifyInstance,
  revoker: CollaborationSessionRevoker,
  publicLinkage?: import("../../shared/public-linkage.js").DocumentPublicLinkage,
) {
  const service = new KnowledgeService(
    app.db,
    TENANT_MAX_DOCUMENTS,
    new SessionInvalidator(app.db, revoker),
    publicLinkage,
  );
  await app.register((scope) => knowledgeRoutes(scope, service), { prefix: "/knowledge" });
}
