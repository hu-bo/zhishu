import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { workspaceParamsSchema, workspaceIdSchema } from "../../shared/resource.schema.js";
import { InvitationService } from "./invitation.service.js";

const role = z.enum(["editor", "viewer"]);
const invitation = z
  .object({
    id: z.string().uuid(),
    workspaceId: workspaceIdSchema,
    role,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    acceptedAt: z.string().datetime().nullable(),
  })
  .strict();
const tokenBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export async function invitationsModule(app: FastifyInstance) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = new InvitationService(app.db);
  const common = {
    tags: ["invitations"],
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
    "/knowledge/workspaces/:workspaceId/invitations",
    {
      schema: {
        ...common,
        operationId: "listWorkspaceInvitations",
        params: workspaceParamsSchema,
        response: { ...common.response, 200: z.array(invitation) },
      },
    },
    (r) => service.list(r.principal!, r.params.workspaceId),
  );
  typed.post(
    "/knowledge/workspaces/:workspaceId/invitations",
    {
      schema: {
        ...common,
        operationId: "createWorkspaceInvitation",
        params: workspaceParamsSchema,
        body: z.object({ role: role.default("viewer") }).strict(),
        response: { ...common.response, 201: invitation.extend({ token: z.string() }).strict() },
      },
    },
    async (r, reply) =>
      reply.code(201).send(await service.create(r.principal!, r.params.workspaceId, r.body.role)),
  );
  typed.delete(
    "/knowledge/workspaces/:workspaceId/invitations/:invitationId",
    {
      schema: {
        ...common,
        operationId: "revokeWorkspaceInvitation",
        params: workspaceParamsSchema.extend({ invitationId: z.string().uuid() }).strict(),
        response: { ...common.response, 204: z.null() },
      },
    },
    async (r, reply) => {
      await service.revoke(r.principal!, r.params.workspaceId, r.params.invitationId);
      return reply.code(204).send(null);
    },
  );
  // Tokens stay in the request body, outside URLs and request logs.
  typed.post(
    "/invitations/inspect",
    {
      schema: {
        ...common,
        operationId: "inspectWorkspaceInvitation",
        body: tokenBody,
        response: {
          ...common.response,
          200: z
            .object({
              workspaceId: workspaceIdSchema,
              workspaceName: z.string(),
              role,
              accepted: z.boolean(),
            })
            .strict(),
        },
      },
    },
    (r) => service.inspect(r.principal!, r.body.token),
  );
  typed.post(
    "/invitations/accept",
    {
      schema: {
        ...common,
        operationId: "acceptWorkspaceInvitation",
        body: tokenBody,
        response: {
          ...common.response,
          200: z.object({ workspaceId: workspaceIdSchema }).strict(),
        },
      },
    },
    (r) => service.accept(r.principal!, r.body.token),
  );
}
