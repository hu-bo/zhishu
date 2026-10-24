import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { workspaceMembers, workspaces } from "../../../database/schema/index.js";
import type { MockIdentityService } from "./identity.service.js";
import { getMockUser, mockUsers } from "./mock-user.js";
import type { MockPrincipal } from "./mock-user.js";
import {
  mockLoginBodySchema,
  mockLoginResponseSchema,
  mockUsersResponseSchema,
  principalSchema,
} from "./identity.schema.js";

const bearerSecurity = [{ bearerAuth: [] }];

// The auto-created shared workspace plus each mock identity's declared role are
// provisioned on login (idempotently) so switching identities yields real,
// observable permission differences during development. Existing member rows are
// never overwritten, so roles the user adjusts manually stay in place.
async function ensureMockMembership(app: FastifyInstance, user: MockPrincipal): Promise<void> {
  const { defaultMemberRole } = user;
  if (!defaultMemberRole) return;
  await app.db
    .insert(workspaces)
    .values({
      tenantId: user.tenantId,
      id: "ws_default",
      name: "团队知识库",
      kind: "team",
      createdBy: "system",
    })
    .onConflictDoNothing();
  await app.db
    .insert(workspaceMembers)
    .values({
      tenantId: user.tenantId,
      workspaceId: "ws_default",
      identityId: user.identityId,
      displayName: user.displayName,
      role: defaultMemberRole,
    })
    .onConflictDoNothing();
}

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
          body: mockLoginBodySchema,
          response: { 200: mockLoginResponseSchema, 404: errorResponseSchema },
        },
      },
      async (request) => {
        const user = getMockUser(request.body?.userId);
        if (!user) throw new DomainError("NOT_FOUND", "Mock user not found");
        await ensureMockMembership(app, user);
        const session = service.createSession(user.identityId);
        return {
          accessToken: session.accessToken,
          tokenType: "Bearer" as const,
          expiresAt: session.expiresAt.toISOString(),
          user: session.user,
        };
      },
    );

    typed.get(
      "/mock/users",
      {
        config: { auth: false },
        schema: {
          operationId: "listMockUsers",
          tags: ["identity"],
          response: { 200: mockUsersResponseSchema },
        },
      },
      async () => ({
        users: mockUsers.map((user) => ({
          identityId: user.identityId,
          username: user.username,
          displayName: user.displayName,
          email: user.email,
          role: user.defaultMemberRole ?? null,
        })),
      }),
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
