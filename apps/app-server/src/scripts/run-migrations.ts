import "../environment.js";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase, createPool } from "../../database/index.js";
import { serverRoot } from "../paths.js";

// Deploy-time migration runner. It reuses the journal code path behind
// `drizzle-kit migrate` (same defaults: public.drizzle table) so the release
// artifact ships runtime dependencies only, without the drizzle-kit/esbuild
// dev closure. Dev keeps using `pnpm db:migrate`.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must target the project PostgreSQL database");

const pool = createPool({ connectionString: databaseUrl, max: 1 });
try {
  await migrate(createDatabase(pool), {
    migrationsFolder: resolve(serverRoot, "database/migrations"),
  });
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
