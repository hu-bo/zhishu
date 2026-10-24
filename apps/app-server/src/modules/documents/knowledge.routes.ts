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
  updateWorkspaceSchema,
  workspaceMemberParamsSchema,
  workspaceMemberListSchema,
  workspaceMemberSchema,
  setWorkspaceMemberSchema,
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
        headers: z
          .object({ "idempotency-key": z.string().min(1).max(200).optional() })
          .passthrough(),
        body: createWorkspaceSchema,
        response: { ...common.response, 201: workspaceSchema },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return reply
        .code(201)
        .send(
          await service.createWorkspace(
            request.principal,
            request.body,
            request.headers["idempotency-key"],
          ),
        );
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
    "/workspaces/:workspaceId",
    {
      schema: {
        ...common,
        operationId: "updateKnowledgeWorkspace",
        params: workspaceParamsSchema,
        body: updateWorkspaceSchema,
        response: { ...common.response, 200: workspaceSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.updateWorkspace(request.principal, request.params.workspaceId, request.body);
    },
  );
  typed.get(
    "/workspaces/:workspaceId/members",
    {
      schema: {
        ...common,
        operationId: "listWorkspaceMembers",
        params: workspaceParamsSchema,
        response: { ...common.response, 200: workspaceMemberListSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.listMembers(request.principal, request.params.workspaceId);
    },
  );
  typed.put(
    "/workspaces/:workspaceId/members/:identityId",
    {
      schema: {
        ...common,
        operationId: "setWorkspaceMember",
        params: workspaceMemberParamsSchema,
        body: setWorkspaceMemberSchema,
        response: { ...common.response, 200: workspaceMemberSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.setMember(
        request.principal,
        request.params.workspaceId,
        request.params.identityId,
        request.body,
      );
    },
  );
  typed.delete(
    "/workspaces/:workspaceId/members/:identityId",
    {
      schema: {
        ...common,
        operationId: "removeWorkspaceMember",
        params: workspaceMemberParamsSchema,
        response: { ...common.response, 204: z.null() },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.removeMember(
        request.principal,
        request.params.workspaceId,
        request.params.identityId,
      );
      return reply.code(204).send(null);
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
