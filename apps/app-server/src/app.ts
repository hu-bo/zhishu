import { workspacesModule } from "./modules/workspaces/index.js";
import { catalogsModule } from "./modules/catalogs/index.js";
import { knowledgeModule } from "./modules/knowledge/index.js";
import { authorizationModule } from "./modules/authorization/index.js";
import { randomUUID } from "node:crypto";
import Fastify, { LogController } from "fastify";
import type { FastifyBaseLogger } from "fastify";
import { createLogger } from "@zhishu/logger-js";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { MOCK_AUTH_TOKEN_TTL_SECONDS, type AppConfig } from "./config.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { OperationsMetrics } from "./modules/health/operations-metrics.js";
import type { OperationsMetrics as OperationsMetricsType } from "./modules/health/operations-metrics.js";
import { identityRoutes } from "./modules/identity/identity.routes.js";
import { registerIdentityGuard } from "./modules/identity/index.js";
import { AuthServiceIdentityService } from "./modules/identity/auth-service-authenticator.js";
import { MockIdentityService } from "./modules/identity/identity.service.js";
import {
  documentsModule,
  DocumentProjectionRepository,
  DocumentProjectionWorker,
} from "./modules/documents/index.js";
import { assetsModule } from "./modules/assets/index.js";
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";
import type { CollaborationSessionRevoker } from "./modules/collaboration/session-revoker.js";
import type { PrincipalAuthenticator } from "./modules/identity/identity.types.js";
import type { CollaborationOwner } from "./modules/collaboration/owner.js";
import { assembleAiSystems } from "./ai-systems.js";
import type { RagService } from "./modules/rag/rag.service.js";
import { assistantModule } from "./modules/ai/index.js";
import { qaSitesModule } from "./modules/qa-sites/index.js";
import { DomainError } from "./shared/domain-error.js";
import { notificationsModule } from "./modules/notifications/index.js";
import { invitationsModule } from "./modules/invitations/index.js";
import type { LlmAdapter } from "@zhishu/dsh-agent/kernel";
import { AuthorizationEventWorker } from "./modules/authorization/authorization-events.js";

export async function buildApp(
  config: AppConfig,
  options: {
    exportMode?: boolean;
    sessionRevoker?: CollaborationSessionRevoker;
    identityAuthenticator?: PrincipalAuthenticator;
    operationsMetrics?: OperationsMetricsType;
    collaborationOwner?: CollaborationOwner;
    assistantAdapter?: LlmAdapter;
    /** Test seam: scripted retrieval for the AI smoke runner (production never sets this). */
    ragStub?: RagService | null;
  } = {},
) {
  const mockIdentityService =
    config.AUTH_MODE === "mock" ? new MockIdentityService(MOCK_AUTH_TOKEN_TTL_SECONDS) : null;
  // external mode assembles the trusted Auth Service provider from server config;
  // hosts may still override it via options.identityAuthenticator (test seam).
  const authServiceIdentityService =
    config.AUTH_MODE === "external" ? AuthServiceIdentityService.fromConfig(config) : null;
  const identityAuthenticator =
    options.identityAuthenticator ?? mockIdentityService ?? authServiceIdentityService;
  if (!identityAuthenticator) {
    throw new Error("AUTH_MODE=external requires a trusted PrincipalAuthenticator.");
  }
  const operationsMetrics = options.operationsMetrics ?? new OperationsMetrics();
  const requestStartTimes = new WeakMap<object, bigint>();
  // Typed as FastifyBaseLogger so route modules keep the shared instance type.
  const logger: FastifyBaseLogger = createLogger("app-server", {
    environment: config.NODE_ENV,
    level: config.LOG_LEVEL,
    directory: config.LOG_DIR,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.token",
      // Tavily and visitor secrets must never reach logs even in structured payloads.
      "req.headers.x-tavily-key",
    ],
  });
  const app = Fastify({
    genReqId: () => randomUUID(),
    // Liveness/readiness probes and Prometheus scrapes fire on a fixed cadence; keep their
    // framework request lines out of the log. Probe failures surface via the HTTP status
    // and real database trouble still logs through ordinary request handlers.
    logController: new LogController({
      disableRequestLogging: (request) => {
        const path = request.url.split("?", 1)[0];
        return path.startsWith("/health/") || path === "/metrics";
      },
    }),
    requestIdHeader: false,
    // Shared Pino instance from @zhishu/logger-js; Fastify request logs flow through it.
    loggerInstance: logger,
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
    // AI systems are assembled before route registration so ownership-change
    // transactions receive the public-linkage port from the root assembly.
    const unavailable = async () => {
      throw new DomainError("SERVICE_UNAVAILABLE", "协同服务尚未就绪");
    };
    const sessionRevoker = options.sessionRevoker ?? { revokeDocumentSessions() {} };
    const ai = assembleAiSystems(app, config, {
      exportMode: options.exportMode,
      collaborationOwner: options.collaborationOwner ?? {
        snapshot: unavailable,
        apply: unavailable,
      },
      sessionRevoker,
      assistantAdapter: options.assistantAdapter,
      ragStub: options.ragStub,
    });
    await app.register(
      async (api) => {
        registerIdentityGuard(api, identityAuthenticator);
        await api.register(identityRoutes, {
          service: mockIdentityService ?? undefined,
          prefix: "/auth",
        });
        await api.register((scope) => authorizationModule(scope, sessionRevoker));
        await api.register(notificationsModule);
        await api.register(invitationsModule);
        await api.register((scope) => assetsModule(scope, config, options.exportMode));
        await api.register((scope) => workspacesModule(scope, sessionRevoker));
        await api.register((scope) => catalogsModule(scope, sessionRevoker, ai.publicLinkage));
        await api.register((scope) => knowledgeModule(scope, sessionRevoker, ai.publicLinkage));
        await api.register(async (scope) =>
          documentsModule(scope, config, sessionRevoker, options.exportMode, ai.publicLinkage),
        );
        await api.register((scope) => assistantModule(scope, ai.assistant));
        await api.register((scope) => qaSitesModule(scope, ai.sites, ai.assistant));
      },
      { prefix: "/api" },
    );
    if (!options.exportMode) {
      const permissionWorker = new AuthorizationEventWorker(app.db, sessionRevoker, (err) =>
        app.log.error({ err }, "Permission invalidation failed; durable events will be retried"),
      );
      app.addHook("onReady", async () => permissionWorker.start());
      app.addHook("preClose", async () => permissionWorker.stop());
      const projectionWorker = new DocumentProjectionWorker(
        new DocumentProjectionRepository(app.db),
        (err) => app.log.error({ err }, "Document projection task failed"),
      );
      app.addHook("onReady", async () => projectionWorker.start());
      app.addHook("preClose", async () => projectionWorker.stop());
      app.addHook("onReady", async () => ai.start());
    }
    app.addHook("preClose", async () => ai.stop());
    return app;
  } catch (error) {
    await app.close().catch((err: unknown) => {
      app.log.error({ err }, "Application cleanup after initialization failure failed");
    });
    throw error;
  }
}
