import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { requirePrincipal } from "../identity/principal.js";
import {
  aiEventViewSchema,
  artifactIdParamsSchema,
  conversationIdParamsSchema,
  conversationViewSchema,
  runParamsSchema,
  runViewSchema,
  scopeBodySchema,
  snapshotViewSchema,
  writingSubmitBodySchema,
} from "../ai/ai.views.js";
import { startSse } from "../ai/index.js";
import type { WritingService } from "./writing.service.js";

/** Writing namespace: purpose=writing is fixed by these routes; no dynamic executor. */
export async function writingRoutes(app: FastifyInstance, writing: WritingService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["writing"],
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
  const principalOf = (request: FastifyRequest) => requirePrincipal(request.principal);
  typed.get(
    "/writing/capabilities",
    {
      schema: {
        ...common,
        operationId: "getWritingCapabilities",
        response: {
          ...common.response,
          200: z.strictObject({
            enabled: z.boolean(),
            engine: z.literal("dsh-native-v1"),
            reason: z.string().optional(),
            image: z.strictObject({ available: z.boolean(), reason: z.string() }),
            webSearchAvailable: z.boolean(),
            webSearchLimits: z
              .strictObject({
                searchCallsPerRun: z.number().int(),
                resultsPerSearch: z.number().int(),
                readPagesPerRun: z.number().int(),
              })
              .optional(),
            configurationId: z.string(),
          }),
        },
      },
    },
    (request) => {
      principalOf(request);
      return writing.capabilities();
    },
  );
  typed.get(
    "/writing/conversations",
    {
      schema: {
        ...common,
        operationId: "listWritingConversations",
        querystring: z
          .strictObject({
            targetDocumentId: z.string().max(160).optional(),
          })
          .optional(),
        response: { ...common.response, 200: z.array(conversationViewSchema) },
      },
    },
    async (request) => {
      const principal = principalOf(request);
      const rows = await writing.listConversations(principal, request.query?.targetDocumentId);
      return rows.map((row) => ({
        id: row.id,
        purpose: row.purpose,
        title: "",
        scope: row.scopeSelection,
        contextRevision: row.contextRevision,
        status: row.status,
        targetDocumentId: row.targetDocumentId,
        eventSequence: row.eventSequence.toString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
  );
  typed.post(
    "/writing/conversations",
    {
      bodyLimit: 32768,
      schema: {
        ...common,
        operationId: "createWritingConversation",
        body: z.strictObject({
          targetDocumentId: z.string().max(160).nullable().optional(),
          scope: conversationViewSchema.shape.scope.optional(),
          creationKey: z.string().min(1).max(160).optional(),
        }),
        response: { ...common.response, 201: conversationViewSchema },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const conversation = await writing.createConversation(principal, request.body);
      const snapshot = await writing.snapshot(principal, conversation.id, { limit: 1 });
      return reply.code(201).send(snapshot.conversation);
    },
  );
  typed.get(
    "/writing/conversations/:id",
    {
      schema: {
        ...common,
        operationId: "getWritingConversation",
        params: conversationIdParamsSchema,
        querystring: z
          .strictObject({
            before: z.string().max(160).optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          })
          .optional(),
        response: { ...common.response, 200: snapshotViewSchema },
      },
    },
    (request) =>
      writing.snapshot(principalOf(request), request.params.id, request.query ?? undefined),
  );
  typed.post(
    "/writing/conversations/:id/messages",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "submitWritingMessage",
        params: conversationIdParamsSchema,
        body: writingSubmitBodySchema,
        response: {
          ...common.response,
          202: z.strictObject({
            runId: z.string(),
            conversationId: z.string(),
            contextRevision: z.number().int(),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await writing.submitMessage(
        principalOf(request),
        request.params.id,
        request.body,
      );
      return reply.code(202).send({
        runId: result.runId,
        conversationId: request.params.id,
        contextRevision: request.body.expectedContextRevision,
      });
    },
  );
  typed.post(
    "/writing/conversations/:id/scope",
    {
      schema: {
        ...common,
        operationId: "updateWritingScope",
        params: conversationIdParamsSchema,
        body: scopeBodySchema,
        response: {
          ...common.response,
          200: z.strictObject({
            contextRevision: z.number().int(),
            scope: conversationViewSchema.shape.scope,
            cancelledRunIds: z.array(z.string()),
          }),
        },
      },
    },
    (request) =>
      writing.setScope(
        principalOf(request),
        request.params.id,
        request.body.expectedContextRevision,
        request.body.scope,
      ),
  );
  typed.get(
    "/writing/conversations/:id/events",
    {
      schema: {
        ...common,
        operationId: "observeWritingConversation",
        params: conversationIdParamsSchema,
        querystring: z.strictObject({ cursor: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
        response: { ...common.response, 200: aiEventViewSchema },
      },
    },
    async (request, reply) => {
      const sse = startSse(reply);
      const controller = new AbortController();
      request.raw.once("close", () => controller.abort());
      try {
        await writing.streamEvents(
          principalOf(request),
          request.params.id,
          request.query.cursor,
          sse,
          controller.signal,
        );
      } catch (error) {
        request.log.error({ err: error }, "Writing event stream failed");
        sse.close();
      }
    },
  );
  typed.post(
    "/writing/conversations/:id/runs/:runId/cancel",
    {
      schema: {
        ...common,
        operationId: "cancelWritingRun",
        params: runParamsSchema,
        response: { ...common.response, 200: runViewSchema },
      },
    },
    (request) => writing.cancelRun(principalOf(request), request.params.id, request.params.runId),
  );
  typed.post(
    "/writing/conversations/:id/runs/:runId/retry",
    {
      schema: {
        ...common,
        operationId: "retryWritingRun",
        params: runParamsSchema,
        response: {
          ...common.response,
          202: z.strictObject({
            kind: z.enum(["already-terminal", "queued", "redeliver-staged"]),
            run: runViewSchema,
          }),
        },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await writing.retryRun(principalOf(request), request.params.id, request.params.runId),
        ),
  );
  typed.get(
    "/writing/artifacts/:artifactId",
    {
      schema: {
        ...common,
        operationId: "getWritingArtifact",
        params: artifactIdParamsSchema,
        querystring: z.strictObject({ conversationId: z.string().regex(/^ai_[a-f0-9]{32}$/) }),
        // Writing artifact payloads vary by kind (evidence/draft/proposal/image).
        response: { ...common.response, 200: z.record(z.string(), z.unknown()) },
      },
    },
    (request) =>
      writing.artifact(
        principalOf(request),
        request.query.conversationId,
        request.params.artifactId,
      ),
  );
  typed.post(
    "/writing/artifacts/:artifactId/review",
    {
      schema: {
        ...common,
        operationId: "reviewWritingProposal",
        params: artifactIdParamsSchema,
        body: z.strictObject({
          decisionId: z.string().min(8).max(64),
          revision: z.number().int().min(0).max(256),
          action: z.enum(["accept", "reject"]),
          blockIds: z.array(z.string().min(1).max(160)).max(256).optional(),
        }),
        response: {
          ...common.response,
          200: z.strictObject({
            applicationState: z.enum([
              "pending",
              "partial",
              "applied",
              "rejected",
              "conflict",
              "unknown",
            ]),
            receipt: z
              .strictObject({
                operationId: z.string(),
                generationId: z.string(),
                durableSeq: z.number().int(),
                structureRevision: z.number().int(),
              })
              .optional(),
          }),
        },
      },
    },
    (request) =>
      writing.reviewProposal(principalOf(request), request.params.artifactId, request.body),
  );
  typed.post(
    "/writing/conversations/:id/approvals/:approvalId/decisions",
    {
      schema: {
        ...common,
        operationId: "decideWritingApproval",
        params: conversationIdParamsSchema.extend({
          approvalId: z.string().min(1).max(160),
        }),
        body: z.strictObject({
          decisionId: z.string().min(8).max(64),
          decision: z.enum(["allow-once", "reject"]),
        }),
        response: {
          ...common.response,
          200: z.strictObject({
            status: z.enum([
              "pending",
              "allowed",
              "rejected",
              "cancelled",
              "expired",
              "unavailable",
            ]),
          }),
        },
      },
    },
    (request) => {
      const params = request.params as { id: string; approvalId: string };
      return writing.decide(principalOf(request), params.id, params.approvalId, request.body);
    },
  );
  typed.get(
    "/writing/conversations/:id/images",
    {
      schema: {
        ...common,
        operationId: "listWritingImages",
        params: conversationIdParamsSchema,
        response: {
          ...common.response,
          200: z.array(
            z.strictObject({
              key: z.string(),
              runId: z.string(),
              job: z.union([
                z.strictObject({
                  id: z.string(),
                  status: z.enum(["pending", "unknown", "failed"]),
                  code: z.string().optional(),
                }),
                z.strictObject({
                  id: z.string(),
                  status: z.literal("ready"),
                  assets: z
                    .array(
                      z.strictObject({
                        assetId: z.string(),
                        mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
                        width: z.number().int(),
                        height: z.number().int(),
                      }),
                    )
                    .max(1),
                }),
              ]),
            }),
          ),
        },
      },
    },
    (request) => writing.listImages(principalOf(request), request.params.id),
  );
  typed.post(
    "/writing/conversations/:id/images/:jobKey/refresh",
    {
      schema: {
        ...common,
        operationId: "refreshWritingImage",
        params: conversationIdParamsSchema.extend({
          jobKey: z.string().regex(/^run_[a-f0-9]{32}:.+/),
        }),
        response: {
          ...common.response,
          200: z
            .strictObject({
              status: z.enum(["pending", "unknown", "ready", "failed"]),
              assetId: z.string().optional(),
            })
            .passthrough(),
        },
      },
    },
    (request) =>
      writing.refreshImage(
        principalOf(request),
        request.params.id,
        (request.params as { jobKey: string }).jobKey,
      ),
  );
  typed.get(
    "/writing/conversations/:id/images/:assetId/access",
    {
      schema: {
        ...common,
        operationId: "getWritingImageAccess",
        params: conversationIdParamsSchema.extend({
          assetId: z.string().regex(/^image_[a-f0-9]{48}$/),
        }),
        response: {
          ...common.response,
          200: z.strictObject({ url: z.string(), expiresAt: z.string() }),
        },
      },
    },
    (request) =>
      writing.imageAccess(
        principalOf(request),
        request.params.id,
        (request.params as { assetId: string }).assetId,
      ),
  );
}
