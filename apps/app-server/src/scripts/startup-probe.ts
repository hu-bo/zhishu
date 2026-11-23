import "../environment.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

// Pre-deploy wiring probe. It assembles the full app graph — including the
// trusted identity provider required by AUTH_MODE=external — without opening
// listeners or writing to the database, so wiring failures stop the pipeline
// while the previous service is still running.
const config = loadConfig();
const app = await buildApp(config, { exportMode: true });
await app.close();
console.log(`Startup wiring probe passed (AUTH_MODE=${config.AUTH_MODE}).`);
