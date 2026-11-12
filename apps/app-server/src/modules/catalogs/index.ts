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
export function createCatalogService(
  db: Database,
  revoker: CollaborationSessionRevoker,
  publicLinkage?: import("../../shared/public-linkage.js").DocumentPublicLinkage,
) {
  return new CatalogService(db, revoker, publicLinkage);
}
export async function catalogsModule(
  app: FastifyInstance,
  revoker: CollaborationSessionRevoker,
  publicLinkage?: import("../../shared/public-linkage.js").DocumentPublicLinkage,
) {
  const service = createCatalogService(app.db, revoker, publicLinkage);
  await app.register((scope) => catalogRoutes(scope, service), { prefix: "/knowledge" });
}
