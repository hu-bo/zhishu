import "../environment.js";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool } from "../../database/index.js";
import { loadConfig } from "../config.js";
import { createRagClients, ragConfiguration } from "../modules/rag/rag.config.js";
import { initializeCollection } from "@zhishu/rag";
const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
const saver = new PostgresSaver(pool, undefined, { schema: "ai_checkpoint" });
try {
  await pool.query("create schema if not exists ai_checkpoint");
  await saver.setup();
  console.log("AI checkpoint schema initialized with the pinned official PostgresSaver.");
  const config = loadConfig();
  const clients = createRagClients(config);
  if (clients) {
    const existed = (await clients.client.collectionExists(clients.index.collectionName)).exists;
    await initializeCollection(clients.client, clients.index);
    if (!existed || process.argv.includes("--rebuild")) {
      await pool.query(
        "update document_indexes set config_fingerprint=null, available_at=now(), last_error_code=null where config_fingerprint=$1",
        [clients.fingerprint],
      );
    }
    console.log(
      `Knowledge vector collection initialized (${clients.index.dimensions} dimensions).`,
    );
  } else if (config.AI_EMBEDDING_MODEL)
    throw new Error(
      ragConfiguration(config).reason ?? "Knowledge indexing configuration is incomplete",
    );
} finally {
  await saver.end();
}
