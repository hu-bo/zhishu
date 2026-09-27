import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import type { MockIdentityService } from "./identity.service.js";
import { mockLoginResponseSchema, principalSchema } from "./identity.schema.js";

const bearerSecurity = [{ bearerAuth: [] }];

export async function identityRoutes(
  app: FastifyInstance,
  options: { service?: MockIdentityService },
): Promise<void> {
  const { service } = options;
  const typed = app.withTypeProvider<ZodTypeProvider>();
  if (service) {
    typed.post(
      "/mock/login",
      {
        config: { auth: false },
        schema: {
          operationId: "mockLogin",
          tags: ["identity"],
          response: { 200: mockLoginResponseSchema },
        },
      },
      async () => {
        const session = service.createSession();
        return {
          accessToken: session.accessToken,
          tokenType: "Bearer" as const,
          expiresAt: session.expiresAt.toISOString(),
          user: session.user,
        };
      },
    );
  }

  typed.get(
    "/me",
    {
      schema: {
        operationId: "getCurrentUser",
        tags: ["identity"],
        security: bearerSecurity,
        response: { 200: principalSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      if (!request.principal) {
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      }
      return request.principal;
    },
  );

  if (service) {
    typed.post(
      "/logout",
      {
        schema: {
          operationId: "mockLogout",
          tags: ["identity"],
          security: bearerSecurity,
          response: { 204: z.null(), 401: errorResponseSchema },
        },
      },
      async (request, reply) => {
        service.revoke(request.headers.authorization);
        return reply.code(204).send(null);
      },
    );
  }
}
