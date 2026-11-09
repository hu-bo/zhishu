import { workspacesModule } from "./modules/workspaces/index.js";
import { catalogsModule } from "./modules/catalogs/index.js";
import { knowledgeModule } from "./modules/knowledge/index.js";
import { authorizationModule } from "./modules/authorization/index.js";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AppConfig } from "./config.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { OperationsMetrics } from "./modules/health/operations-metrics.js";
import type { OperationsMetrics as OperationsMetricsType } from "./modules/health/operations-metrics.js";
import { identityRoutes } from "./modules/identity/identity.routes.js";
import { registerIdentityGuard } from "./modules/identity/index.js";
import { MockIdentityService } from "./modules/identity/identity.service.js";
import {
  documentsModule,
  DocumentProjectionRepository,
  DocumentProjectionWorker,
} from "./modules/documents/index.js";
import { assetsModule } from "./modules/assets/index.js";
import { projectsModule } from "./modules/projects/index.js";
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";
import type { CollaborationSessionRevoker } from "./modules/collaboration/session-revoker.js";
import type { PrincipalAuthenticator } from "./modules/identity/identity.types.js";
import type { CollaborationOwner } from "./modules/collaboration/owner.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { aiModule } from "./modules/ai/index.js";
import { DomainError } from "./shared/domain-error.js";
import { notificationsModule } from "./modules/notifications/index.js";
import { invitationsModule } from "./modules/invitations/index.js";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { AuthorizationEventWorker } from "./modules/authorization/authorization-events.js";

export async function buildApp(
  config: AppConfig,
  options: {
    exportMode?: boolean;
    sessionRevoker?: CollaborationSessionRevoker;
    identityAuthenticator?: PrincipalAuthenticator;
    operationsMetrics?: OperationsMetricsType;
    collaborationOwner?: CollaborationOwner;
    aiModel?: BaseChatModel;
    writingAdapter?: LlmAdapter;
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
  const operationsMetrics = options.operationsMetrics ?? new OperationsMetrics();
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
        await api.register((scope) =>
          authorizationModule(scope, options.sessionRevoker ?? { revokeDocumentSessions() {} }),
        );
        await api.register(notificationsModule);
        await api.register(invitationsModule);
        await api.register((scope) => assetsModule(scope, config, options.exportMode));
        const sessionRevoker = options.sessionRevoker ?? { revokeDocumentSessions() {} };
        await api.register((scope) => workspacesModule(scope, sessionRevoker));
        await api.register((scope) => catalogsModule(scope, sessionRevoker));
        await api.register((scope) => knowledgeModule(scope, config, sessionRevoker));
        await api.register(async (scope) =>
          documentsModule(scope, config, sessionRevoker, options.exportMode),
        );
        const unavailable = async () => {
          throw new DomainError("SERVICE_UNAVAILABLE", "协同服务尚未就绪");
        };
        await api.register((scope) =>
          aiModule(
            scope,
            config,
            options.collaborationOwner ?? { snapshot: unavailable, apply: unavailable },
            options.exportMode,
            options.aiModel,
            options.writingAdapter,
          ),
        );
      },
      { prefix: "/api" },
    );
    if (!options.exportMode) {
      const permissionWorker = new AuthorizationEventWorker(
        app.db,
        options.sessionRevoker ?? { revokeDocumentSessions() {} },
        (err) =>
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
    }
    return app;
  } catch (error) {
    await app.close().catch((err: unknown) => {
      app.log.error({ err }, "Application cleanup after initialization failure failed");
    });
    throw error;
  }
}
