import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import {
  aiCapabilitiesSchema,
  aiDocumentContextSchema,
  aiDocumentParamsSchema,
  aiParamsSchema,
  aiTaskSchema,
  authoringBodySchema,
  chatBodySchema,
  reviewBodySchema,
} from "./ai.schema.js";
import type { AiService } from "./ai.service.js";
import { requireAiPrincipal, streamAiTask } from "./ai.controller.js";
export async function aiRoutes(app: FastifyInstance, service: AiService) {
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
  typed.get(
    "/capabilities",
    {
      schema: {
        ...common,
        operationId: "getAiCapabilities",
        response: { ...common.response, 200: aiCapabilitiesSchema },
      },
    },
    async (request) => {
      requireAiPrincipal(request);
      return service.capabilities();
    },
  );
  typed.get(
    "/documents/:documentId/context",
    {
      schema: {
        ...common,
        operationId: "getAiDocumentContext",
        params: aiDocumentParamsSchema,
        response: { ...common.response, 200: aiDocumentContextSchema },
      },
    },
    (request) => service.context(requireAiPrincipal(request), request.params.documentId),
  );
  typed.post(
    "/authoring",
    {
      bodyLimit: 131072,
      schema: {
        ...common,
        operationId: "startAiAuthoring",
        body: authoringBodySchema,
        response: { ...common.response, 200: aiTaskSchema },
      },
    },
    (request, reply) => streamAiTask(request, reply, service, request.body),
  );
  typed.post(
    "/chat",
    {
      bodyLimit: 65536,
      schema: {
        ...common,
        operationId: "startAiChat",
        body: chatBodySchema,
        response: { ...common.response, 200: aiTaskSchema },
      },
    },
    (request, reply) => streamAiTask(request, reply, service, request.body),
  );
  typed.get(
    "/requests/:requestId",
    {
      schema: {
        ...common,
        operationId: "getAiTask",
        params: aiParamsSchema,
        response: { ...common.response, 200: aiTaskSchema },
      },
    },
    (request) => service.get(requireAiPrincipal(request), request.params.requestId),
  );
  typed.post(
    "/requests/:requestId/accept",
    {
      schema: {
        ...common,
        operationId: "acceptAiProposal",
        params: aiParamsSchema,
        response: { ...common.response, 200: aiTaskSchema },
      },
    },
    (request) => service.accept(requireAiPrincipal(request), request.params.requestId),
  );
  typed.post(
    "/requests/:requestId/cancel",
    {
      schema: {
        ...common,
        operationId: "cancelAiTask",
        params: aiParamsSchema,
        response: { ...common.response, 200: aiTaskSchema },
      },
    },
    (request) => service.cancel(requireAiPrincipal(request), request.params.requestId),
  );
  typed.post(
    "/requests/:requestId/review",
    {
      schema: {
        ...common,
        operationId: "reviewAiProposal",
        params: aiParamsSchema,
        body: reviewBodySchema,
        response: { ...common.response, 200: aiTaskSchema },
      },
    },
    (request) =>
      service.review(requireAiPrincipal(request), request.params.requestId, request.body),
  );
  typed.post(
    "/requests/:requestId/resume",
    {
      schema: {
        ...common,
        operationId: "resumeAiTask",
        params: aiParamsSchema,
        response: { ...common.response, 202: aiTaskSchema },
      },
    },
    async (request, reply) =>
      reply
        .code(202)
        .send(await service.resume(requireAiPrincipal(request), request.params.requestId)),
  );
}
