import { loadConfig } from "../config.js";
import { createRagClients } from "../modules/rag/rag.config.js";
import { initializeCollection } from "@zhishu/rag";

/**
 * One-time vector knowledge setup: create/sync the Qdrant collection for the configured
 * index options and reschedule re-indexing when the collection configuration changed.
 * The legacy LangGraph checkpoint schema was retired with the old runtime; migrations now
 * drop it. This script never touches document content directly.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const clients = createRagClients(config);
  if (!clients) {
    console.error(
      "知识索引未启用：请确认 AI_EMBEDDING_MODEL、AI_EMBEDDING_API_KEY/AI_API_KEY 与 QDRANT_URL 已配置。",
    );
    process.exitCode = 1;
    return;
  }
  const exists = await clients.client.collectionExists(clients.index.collectionName);
  await initializeCollection(clients.client, clients.index);
  if (!exists.exists) {
    console.log(`已创建向量集合 ${clients.index.collectionName}。`);
  } else {
    console.log(`向量集合 ${clients.index.collectionName} 已存在且兼容。`);
  }
  if (process.argv.includes("--rebuild")) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
    try {
      const result = await pool.query(
        `update document_indexes
            set config_fingerprint = null, available_at = now(), last_error_code = null, attempts = 0, updated_at = now()
          where config_fingerprint = $1`,
        [clients.fingerprint],
      );
      console.log(`已标记 ${result.rowCount} 篇文档在配置变化后重新索引。`);
    } finally {
      await pool.end();
    }
  }
  console.log("ai:setup 完成。索引 Worker 会在服务启动后自动处理 document_indexes。");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
