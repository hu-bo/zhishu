import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AppConfig } from "./config.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { OperationsMetrics } from "./modules/health/operations-metrics.js";
import { identityRoutes } from "./modules/identity/identity.routes.js";
import { registerIdentityGuard } from "./modules/identity/index.js";
import { MockIdentityService } from "./modules/identity/identity.service.js";
import { documentsModule } from "./modules/documents/index.js";
import { DocumentRepository } from "./modules/documents/document.repository.js";
import { DocumentProjectionWorker } from "./modules/documents/projection-worker.js";
import { assetsModule } from "./modules/assets/index.js";
import { projectsModule } from "./modules/projects/index.js";
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";
import type { CollaborationSessionRevoker } from "./modules/documents/document.service.js";
import type { PrincipalAuthenticator } from "./modules/identity/identity.types.js";

export async function buildApp(
  config: AppConfig,
  options: {
    exportMode?: boolean;
    sessionRevoker?: CollaborationSessionRevoker;
    identityAuthenticator?: PrincipalAuthenticator;
  } = {},
) {
  const mockIdentityService =
    config.AUTH_MODE === "mock"
      ? new MockIdentityService(config.MOCK_AUTH_TOKEN_TTL_SECONDS)
      : null;
  const identityAuthenticator = options.identityAuthenticator ?? mockIdentityService;
  if (!identityAuthenticator) {
    throw new Error("AUTH_MODE=external requires a trusted PrincipalAuthenticator.");
  }
  const operationsMetrics = new OperationsMetrics();
  const requestStartTimes = new WeakMap<object, bigint>();
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.token",
      ],
    },
    requestIdHeader: false,
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    requestStartTimes.set(request, process.hrtime.bigint());
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartTimes.get(request);
    if (startedAt === undefined) return;
    operationsMetrics.recordRequest({
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode: reply.statusCode,
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    });
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  try {
    await registerOpenApi(app, config.SWAGGER_UI_ENABLED && !options.exportMode);
    await app.register(databasePlugin, { ...config, exportMode: options.exportMode });
    await app.register(async (scope) =>
      healthRoutes(scope, operationsMetrics, config.METRICS_BEARER_TOKEN),
    );
    await app.register(
      async (api) => {
        registerIdentityGuard(api, identityAuthenticator);
        await api.register(identityRoutes, {
          service: mockIdentityService ?? undefined,
          prefix: "/auth",
        });
        await api.register(projectsModule);
        await api.register((scope) => assetsModule(scope, config, options.exportMode));
        await api.register(async (scope) =>
          documentsModule(scope, config, options.sessionRevoker ?? { revokeDocumentSessions() {} }),
        );
      },
      { prefix: "/api" },
    );
    if (!options.exportMode) {
      const projectionWorker = new DocumentProjectionWorker(new DocumentRepository(app.db), () =>
        app.log.error("Document projection task failed"),
      );
      app.addHook("onReady", async () => projectionWorker.start());
      app.addHook("preClose", async () => projectionWorker.stop());
    }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
