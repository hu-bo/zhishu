import { defineConfig } from "drizzle-kit";

// Verification-only config: pinned to the disposable migration-check database.
// Never points at the business database from .env.
export default defineConfig({
  schema: "./database/schema/*.table.ts",
  out: "./database/migrations",
  dialect: "postgresql",
  dbCredentials: { url: "postgresql://postgres@127.0.0.1:5432/zhishu_mg_check" },
});
