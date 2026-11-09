import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { CollaborationSessionRevoker } from "../collaboration/session-revoker.js";
import { workspaceIdSchema } from "../../shared/resource.schema.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { AuthorizationService } from "./authorization.service.js";
import { GovernanceService } from "./governance.service.js";
import { accessRoles, permissionActions, resourceTypes } from "./policy.js";

export { catalogActionSql, spaceActionSql, loadPolicyOverrides } from "./access.js";
export { policyEnforcer, effectiveActions, defaultActions, accessRoles } from "./policy.js";
export type { AccessRole, PermissionAction } from "./policy.js";

export async function authorizationModule(
  app: FastifyInstance,
  revoker: CollaborationSessionRevoker,
) {
  const service = new AuthorizationService(app.db, revoker);
  const governance = new GovernanceService(app.db);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["authorization"],
    security: [{ bearerAuth: [] }],
    response: { 400: errorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
  };
  const params = z.object({ workspaceId: workspaceIdSchema }).strict();
  const mutationResponse = { ...common.response, 409: errorResponseSchema };
  const revision = z.number().int().positive();
  const documentParams = z
    .object({ documentId: z.string().regex(/^doc_[A-Za-z0-9_-]{1,64}$/) })
    .strict();
  typed.get(
    "/knowledge/authorization-state",
    {
      schema: {
        ...common,
        operationId: "getAuthorizationState",
        response: {
          ...common.response,
          200: z.array(
            z
              .object({
                workspaceId: workspaceIdSchema,
                revision,
                offlineCacheAllowed: z.boolean(),
                expiryRevision: z.string(),
                nextExpiryAt: z.string().nullable(),
              })
              .strict(),
          ),
        },
      },
    },
    (r) => governance.state(r.principal!),
  );
  typed.get(
    "/knowledge/workspaces/:workspaceId/authorization-audit",
    {
      schema: {
        ...common,
        operationId: "getWorkspaceAuthorizationAudit",
        params,
        querystring: z.object({ before: z.coerce.number().int().positive().optional() }).strict(),
        response: {
          ...common.response,
          200: z
            .object({
              items: z.array(
                z
                  .object({
                    id: z.number(),
                    tenantId: z.string(),
                    workspaceId: z.string(),
                    documentId: z.string().nullable(),
                    actorId: z.string().nullable(),
                    operation: z.string(),
                    before: z.record(z.unknown()).nullable(),
                    after: z.record(z.unknown()).nullable(),
                    createdAt: z.string().datetime(),
                  })
                  .strict(),
              ),
              hasMore: z.boolean(),
            })
            .strict(),
        },
      },
    },
    (r) => governance.audit(r.principal!, r.params.workspaceId, r.query.before),
  );
  typed.put(
    "/knowledge/workspaces/:workspaceId/security",
    {
      schema: {
        ...common,
        operationId: "setWorkspaceSecurity",
        params,
        body: z.object({ revision, offlineCacheAllowed: z.boolean() }).strict(),
        response: { ...mutationResponse, 200: z.object({ revision }).strict() },
      },
    },
    (r) => governance.configure(r.principal!, r.params.workspaceId, r.body),
  );
  typed.post(
    "/knowledge/workspaces/:workspaceId/ownership",
    {
      schema: {
        ...common,
        operationId: "transferWorkspaceOwnership",
        params,
        body: z.object({ identityId: z.string().trim().min(1).max(256), revision }).strict(),
        response: { ...mutationResponse, 200: z.object({ ownerIdentityId: z.string() }).strict() },
      },
    },
    (r) => governance.transfer(r.principal!, r.params.workspaceId, r.body),
  );
  typed.post(
    "/documents/:documentId/governance-recovery",
    {
      schema: {
        ...common,
        operationId: "recoverDocumentGovernance",
        params: documentParams,
        body: z.object({ reason: z.string().trim().min(8).max(500) }).strict(),
        response: { ...mutationResponse, 200: documentParams },
      },
    },
    (r) => governance.recover(r.principal!, r.params.documentId, r.body.reason),
  );
  typed.get(
    "/documents/:documentId/authorization",
    {
      schema: {
        ...common,
        operationId: "explainDocumentAuthorization",
        params: documentParams,
        response: {
          ...common.response,
          200: z
            .object({
              roles: z.array(z.string()),
              actions: z.array(z.enum(permissionActions)),
              directGrants: z.array(
                z
                  .object({
                    role: z.string(),
                    sourceShareId: z.string().nullable(),
                    createdBy: z.string(),
                    kind: z.enum(["invite", "access"]).nullable(),
                    active: z.boolean(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        },
      },
    },
    (r) => governance.explain(r.principal!, r.params.documentId),
  );
  typed.get(
    "/knowledge/workspaces/:workspaceId/permissions",
    {
      schema: {
        ...common,
        operationId: "getWorkspacePermissions",
        params,
        response: {
          ...common.response,
          200: z
            .object({
              canConfigure: z.boolean(),
              actions: z.array(
                z
                  .object({
                    resourceType: z.enum(resourceTypes),
                    items: z.array(
                      z.object({ action: z.enum(permissionActions), label: z.string() }).strict(),
                    ),
                  })
                  .strict(),
              ),
              policies: z.array(
                z
                  .object({
                    resourceType: z.enum(resourceTypes),
                    role: z.enum(accessRoles),
                    actions: z.array(z.enum(permissionActions)),
                    overridden: z.boolean(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        },
      },
    },
    (request) => service.list(request.principal!, request.params.workspaceId),
  );
  typed.put(
    "/knowledge/workspaces/:workspaceId/permissions/:resourceType/:role",
    {
      schema: {
        ...common,
        operationId: "setWorkspaceRolePermissions",
        params: params
          .extend({ resourceType: z.enum(resourceTypes), role: z.enum(accessRoles) })
          .strict(),
        body: z
          .object({
            actions: z
              .array(z.enum(permissionActions))
              .max(permissionActions.length)
              .refine((a) => new Set(a).size === a.length, "权限点不能重复"),
          })
          .strict(),
        response: { ...common.response, 204: z.null() },
      },
    },
    async (request, reply) => {
      await service.set(
        request.principal!,
        request.params.workspaceId,
        request.params.resourceType,
        request.params.role,
        request.body.actions,
      );
      return reply.code(204).send(null);
    },
  );
}
