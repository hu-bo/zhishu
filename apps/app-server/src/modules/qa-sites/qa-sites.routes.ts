import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { DomainError } from "../../shared/domain-error.js";
import { createSlidingWindowLimiter } from "../../shared/rate-limit.js";
import { requirePrincipal } from "../identity/principal.js";
import {
  aiEventViewSchema,
  conversationViewSchema,
  qaSubmitBodySchema,
  runViewSchema,
  scopeBodySchema,
  snapshotViewSchema,
  scopeSelectionSchema,
} from "../ai/ai.views.js";
import { conversationDto, startSse } from "../ai/index.js";
import type { QaService, QaAudience } from "../qa/qa.service.js";
import type { QaSiteService, QaSiteRow } from "./qa-site.service.js";

const COOKIE_NAME = "zhishu_qa_site";
const typedScope = scopeSelectionSchema;

/** Admin surface (/api/qa-sites) and the public entry (/api/public/qa-sites). */
export async function qaSitesRoutes(app: FastifyInstance, sites: QaSiteService, qa: QaService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  // The public code entry runs scrypt; bound attempts per source IP + site to keep a
  // single client from saturating the event loop / thread pool with cheap retries.
  const visitorSessionLimiter = createSlidingWindowLimiter({ limit: 10, windowMs: 60_000 });
  // Design §8: public cookie-authenticated writes reject a present, untrusted Origin on top
  // of SameSite=Lax. Admin routes use bearer tokens and are not cookie-CSRF exposed.
  app.addHook("onRequest", async (request) => {
    if (request.routeOptions.config.auth !== false) return;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS")
      return;
    if (!sites.publicOriginAllowed(request.headers.origin))
      throw new DomainError("FORBIDDEN", "跨站请求被拒绝");
  });
  const common = {
    tags: ["qa-sites"],
    security: [{ bearerAuth: [] }],
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  };
  const siteView = z.strictObject({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    welcome: z.string(),
    suggestedQuestions: z.array(z.string()),
    accessMode: z.enum(["public", "code"]),
    status: z.enum(["draft", "pending", "active", "paused", "disabled"]),
    revision: z.number().int(),
    accessRevision: z.number().int(),
    quotaPolicy: z.record(z.string(), z.number().int()),
    ownerWorkspaceId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });
  // Explicit projection: QaSiteRow carries tenantId/accessCodeHash/expiresAt/createdBy,
  // which must never reach an API response.
  const toView = (row: QaSiteRow) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    welcome: row.welcome,
    suggestedQuestions: row.suggestedQuestions,
    accessMode: row.accessMode,
    status: row.status,
    revision: row.revision,
    accessRevision: row.accessRevision,
    quotaPolicy: row.quotaPolicy as Record<string, number>,
    ownerWorkspaceId: row.ownerWorkspaceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  typed.get(
    "/qa-sites",
    {
      schema: {
        ...common,
        operationId: "listQaSites",
        response: { ...common.response, 200: z.array(siteView) },
      },
    },
    async (request) => (await sites.list(requirePrincipal(request.principal))).map(toView),
  );
  typed.post(
    "/qa-sites",
    {
      bodyLimit: 32768,
      schema: {
        ...common,
        operationId: "createQaSite",
        body: z.strictObject({
          ownerWorkspaceId: z.string().min(1).max(160),
          slug: z.string().min(2).max(64),
          name: z.string().min(1).max(200),
          description: z.string().max(2_000).optional(),
          welcome: z.string().max(2_000).optional(),
          suggestedQuestions: z.array(z.string().max(300)).max(6).optional(),
          accessMode: z.enum(["public", "code"]).optional(),
          accessCode: z.string().min(4).max(64).optional(),
        }),
        response: { ...common.response, 201: siteView },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(toView(await sites.create(requirePrincipal(request.principal), request.body))),
  );
  typed.get(
    "/qa-sites/:id",
    {
      schema: {
        ...common,
        operationId: "getQaSite",
        params: z.strictObject({ id: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        response: {
          ...common.response,
          200: z.strictObject({
            site: siteView,
            sources: z.array(
              z.strictObject({
                id: z.string(),
                workspaceId: z.string(),
                publicLabel: z.string(),
                grantedBy: z.string(),
              }),
            ),
            documents: z.array(
              z.strictObject({
                id: z.string(),
                sourceId: z.string(),
                workspaceId: z.string(),
                documentId: z.string(),
                state: z.enum(["active", "suspended"]),
                suspensionReason: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const principal = requirePrincipal(request.principal);
      const detail = await sites.detail(principal, request.params.id);
      return {
        site: toView(detail.site),
        sources: detail.sources.map((s) => ({
          id: s.id,
          workspaceId: s.workspaceId,
          publicLabel: s.publicLabel,
          grantedBy: s.grantedBy,
        })),
        documents: detail.documents.map((d) => ({
          id: d.id,
          sourceId: d.sourceId,
          workspaceId: d.workspaceId,
          documentId: d.documentId,
          state: d.state,
          suspensionReason: d.suspensionReason,
        })),
      };
    },
  );
  typed.patch(
    "/qa-sites/:id",
    {
      bodyLimit: 32768,
      schema: {
        ...common,
        operationId: "updateQaSite",
        params: z.strictObject({ id: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        body: z.strictObject({
          expectedRevision: z.number().int().min(1),
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(2_000).optional(),
          welcome: z.string().max(2_000).optional(),
          suggestedQuestions: z.array(z.string().max(300)).max(6).optional(),
          accessMode: z.enum(["public", "code"]).optional(),
          accessCode: z.string().min(4).max(64).optional(),
          quotaPolicy: z
            .strictObject({
              messagesPerHour: z.number().int().min(1).max(10_000),
              concurrentRuns: z.number().int().min(1).max(32),
            })
            .partial()
            .optional(),
        }),
        response: { ...common.response, 200: siteView },
      },
    },
    (request) =>
      sites
        .update(requirePrincipal(request.principal), request.params.id, request.body)
        .then(toView),
  );
  typed.put(
    "/qa-sites/:id/sources",
    {
      bodyLimit: 16384,
      schema: {
        ...common,
        operationId: "setQaSiteSources",
        params: z.strictObject({ id: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        body: z.strictObject({
          expectedRevision: z.number().int().min(1),
          sources: z
            .array(
              z.strictObject({
                workspaceId: z.string().min(1).max(160),
                publicLabel: z.string().min(1).max(120),
              }),
            )
            .max(8),
        }),
        response: { ...common.response, 200: siteView },
      },
    },
    async (request) =>
      toView(
        await sites.setSources(
          requirePrincipal(request.principal),
          request.params.id,
          request.body.expectedRevision,
          request.body.sources,
        ),
      ),
  );
  typed.put(
    "/qa-sites/:id/sources/:sourceId/documents",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "setQaSiteSourceDocuments",
        params: z.strictObject({
          id: z.string().regex(/^site_[a-f0-9]{32}$/),
          sourceId: z.string().min(1).max(160),
        }),
        body: z.strictObject({
          expectedRevision: z.number().int().min(1),
          items: z
            .array(
              z.strictObject({
                documentId: z.string().min(1).max(160),
                action: z.enum(["approve", "suspend", "withdraw"]),
                reason: z.string().max(300).optional(),
              }),
            )
            .max(200),
        }),
        response: { ...common.response, 200: z.null() },
      },
    },
    async (request) => {
      await sites.setDocuments(
        requirePrincipal(request.principal),
        request.params.id,
        request.params.sourceId,
        request.body.expectedRevision,
        request.body.items,
      );
      return null;
    },
  );
  for (const [path, operationId, status] of [
    ["/qa-sites/:id/activate", "activateQaSite", "active"],
    ["/qa-sites/:id/pause", "pauseQaSite", "paused"],
    ["/qa-sites/:id/revoke", "revokeQaSite", "disabled"],
  ] as const) {
    typed.post(
      path,
      {
        schema: {
          ...common,
          operationId,
          params: z.strictObject({ id: z.string().regex(/^site_[a-f0-9]{32}$/) }),
          body: z.strictObject({ expectedRevision: z.number().int().min(1) }),
          response: { ...common.response, 200: siteView },
        },
      },
      (request) =>
        sites
          .setStatus(
            requirePrincipal(request.principal),
            request.params.id,
            request.body.expectedRevision,
            status as "pending" | "active" | "paused" | "disabled",
          )
          .then(toView),
    );
  }
  typed.post(
    "/qa-sites/:id/preview",
    {
      bodyLimit: 16384,
      schema: {
        ...common,
        operationId: "previewQaSite",
        params: z.strictObject({ id: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        body: z.strictObject({
          message: qaSubmitBodySchema.optional(),
          scope: typedScope.optional(),
        }),
        response: {
          ...common.response,
          201: z.strictObject({
            conversationId: z.string().optional(),
            runId: z.string().optional(),
            approvedDocuments: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const site = await sites.get(principal, request.params.id);
      const approved = await sites.approvedDocuments(site);
      if (!request.body.message)
        return reply.code(201).send({ approvedDocuments: approved.length });
      const audience = await siteAudience(sites, site, approved, principal);
      const conversation = await qa.createConversation(audience, { scope: request.body.scope });
      const submitted = await qa.submitMessage(audience, conversation.id, {
        ...request.body.message,
        scope: request.body.scope,
      });
      return reply.code(201).send({
        conversationId: conversation.id,
        runId: submitted.runId,
        approvedDocuments: approved.length,
      });
    },
  );

  // ---------------------------------------------------------------- public entry

  // Capability-style routes: visitors are identified by site cookie, not by identity.
  const publicConfig = { auth: false } as const;
  const publicCommon = {
    tags: ["public-qa"],
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
      503: errorResponseSchema,
    },
  };
  typed.get(
    "/public/qa-sites/by-slug/:slug",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "getPublicQaSiteBySlug",
        params: z.strictObject({ slug: z.string().min(2).max(64) }),
        response: {
          ...publicCommon.response,
          200: z.strictObject({
            id: z.string(),
            slug: z.string(),
            name: z.string(),
            description: z.string(),
            welcome: z.string(),
            suggestedQuestions: z.array(z.string()),
            accessMode: z.enum(["public", "code"]),
            revision: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      reply.headers({ "cache-control": "no-store" });
      const shell = await sites.shellBySlug(request.params.slug);
      if (!shell) throw new DomainError("NOT_FOUND", "站点不存在");
      if (shell.site.status !== "active") throw new DomainError("FORBIDDEN", "站点当前不可访问");
      return pickShell(shell);
    },
  );
  typed.post(
    "/public/qa-sites/:siteId/visitor-session",
    {
      config: publicConfig,
      bodyLimit: 8192,
      schema: {
        ...publicCommon,
        operationId: "startPublicQaVisitorSession",
        params: z.strictObject({ siteId: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        body: z.strictObject({ accessCode: z.string().min(1).max(64).optional() }),
        response: {
          ...publicCommon.response,
          201: z.strictObject({ visitorId: z.string(), expiresAt: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (!visitorSessionLimiter.allow(`${request.ip}:${request.params.siteId}`))
        throw new DomainError("RESOURCE_LIMIT", "尝试过于频繁，请稍后再试");
      const site = await sites.activeSiteById(request.params.siteId);
      const session = await sites.startVisitorSession(site, request.body.accessCode);
      reply.header(
        "set-cookie",
        `${COOKIE_NAME}=${session.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxAgeSeconds}${sites.cookieSecure ? "; Secure" : ""}`,
      );
      return reply.code(201).send({
        visitorId: session.claims.visitorId,
        expiresAt: new Date(session.claims.expiresAt).toISOString(),
      });
    },
  );

  const requireVisitor = async (request: FastifyRequest): Promise<QaAudience> => {
    const siteId = (request.params as { siteId: string }).siteId;
    const site = await sites.activeSiteById(siteId);
    const claims = sites.resolveVisitor(site, readCookie(request, COOKIE_NAME));
    if (!claims) throw new DomainError("UNAUTHENTICATED", "访客凭据无效或已过期，请重新进入站点");
    return siteAudience(
      sites,
      site,
      await sites.approvedDocuments(site),
      undefined,
      claims.visitorId,
    );
  };

  typed.get(
    "/public/qa-sites/:siteId/conversations",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "listPublicQaConversations",
        params: z.strictObject({ siteId: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        ...publicCommon,
        response: { ...publicCommon.response, 200: z.array(conversationViewSchema) },
      },
    },
    async (request) => {
      const audience = await requireVisitor(request);
      const rows = await qa.listConversations(audience);
      return rows.map((row) => conversationDto(row, ""));
    },
  );
  typed.post(
    "/public/qa-sites/:siteId/conversations",
    {
      config: publicConfig,
      bodyLimit: 16384,
      schema: {
        ...publicCommon,
        operationId: "createPublicQaConversation",
        params: z.strictObject({ siteId: z.string().regex(/^site_[a-f0-9]{32}$/) }),
        body: z.strictObject({ scope: typedScope.optional() }),
        ...publicCommon,
        response: { ...publicCommon.response, 201: conversationViewSchema },
      },
    },
    async (request, reply) => {
      const audience = await requireVisitor(request);
      const conversation = await qa.createConversation(audience, { scope: request.body.scope });
      return reply
        .code(201)
        .send((await qa.snapshot(audience, conversation.id, { limit: 1 })).conversation);
    },
  );
  typed.get(
    "/public/qa-sites/:siteId/conversations/:id",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "getPublicQaConversation",
        params: z.strictObject({
          siteId: z.string().regex(/^site_[a-f0-9]{32}$/),
          id: z.string().regex(/^ai_[a-f0-9]{32}$/),
        }),
        ...publicCommon,
        response: { ...publicCommon.response, 200: snapshotViewSchema },
      },
    },
    async (request) => {
      const audience = await requireVisitor(request);
      const params = request.params as { id: string };
      return qa.snapshot(audience, params.id);
    },
  );
  typed.post(
    "/public/qa-sites/:siteId/conversations/:id/messages",
    {
      config: publicConfig,
      bodyLimit: 65536,
      schema: {
        ...publicCommon,
        operationId: "submitPublicQaMessage",
        params: z.strictObject({
          siteId: z.string().regex(/^site_[a-f0-9]{32}$/),
          id: z.string().regex(/^ai_[a-f0-9]{32}$/),
        }),
        body: qaSubmitBodySchema,
        response: {
          ...publicCommon.response,
          202: z.strictObject({
            runId: z.string(),
            conversationId: z.string(),
            contextRevision: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      const audience = await requireVisitor(request);
      const params = request.params as { id: string };
      const result = await qa.submitMessage(audience, params.id, request.body);
      reply.headers({ "cache-control": "no-store" });
      return reply.code(202).send({
        runId: result.runId,
        conversationId: params.id,
        contextRevision: request.body.expectedContextRevision,
      });
    },
  );
  typed.post(
    "/public/qa-sites/:siteId/conversations/:id/scope",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "updatePublicQaScope",
        params: z.strictObject({
          siteId: z.string().regex(/^site_[a-f0-9]{32}$/),
          id: z.string().regex(/^ai_[a-f0-9]{32}$/),
        }),
        body: scopeBodySchema,
        response: {
          ...publicCommon.response,
          200: z.strictObject({
            contextRevision: z.number().int(),
            scope: typedScope,
            cancelledRunIds: z.array(z.string()),
          }),
        },
      },
    },
    async (request) => {
      const audience = await requireVisitor(request);
      const params = request.params as { id: string };
      return qa.setScope(
        audience,
        params.id,
        request.body.expectedContextRevision,
        request.body.scope,
      );
    },
  );
  typed.get(
    "/public/qa-sites/:siteId/conversations/:id/events",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "observePublicQaConversation",
        params: z.strictObject({
          siteId: z.string().regex(/^site_[a-f0-9]{32}$/),
          id: z.string().regex(/^ai_[a-f0-9]{32}$/),
        }),
        querystring: z.strictObject({ cursor: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
        ...publicCommon,
        response: { ...publicCommon.response, 200: aiEventViewSchema },
      },
    },
    async (request, reply) => {
      const audience = await requireVisitor(request);
      const params = request.params as { id: string };
      const sse = startSse(reply);
      const controller = new AbortController();
      request.raw.once("close", () => controller.abort());
      try {
        await qa.streamEvents(audience, params.id, request.query.cursor, sse, controller.signal);
      } catch (error) {
        request.log.error({ err: error }, "Public QA event stream failed");
        sse.close();
      }
    },
  );
  typed.post(
    "/public/qa-sites/:siteId/conversations/:id/runs/:runId/cancel",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "cancelPublicQaRun",
        params: publicRunParams,
        ...publicCommon,
        response: { ...publicCommon.response, 200: runViewSchema },
      },
    },
    async (request) => {
      const audience = await requireVisitor(request);
      const params = request.params as { id: string; runId: string };
      return qa.cancelRun(audience, params.id, params.runId);
    },
  );
  typed.get(
    "/public/qa-sites/:siteId/artifacts/:artifactId",
    {
      config: publicConfig,
      schema: {
        ...publicCommon,
        operationId: "getPublicQaArtifact",
        params: z.strictObject({
          siteId: z.string().regex(/^site_[a-f0-9]{32}$/),
          artifactId: z.string().regex(/^art_[a-f0-9]{32}$/),
        }),
        querystring: z.strictObject({ conversationId: z.string().regex(/^ai_[a-f0-9]{32}$/) }),
        response: {
          ...publicCommon.response,
          200: z.strictObject({
            sources: z.array(
              z.strictObject({
                sourceKind: z.literal("document"),
                title: z.string(),
                label: z.string().optional(),
              }),
            ),
            items: z.array(
              z.strictObject({
                evidenceId: z.string(),
                locator: z.record(z.string(), z.unknown()),
                text: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const audience = await requireVisitor(request);
      return qa.readPublicEvidence(
        audience,
        request.query.conversationId,
        request.params.artifactId,
      );
    },
  );
}

const publicRunParams = z.strictObject({
  siteId: z.string().regex(/^site_[a-f0-9]{32}$/),
  id: z.string().regex(/^ai_[a-f0-9]{32}$/),
  runId: z.string().regex(/^run_[a-f0-9]{32}$/),
});

function pickShell(shell: {
  id: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestedQuestions: string[];
  accessMode: "public" | "code";
  revision: number;
}) {
  const { id, slug, name, description, welcome, suggestedQuestions, accessMode, revision } = shell;
  return { id, slug, name, description, welcome, suggestedQuestions, accessMode, revision };
}

async function siteAudience(
  sites: QaSiteService,
  site: QaSiteRow,
  approved: Awaited<ReturnType<QaSiteService["approvedDocuments"]>>,
  internal?: import("../identity/identity.types.js").Principal,
  visitorId?: string,
): Promise<QaAudience> {
  void sites;
  if (internal)
    return {
      kind: "site",
      tenantId: site.tenantId,
      siteId: site.id,
      visitorId: `preview_${internal.identityId}`,
      approved,
      accessRevision: site.accessRevision,
      internal,
    };
  return {
    kind: "site",
    tenantId: site.tenantId,
    siteId: site.id,
    visitorId: visitorId ?? "anonymous",
    approved,
    accessRevision: site.accessRevision,
  };
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return;
}
