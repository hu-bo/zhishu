import "./environment.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => {
      app.log.error("Shutdown deadline exceeded");
      process.exit(1);
    }, 10_000);
    deadline.unref();
    try {
      await app.close();
    } catch {
      app.log.error("Server shutdown failed");
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch {
    app.log.error("Server startup failed");
    await shutdown();
    process.exitCode = 1;
  }
}
main().catch(() => {
  console.error("Server startup failed; check configuration and database availability.");
  process.exitCode = 1;
});
