import { requirePrincipal } from "./principal.js";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { and, eq } from "drizzle-orm";
import { identityProfiles, resourceAcl, workspaces } from "../../../database/schema/index.js";
import type { MockIdentityService } from "./identity.service.js";
import { getMockUser, mockUsers } from "./mock-user.js";
import type { MockPrincipal } from "./mock-user.js";
import { rememberIdentities, searchIdentities } from "./identity-directory.js";
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
  const [known] = await app.db
    .select({ identityId: identityProfiles.identityId })
    .from(identityProfiles)
    .where(
      and(
        eq(identityProfiles.tenantId, user.tenantId),
        eq(identityProfiles.identityId, user.identityId),
      ),
    )
    .limit(1);
  if (known) return;
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
    .insert(resourceAcl)
    .values({
      tenantId: user.tenantId,
      workspaceId: "ws_default",
      identityId: user.identityId,
      createdBy: user.identityId,
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
  typed.get(
    "/directory",
    {
      schema: {
        operationId: "searchIdentityDirectory",
        tags: ["identity"],
        security: bearerSecurity,
        querystring: z
          .object({
            q: z.string().trim().max(100).default(""),
            documentId: z
              .string()
              .regex(/^doc_[A-Za-z0-9_-]{1,64}$/)
              .optional(),
          })
          .strict(),
        response: {
          200: z.array(
            z
              .object({ identityId: z.string(), displayName: z.string(), email: z.string() })
              .strict(),
          ),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      searchIdentities(
        app.db,
        requirePrincipal(request.principal),
        request.query.q,
        request.query.documentId,
      ),
  );
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
        for (const mock of mockUsers) await ensureMockMembership(app, mock);
        await rememberIdentities(app.db, mockUsers);
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
    async (request) => requirePrincipal(request.principal),
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
