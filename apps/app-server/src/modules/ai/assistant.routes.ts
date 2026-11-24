import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { requirePrincipal } from "../identity/principal.js";
import {
  aiEventViewSchema,
  artifactIdParamsSchema,
  assistantPluginIdSchema,
  bindTargetBodySchema,
  conversationIdParamsSchema,
  conversationViewSchema,
  createDraftBodySchema,
  runParamsSchema,
  runViewSchema,
  scopeBodySchema,
  snapshotViewSchema,
  submitMessageBodySchema,
} from "./ai.views.js";
import { conversationDto } from "./ai.types.js";
import { startSse } from "./event-stream.js";
import type { AssistantAudience, AssistantService } from "./assistant.service.js";

/**
 * Unified internal assistant namespace. One conversation combines question answering,
 * research and writing; intent is a per-round hint, never a route-level engine fork.
 */
export async function assistantRoutes(app: FastifyInstance, assistant: AssistantService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["ai"],
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
  const audienceOf = (request: FastifyRequest): AssistantAudience => ({
    kind: "internal",
    principal: requirePrincipal(request.principal),
  });
  typed.get(
    "/capabilities",
    {
      schema: {
        ...common,
        operationId: "getAiCapabilities",
        response: {
          ...common.response,
          200: z.strictObject({
            enabled: z.boolean(),
            engine: z.literal("dsh-native-v1"),
            reason: z.string().optional(),
            plugins: z.array(assistantPluginIdSchema),
            image: z.strictObject({ available: z.boolean(), reason: z.string() }),
            webSearchAvailable: z.boolean(),
            webSearchLimits: z
              .strictObject({
                searchCallsPerRun: z.number().int(),
                resultsPerSearch: z.number().int(),
                readPagesPerRun: z.number().int(),
              })
              .optional(),
            retrieval: z.strictObject({
              contextTokenBudget: z.number().int(),
              maxEvidenceItems: z.number().int(),
              scopeLimits: z.strictObject({
                maxWorkspaces: z.number().int(),
                maxDocuments: z.number().int(),
                maxAllDocuments: z.number().int(),
              }),
            }),
            configurationId: z.string(),
          }),
        },
      },
    },
    (request) => {
      audienceOf(request);
      return assistant.capabilities();
    },
  );
  typed.get(
    "/conversations",
    {
      schema: {
        ...common,
        operationId: "listAiConversations",
        response: { ...common.response, 200: z.array(conversationViewSchema) },
      },
    },
    async (request) => {
      const rows = await assistant.listConversations(audienceOf(request));
      return rows.map((row) => conversationDto(row, ""));
    },
  );
  typed.post(
    "/conversations",
    {
      bodyLimit: 32768,
      schema: {
        ...common,
        operationId: "createAiConversation",
        body: z.strictObject({
          targetDocumentId: z.string().max(160).nullable().optional(),
          scope: conversationViewSchema.shape.scope.optional(),
          creationKey: z.string().min(1).max(160).optional(),
        }),
        response: { ...common.response, 201: conversationViewSchema },
      },
    },
    async (request, reply) => {
      const audience = audienceOf(request);
      const conversation = await assistant.createConversation(audience, request.body);
      const snapshot = await assistant.snapshot(audience, conversation.id, { limit: 1 });
      return reply.code(201).send(snapshot.conversation);
    },
  );
  typed.get(
    "/conversations/:id",
    {
      schema: {
        ...common,
        operationId: "getAiConversation",
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
      assistant.snapshot(audienceOf(request), request.params.id, request.query ?? undefined),
  );
  typed.post(
    "/conversations/:id/messages",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "submitAiMessage",
        params: conversationIdParamsSchema,
        body: submitMessageBodySchema,
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
      const result = await assistant.submitMessage(
        audienceOf(request),
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
    "/conversations/:id/context",
    {
      schema: {
        ...common,
        operationId: "updateAiContext",
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
      assistant.setScope(
        audienceOf(request),
        request.params.id,
        request.body.expectedContextRevision,
        request.body.scope,
      ),
  );
  typed.post(
    "/conversations/:id/draft",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "createAiDraft",
        params: conversationIdParamsSchema,
        body: createDraftBodySchema,
        response: {
          ...common.response,
          202: z.strictObject({
            runId: z.string().nullable(),
            documentId: z.string().optional(),
            replayed: z.boolean(),
            status: z.enum(["accepted", "in-progress", "already-bound"]),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await assistant.createDraft(
        requirePrincipal(request.principal),
        request.params.id,
        request.body,
      );
      return reply.code(202).send(result);
    },
  );
  typed.post(
    "/conversations/:id/target",
    {
      schema: {
        ...common,
        operationId: "bindAiTarget",
        params: conversationIdParamsSchema,
        body: bindTargetBodySchema,
        response: {
          ...common.response,
          200: z.strictObject({
            contextRevision: z.number().int(),
            targetDocumentId: z.string(),
            cancelledRunIds: z.array(z.string()),
          }),
        },
      },
    },
    (request) =>
      assistant.bindTarget(requirePrincipal(request.principal), request.params.id, request.body),
  );
  typed.get(
    "/conversations/:id/events",
    {
      schema: {
        ...common,
        operationId: "observeAiConversation",
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
        await assistant.streamEvents(
          audienceOf(request),
          request.params.id,
          request.query.cursor,
          sse,
          controller.signal,
        );
      } catch (error) {
        request.log.error({ err: error }, "Assistant event stream failed");
        sse.close();
      }
    },
  );
  typed.post(
    "/conversations/:id/runs/:runId/cancel",
    {
      schema: {
        ...common,
        operationId: "cancelAiRun",
        params: runParamsSchema,
        response: { ...common.response, 200: runViewSchema },
      },
    },
    (request) => assistant.cancelRun(audienceOf(request), request.params.id, request.params.runId),
  );
  typed.post(
    "/conversations/:id/runs/:runId/retry",
    {
      schema: {
        ...common,
        operationId: "retryAiRun",
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
          await assistant.retryRun(audienceOf(request), request.params.id, request.params.runId),
        ),
  );
  typed.post(
    "/conversations/:id/approvals/:approvalId/decisions",
    {
      schema: {
        ...common,
        operationId: "decideAiApproval",
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
      return assistant.decide(audienceOf(request), params.id, params.approvalId, request.body);
    },
  );
  typed.get(
    "/artifacts/:artifactId",
    {
      schema: {
        ...common,
        operationId: "getAiArtifact",
        params: artifactIdParamsSchema,
        querystring: z.strictObject({ conversationId: z.string().regex(/^ai_[a-f0-9]{32}$/) }),
        // Artifact payloads vary by kind (evidence/draft/proposal/image).
        response: { ...common.response, 200: z.record(z.string(), z.unknown()) },
      },
    },
    (request) =>
      assistant.readArtifact(
        audienceOf(request),
        request.query.conversationId,
        request.params.artifactId,
      ),
  );
  typed.post(
    "/artifacts/:artifactId/review",
    {
      schema: {
        ...common,
        operationId: "reviewAiProposal",
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
      assistant.reviewProposal(
        requirePrincipal(request.principal),
        request.params.artifactId,
        request.body,
      ),
  );
  typed.get(
    "/conversations/:id/images",
    {
      schema: {
        ...common,
        operationId: "listAiImages",
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
    (request) => assistant.listImages(audienceOf(request), request.params.id),
  );
  typed.post(
    "/conversations/:id/images/:jobKey/refresh",
    {
      schema: {
        ...common,
        operationId: "refreshAiImage",
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
      assistant.refreshImage(
        audienceOf(request),
        request.params.id,
        (request.params as { jobKey: string }).jobKey,
      ),
  );
  typed.get(
    "/conversations/:id/images/:assetId/access",
    {
      schema: {
        ...common,
        operationId: "getAiImageAccess",
        params: conversationIdParamsSchema.extend({
          assetId: z.string().regex(/^image_[a-f0-9]{48}$/),
        }),
        response: {
          ...common.response,
          200: z.strictObject({ url: z.string(), expiresAt: z.string().nullable() }),
        },
      },
    },
    (request) =>
      assistant.imageAccess(
        audienceOf(request),
        request.params.id,
        (request.params as { assetId: string }).assetId,
      ),
  );
}
