import "./environment.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createCollaborationServer } from "./modules/collaboration/hocuspocus.server.js";
import { OperationsMetrics } from "./modules/health/operations-metrics.js";
import type { PrincipalAuthenticator } from "./modules/identity/identity.types.js";

export async function startServer(
  options: {
    config?: AppConfig;
    identityAuthenticator?: PrincipalAuthenticator;
  } = {},
): Promise<void> {
  const config = options.config ?? loadConfig();
  const operationsMetrics = new OperationsMetrics();
  const collaborationRef: { current?: ReturnType<typeof createCollaborationServer> } = {};
  const app = await buildApp(config, {
    operationsMetrics,
    ...(options.identityAuthenticator
      ? { identityAuthenticator: options.identityAuthenticator }
      : {}),
    sessionRevoker: {
      revokeDocumentSessions(documentId, generationId, identityId) {
        collaborationRef.current?.revokeDocumentSessions(documentId, generationId, identityId);
      },
    },
    collaborationOwner: {
      snapshot(principal, id) {
        if (!collaborationRef.current) throw new Error("COLLABORATION_NOT_READY");
        return collaborationRef.current.owner.snapshot(principal, id);
      },
      apply(input) {
        if (!collaborationRef.current) throw new Error("COLLABORATION_NOT_READY");
        return collaborationRef.current.owner.apply(input);
      },
    },
  });
  const collaboration = createCollaborationServer(
    config,
    app.db,
    app.dbPool,
    () => {
      app.log.fatal("Collaboration owner lock was lost; stopping this server instance.");
      process.kill(process.pid, "SIGTERM");
    },
    operationsMetrics,
  );
  collaborationRef.current = collaboration;
  let collaborationStarted = false;
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
      if (collaborationStarted) await collaboration?.close();
      await app.close();
    } catch (err) {
      app.log.error({ err }, "Server shutdown failed");
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  let phase = "collaboration-listen";
  try {
    await collaboration.listen();
    collaborationStarted = true;
    phase = "http-listen";
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    app.log.error(
      {
        err,
        phase,
        host: config.HOST,
        port: config.PORT,
        collaborationHost: config.COLLABORATION_HOST,
        collaborationPort: config.COLLABORATION_PORT,
      },
      "Server startup failed",
    );
    if (!collaborationStarted)
      await collaboration.close().catch((err: unknown) => {
        app.log.error({ err }, "Collaboration cleanup after startup failure failed");
      });
    await shutdown();
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void startServer().catch((err: unknown) => {
    console.error("Server initialization failed before listeners started:", err);
    process.exitCode = 1;
  });
}
