import { config } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// pnpm runs the database commands from the server package root.
config({ path: resolve("apps/app-server/.env") });
export default defineConfig({
  // Schema files import each other with `.js` specifiers (required by the NodeNext
  // server build), which drizzle-kit 0.30 cannot resolve from TypeScript sources.
  // Generate therefore reads the compiled schema entrypoint, which only references
  // current table files; a wildcard glob would also load stale outputs of deleted
  // sources (e.g. the retired projects table) and emit phantom migrations.
  schema: "./dist/database/schema/index.js",
  out: "./database/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
