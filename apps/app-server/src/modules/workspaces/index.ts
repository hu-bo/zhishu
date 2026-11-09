import { SessionInvalidator } from "../authorization/permissions.js";
import type { FastifyInstance } from "fastify";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { WorkspaceService } from "./workspace.service.js";
import { workspaceRoutes } from "./workspace.routes.js";
export async function workspacesModule(app: FastifyInstance, revoker: CollaborationSessionRevoker) {
  const service = new WorkspaceService(app.db, new SessionInvalidator(app.db, revoker));
  await app.register((scope) => workspaceRoutes(scope, service), { prefix: "/knowledge" });
}
