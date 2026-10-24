import "../environment.js";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createPool } from "../../database/index.js";
const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
const saver = new PostgresSaver(pool, undefined, { schema: "ai_checkpoint" });
try {
  await pool.query("create schema if not exists ai_checkpoint");
  await saver.setup();
  console.log("AI checkpoint schema initialized with the pinned official PostgresSaver.");
} finally {
  await saver.end();
}
