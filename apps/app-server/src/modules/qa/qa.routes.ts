import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { requirePrincipal } from "../identity/principal.js";
import {
  aiEventViewSchema,
  artifactIdParamsSchema,
  conversationIdParamsSchema,
  messageIdParamsSchema,
  qaSubmitBodySchema,
  runParamsSchema,
  scopeBodySchema,
  snapshotViewSchema,
  conversationViewSchema,
  runViewSchema,
  scopeSelectionSchema,
} from "../ai/ai.views.js";
import { startSse } from "../ai/index.js";
import type { QaService } from "./qa.service.js";

/** QA business namespace. The URL fixes purpose=qa; executors are never injected dynamically. */
export async function qaRoutes(app: FastifyInstance, qa: QaService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["qa"],
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
  typed.get(
    "/qa/capabilities",
    {
      schema: {
        ...common,
        operationId: "getQaCapabilities",
        response: { ...common.response, 200: qaCapabilitiesSchema },
      },
    },
    (request) => {
      requirePrincipal(request.principal);
      return qa.capabilities();
    },
  );
  typed.get(
    "/qa/conversations",
    {
      schema: {
        ...common,
        operationId: "listQaConversations",
        response: { ...common.response, 200: z.array(conversationViewSchema) },
      },
    },
    (request) =>
      qa
        .listConversations({ kind: "internal", principal: requirePrincipal(request.principal) })
        .then((rows) =>
          rows.map((row) => ({
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
          })),
        ),
  );
  typed.post(
    "/qa/conversations",
    {
      bodyLimit: 32768,
      schema: {
        ...common,
        operationId: "createQaConversation",
        body: z
          .strictObject({
            scope: scopeSelectionSchema.optional(),
            creationKey: z.string().min(1).max(160).optional(),
          })
          .optional(),
        response: { ...common.response, 201: conversationViewSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const conversation = await qa.createConversation(
        { kind: "internal", principal },
        { scope: request.body?.scope, creationKey: request.body?.creationKey },
      );
      const snapshot = await qa.snapshot({ kind: "internal", principal }, conversation.id, {
        limit: 1,
      });
      return reply.code(201).send(snapshot.conversation);
    },
  );
  typed.get(
    "/qa/conversations/:id",
    {
      schema: {
        ...common,
        operationId: "getQaConversation",
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
      qa.snapshot(
        { kind: "internal", principal: requirePrincipal(request.principal) },
        request.params.id,
        request.query ?? undefined,
      ),
  );
  typed.post(
    "/qa/conversations/:id/messages",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "submitQaMessage",
        params: conversationIdParamsSchema,
        body: qaSubmitBodySchema,
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
      const principal = requirePrincipal(request.principal);
      const result = await qa.submitMessage(
        { kind: "internal", principal },
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
    "/qa/conversations/:id/scope",
    {
      schema: {
        ...common,
        operationId: "updateQaScope",
        params: conversationIdParamsSchema,
        body: scopeBodySchema,
        response: {
          ...common.response,
          200: z.strictObject({
            contextRevision: z.number().int(),
            scope: scopeSelectionSchema,
            cancelledRunIds: z.array(z.string()),
          }),
        },
      },
    },
    (request) =>
      qa.setScope(
        { kind: "internal", principal: requirePrincipal(request.principal) },
        request.params.id,
        request.body.expectedContextRevision,
        request.body.scope,
      ),
  );
  typed.get(
    "/qa/conversations/:id/events",
    {
      schema: {
        ...common,
        operationId: "observeQaConversation",
        params: conversationIdParamsSchema,
        querystring: z.strictObject({ cursor: z.string().regex(/^(0|[1-9][0-9]*)$/) }),
        response: { ...common.response, 200: aiEventViewSchema },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request.principal);
      const sse = startSse(reply);
      const controller = new AbortController();
      request.raw.once("close", () => controller.abort());
      try {
        await qa.streamEvents(
          { kind: "internal", principal },
          request.params.id,
          request.query.cursor,
          sse,
          controller.signal,
        );
      } catch {
        sse.close();
      }
    },
  );
  typed.post(
    "/qa/conversations/:id/runs/:runId/cancel",
    {
      schema: {
        ...common,
        operationId: "cancelQaRun",
        params: runParamsSchema,
        response: { ...common.response, 200: runViewSchema },
      },
    },
    (request) =>
      qa.cancelRun(
        { kind: "internal", principal: requirePrincipal(request.principal) },
        request.params.id,
        request.params.runId,
      ),
  );
  typed.post(
    "/qa/conversations/:id/runs/:runId/retry",
    {
      schema: {
        ...common,
        operationId: "retryQaRun",
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
    async (request, reply) => {
      const result = await qa.retryRun(
        { kind: "internal", principal: requirePrincipal(request.principal) },
        request.params.id,
        request.params.runId,
      );
      return reply.code(202).send(result);
    },
  );
  typed.get(
    "/qa/artifacts/:artifactId",
    {
      schema: {
        ...common,
        operationId: "getQaArtifact",
        params: artifactIdParamsSchema,
        querystring: z.strictObject({ conversationId: z.string().regex(/^ai_[a-f0-9]{32}$/) }),
        // Artifact payloads vary by kind; responses pass through without field filtering.
        response: { ...common.response, 200: z.record(z.string(), z.unknown()) },
      },
    },
    (request) =>
      qa.readArtifact(
        { kind: "internal", principal: requirePrincipal(request.principal) },
        request.query.conversationId,
        request.params.artifactId,
      ),
  );
  typed.post(
    "/qa/conversations/:id/messages/:messageId/create-writing",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "createWritingFromQaMessage",
        params: messageIdParamsSchema,
        body: z.strictObject({
          instruction: z.string().min(1).max(8_000),
          intent: z
            .enum(["auto", "create", "continue", "rewrite", "summarize", "translate", "research"])
            .optional(),
          targetDocumentId: z.string().max(160).nullable().optional(),
          creationKey: z.string().min(1).max(160),
        }),
        response: {
          ...common.response,
          201: z.strictObject({
            conversationId: z.string(),
            runId: z.string(),
            replayed: z.boolean(),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await qa.createWritingSession(
        { kind: "internal", principal: requirePrincipal(request.principal) },
        request.params.id,
        request.params.messageId,
        request.body,
        qa.handoffPort,
      );
      return reply.code(201).send(result);
    },
  );
}

const qaCapabilitiesSchema = z.strictObject({
  enabled: z.boolean(),
  reason: z.string().optional(),
  retrieval: z.strictObject({
    contextTokenBudget: z.number().int(),
    maxEvidenceItems: z.number().int(),
    maxRepairRounds: z.number().int(),
    scopeLimits: z.strictObject({
      maxWorkspaces: z.number().int(),
      maxDocuments: z.number().int(),
      maxAllDocuments: z.number().int(),
    }),
  }),
  webSearch: z.literal(false),
  handoff: z.literal(true),
});
