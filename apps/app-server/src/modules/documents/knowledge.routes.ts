import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
import { documentParamsSchema, errorResponseSchema } from "./document.schema.js";
import {
  createWorkspaceSchema,
  knowledgeMoveSchema,
  knowledgeSearchQuerySchema,
  knowledgeSearchResultSchema,
  presetInitializationSchema,
  workspaceListSchema,
  workspaceParamsSchema,
  workspaceSchema,
} from "./knowledge.schema.js";
import type { KnowledgeService } from "./knowledge.service.js";

export async function knowledgeRoutes(app: FastifyInstance, service: KnowledgeService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["knowledge"],
    security: [{ bearerAuth: [] }],
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
    },
  };
  typed.get(
    "/workspaces",
    {
      schema: {
        ...common,
        operationId: "listKnowledgeWorkspaces",
        response: { ...common.response, 200: workspaceListSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.listWorkspaces(request.principal);
    },
  );
  typed.post(
    "/workspaces",
    {
      schema: {
        ...common,
        operationId: "createKnowledgeWorkspace",
        body: createWorkspaceSchema,
        response: { ...common.response, 201: workspaceSchema },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return reply.code(201).send(await service.createWorkspace(request.principal, request.body));
    },
  );
  typed.post(
    "/workspaces/:workspaceId/presets",
    {
      schema: {
        ...common,
        operationId: "initializeKnowledgePresets",
        params: workspaceParamsSchema,
        response: { ...common.response, 200: presetInitializationSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.initializePresets(request.principal, request.params.workspaceId);
    },
  );
  typed.patch(
    "/documents/:documentId/location",
    {
      schema: {
        ...common,
        operationId: "moveKnowledgeDocument",
        params: documentParamsSchema,
        body: knowledgeMoveSchema,
        response: {
          ...common.response,
          200: z.object({ metadataRevision: z.number().int().positive() }).strict(),
        },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.move(request.principal, request.params.documentId, request.body);
    },
  );
  typed.get(
    "/search",
    {
      schema: {
        ...common,
        operationId: "searchKnowledgeDocuments",
        querystring: knowledgeSearchQuerySchema,
        response: { ...common.response, 200: knowledgeSearchResultSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.search(request.principal, request.query);
    },
  );
}
