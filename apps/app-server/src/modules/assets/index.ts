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
    config.ASSET_STORAGE_ENDPOINT &&
    config.ASSET_STORAGE_ACCESS_KEY_ID &&
    config.ASSET_STORAGE_SECRET_ACCESS_KEY &&
    !exportMode
      ? new AssetObjectStorage(config)
      : null;
  if (storage) {
    app.addHook("onClose", async () => storage.close());
    if (config.ASSET_STORAGE_CHECK_ON_STARTUP) await storage.initialize();
  }
  const service = new AssetService(new AssetRepository(app.db), storage, {
    maxBytes: config.ASSET_UPLOAD_MAX_BYTES,
    maxTenantBytes: config.TENANT_MAX_ASSET_BYTES,
    uploadTtlSeconds: config.ASSET_UPLOAD_SESSION_TTL_SECONDS,
    accessUrlTtlSeconds: config.ASSET_ACCESS_URL_TTL_SECONDS,
    orphanRetentionSeconds: config.ASSET_ORPHAN_RETENTION_SECONDS,
  });
  await app.register(async (scope) => assetRoutes(scope, service, config));
}
