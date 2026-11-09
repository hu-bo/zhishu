import { requirePrincipal } from "../identity/principal.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import {
  createWorkspaceSchema,
  workspaceListSchema,
  workspaceParamsSchema,
  workspaceSchema,
  updateWorkspaceSchema,
  workspaceMemberParamsSchema,
  workspaceMemberListSchema,
  workspaceMemberSchema,
  setWorkspaceMemberSchema,
} from "./workspace.schema.js";
import type { WorkspaceService } from "./workspace.service.js";

export async function workspaceRoutes(app: FastifyInstance, service: WorkspaceService) {
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
    async (request) => service.listWorkspaces(requirePrincipal(request.principal)),
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
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createWorkspace(
            requirePrincipal(request.principal),
            request.body,
            request.headers["idempotency-key"],
          ),
        ),
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
    async (request) =>
      service.updateWorkspace(
        requirePrincipal(request.principal),
        request.params.workspaceId,
        request.body,
      ),
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
    async (request) =>
      service.listMembers(requirePrincipal(request.principal), request.params.workspaceId),
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
    async (request) =>
      service.setMember(
        requirePrincipal(request.principal),
        request.params.workspaceId,
        request.params.identityId,
        request.body,
      ),
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
      await service.removeMember(
        requirePrincipal(request.principal),
        request.params.workspaceId,
        request.params.identityId,
      );
      return reply.code(204).send(null);
    },
  );
}
