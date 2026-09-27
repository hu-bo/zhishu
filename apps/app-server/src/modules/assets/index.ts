import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { AssetRepository } from "./asset.repository.js";
import { assetRoutes } from "./asset.routes.js";
import { AssetService } from "./asset.service.js";
import { AssetObjectStorage } from "./asset-storage.js";

export async function assetsModule(
  app: FastifyInstance,
  config: AppConfig,
  exportMode = false,
): Promise<void> {
  const storage =
    config.ASSET_STORAGE_ENDPOINT && !exportMode ? new AssetObjectStorage(config) : null;
  if (storage) {
    app.addHook("onClose", async () => storage.close());
    await storage.initialize();
  }
  const service = new AssetService(new AssetRepository(app.db), storage, {
    maxBytes: config.ASSET_UPLOAD_MAX_BYTES,
    uploadTtlSeconds: config.ASSET_UPLOAD_SESSION_TTL_SECONDS,
    accessUrlTtlSeconds: config.ASSET_ACCESS_URL_TTL_SECONDS,
    orphanRetentionSeconds: config.ASSET_ORPHAN_RETENTION_SECONDS,
  });
  await app.register(async (scope) => assetRoutes(scope, service, config));
}
