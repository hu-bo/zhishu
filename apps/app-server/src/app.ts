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
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";
import type { CollaborationSessionRevoker } from "./modules/collaboration/session-revoker.js";
import type { PrincipalAuthenticator } from "./modules/identity/identity.types.js";
import type { CollaborationOwner } from "./modules/collaboration/owner.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { assembleAiSystems } from "./ai-systems.js";
import type { RagService } from "./modules/rag/rag.service.js";
import { qaModule } from "./modules/qa/index.js";
import { writingModule } from "./modules/writing/index.js";
import { qaSitesModule } from "./modules/qa-sites/index.js";
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
    /** Test seam: scripted retrieval for the AI smoke runner (production never sets this). */
    ragStub?: RagService | null;
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
        // Tavily and visitor secrets must never reach logs even in structured payloads.
        "req.headers.x-tavily-key",
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
    // AI systems are assembled before route registration so ownership-change
    // transactions receive the public-linkage port from the root assembly.
    const unavailable = async () => {
      throw new DomainError("SERVICE_UNAVAILABLE", "协同服务尚未就绪");
    };
    const ai = assembleAiSystems(app, config, {
      exportMode: options.exportMode,
      collaborationOwner: options.collaborationOwner ?? {
        snapshot: unavailable,
        apply: unavailable,
      },
      aiModel: options.aiModel,
      writingAdapter: options.writingAdapter,
      ragStub: options.ragStub,
    });
    await app.register(
      async (api) => {
        registerIdentityGuard(api, identityAuthenticator);
        await api.register(identityRoutes, {
          service: mockIdentityService ?? undefined,
          prefix: "/auth",
        });
        await api.register((scope) =>
          authorizationModule(scope, options.sessionRevoker ?? { revokeDocumentSessions() {} }),
        );
        await api.register(notificationsModule);
        await api.register(invitationsModule);
        await api.register((scope) => assetsModule(scope, config, options.exportMode));
        const sessionRevoker = options.sessionRevoker ?? { revokeDocumentSessions() {} };
        await api.register((scope) => workspacesModule(scope, sessionRevoker));
        await api.register((scope) => catalogsModule(scope, sessionRevoker, ai.publicLinkage));
        await api.register((scope) =>
          knowledgeModule(scope, config, sessionRevoker, ai.publicLinkage),
        );
        await api.register(async (scope) =>
          documentsModule(scope, config, sessionRevoker, options.exportMode, ai.publicLinkage),
        );
        await api.register((scope) => qaModule(scope, ai.qa));
        await api.register((scope) => writingModule(scope, ai.writing));
        await api.register((scope) => qaSitesModule(scope, ai.sites, ai.qa));
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
