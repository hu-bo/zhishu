import type { FastifyInstance } from "fastify";
import type { Database } from "../../../database/index.js";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { CatalogService } from "./catalog.service.js";
import { catalogRoutes } from "./catalog.routes.js";
export { ensureRootCatalog, rootCatalogId } from "./root-catalog.js";
export { catalogPathSql, workspaceNameSql } from "./navigation.js";
export { previewTransfer } from "./transfer-policy.js";
export type { TransferRequest } from "./transfer-policy.js";
export { documentLocateSchema } from "./catalog.schema.js";
export type { CatalogService } from "./catalog.service.js";
export function createCatalogService(db: Database, revoker: CollaborationSessionRevoker) {
  return new CatalogService(db, revoker);
}
export async function catalogsModule(app: FastifyInstance, revoker: CollaborationSessionRevoker) {
  const service = createCatalogService(app.db, revoker);
  await app.register((scope) => catalogRoutes(scope, service), { prefix: "/knowledge" });
}
