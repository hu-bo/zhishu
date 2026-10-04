import { loadConfig } from "../config.js";
import { createDatabase, createPool } from "../../database/index.js";
import { AssetRepository } from "../modules/assets/asset.repository.js";
import { AssetService } from "../modules/assets/asset.service.js";
import { AssetObjectStorage } from "../modules/assets/asset-storage.js";

const config = loadConfig();
if (
  !config.ASSET_STORAGE_ENDPOINT ||
  !config.ASSET_STORAGE_ACCESS_KEY_ID ||
  !config.ASSET_STORAGE_SECRET_ACCESS_KEY
) {
  throw new Error("Asset storage configuration is required to run orphan cleanup");
}

const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
  query_timeout: config.DATABASE_QUERY_TIMEOUT_MS,
});
const storage = new AssetObjectStorage(config);

try {
  await storage.initialize();
  const service = new AssetService(new AssetRepository(createDatabase(pool)), storage, {
    maxBytes: config.ASSET_UPLOAD_MAX_BYTES,
    maxTenantBytes: config.TENANT_MAX_ASSET_BYTES,
    uploadTtlSeconds: config.ASSET_UPLOAD_SESSION_TTL_SECONDS,
    accessUrlTtlSeconds: config.ASSET_ACCESS_URL_TTL_SECONDS,
    orphanRetentionSeconds: config.ASSET_ORPHAN_RETENTION_SECONDS,
  });
  const result = await service.cleanOrphans();
  process.stdout.write(`Removed ${result.deleted} orphaned asset object(s).\n`);
} finally {
  storage.close();
  await pool.end();
}
