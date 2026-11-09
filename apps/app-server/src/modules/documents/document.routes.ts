import { idempotencyKeyHeadersSchema } from "../../shared/idempotency.schema.js";
import { requirePrincipal } from "../identity/principal.js";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DocumentService } from "./document.service.js";
import {
  collaborationSessionSchema,
  collaborationSessionBodySchema,
  createDocumentBodySchema,
  createDocumentVersionBodySchema,
  documentVersionParamsSchema,
  documentVersionContentSchema,
  documentVersionsSchema,
  documentVersionSchema,
  documentListQuerySchema,
  documentListSchema,
  documentAclParamsSchema,
  documentAclListSchema,
  documentAclSchema,
  documentParamsSchema,
  documentSchema,
  documentContentSchema,
  exportDocumentSchema,
  errorResponseSchema,
  copyDocumentBodySchema,
  importDocumentBodySchema,
  importDocumentResultSchema,
  setDocumentAclBodySchema,
  updateDocumentBodySchema,
  restoreDocumentVersionBodySchema,
} from "./document.schema.js";

const bearerSecurity = [{ bearerAuth: [] }];

export async function documentRoutes(
  app: FastifyInstance,
  service: DocumentService,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/import",
    {
      bodyLimit: 2_200_000,
      schema: {
        operationId: "importDocumentJson",
        tags: ["documents"],
        security: bearerSecurity,
        headers: idempotencyKeyHeadersSchema,
        body: importDocumentBodySchema,
        response: {
          200: importDocumentResultSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          413: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.importJson(
        requirePrincipal(request.principal),
        request.body,
        request.id,
        request.headers["idempotency-key"],
      ),
  );
  typed.get(
    "/",
    {
      schema: {
        operationId: "listDocuments",
        tags: ["documents"],
        security: bearerSecurity,
        querystring: documentListQuerySchema,
        response: { 200: documentListSchema, 401: errorResponseSchema, 400: errorResponseSchema },
      },
    },
    async (request) =>
      service.list(requirePrincipal(request.principal), {
        view: request.query.view,
        q: request.query.q,
        workspaceId: request.query.workspaceId,
        sort: request.query.sort,
        direction: request.query.direction,
        limit: request.query.limit,
        offset: request.query.offset,
      }),
  );
  typed.get(
    "/:documentId",
    {
      schema: {
        operationId: "getDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: { 200: documentSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => service.get(requirePrincipal(request.principal), request.params.documentId),
  );
  typed.get(
    "/:documentId/export",
    {
      schema: {
        operationId: "exportDocumentJson",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: {
          200: exportDocumentSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.exportJson(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.id,
      ),
  );
  typed.get(
    "/:documentId/content",
    {
      schema: {
        operationId: "getDocumentContent",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: {
          200: documentContentSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.getContent(requirePrincipal(request.principal), request.params.documentId),
  );
  typed.get(
    "/:documentId/acl",
    {
      schema: {
        operationId: "listDocumentAcl",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: {
          200: documentAclListSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.listAcl(requirePrincipal(request.principal), request.params.documentId),
  );
  typed.post(
    "/",
    {
      schema: {
        operationId: "createDocument",
        tags: ["documents"],
        security: bearerSecurity,
        headers: idempotencyKeyHeadersSchema,
        body: createDocumentBodySchema,
        response: {
          201: documentSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.create(
            requirePrincipal(request.principal),
            request.body,
            request.id,
            request.headers["idempotency-key"],
          ),
        ),
  );
  typed.get(
    "/:documentId/versions",
    {
      schema: {
        operationId: "listDocumentVersions",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: {
          200: documentVersionsSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.listVersions(requirePrincipal(request.principal), request.params.documentId),
  );
  typed.post(
    "/:documentId/versions",
    {
      schema: {
        operationId: "createDocumentVersion",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        body: createDocumentVersionBodySchema,
        response: {
          201: documentVersionSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createVersion(
            requirePrincipal(request.principal),
            request.params.documentId,
            request.body,
            request.id,
            request.headers["idempotency-key"],
          ),
        ),
  );
  typed.get(
    "/:documentId/versions/:versionId",
    {
      schema: {
        operationId: "getDocumentVersion",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentVersionParamsSchema,
        response: {
          200: documentVersionSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.getVersion(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.params.versionId,
      ),
  );
  typed.get(
    "/:documentId/versions/:versionId/content",
    {
      schema: {
        operationId: "getDocumentVersionContent",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentVersionParamsSchema,
        response: {
          200: documentVersionContentSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.getVersionContent(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.params.versionId,
      ),
  );
  typed.post(
    "/:documentId/versions/:versionId/restore",
    {
      schema: {
        operationId: "restoreDocumentVersion",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentVersionParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        body: restoreDocumentVersionBodySchema,
        response: {
          200: documentSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.restoreVersion(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.params.versionId,
        request.body,
        request.id,
        request.headers["idempotency-key"],
      ),
  );
  typed.post(
    "/:documentId/copy",
    {
      schema: {
        operationId: "copyDocumentTemplate",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        body: copyDocumentBodySchema,
        response: {
          201: documentSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.copyTemplate(
            requirePrincipal(request.principal),
            request.params.documentId,
            request.body,
            request.id,
            request.headers["idempotency-key"],
          ),
        ),
  );
  typed.patch(
    "/:documentId",
    {
      schema: {
        operationId: "updateDocumentMetadata",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        body: updateDocumentBodySchema,
        response: {
          200: documentSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.updateTitle(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.body,
        request.id,
        request.headers["idempotency-key"],
      ),
  );
  typed.put(
    "/:documentId/favorite",
    {
      schema: {
        operationId: "favoriteDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.setFavorite(
        requirePrincipal(request.principal),
        request.params.documentId,
        true,
      );
      return reply.code(204).send(null);
    },
  );
  typed.delete(
    "/:documentId/favorite",
    {
      schema: {
        operationId: "unfavoriteDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await service.setFavorite(
        requirePrincipal(request.principal),
        request.params.documentId,
        false,
      );
      return reply.code(204).send(null);
    },
  );
  typed.put(
    "/:documentId/archive",
    {
      schema: {
        operationId: "archiveDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        response: {
          204: z.null(),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.lifecycle(
        requirePrincipal(request.principal),
        request.params.documentId,
        "archive",
        request.id,
        request.headers["idempotency-key"],
      );
      return reply.code(204).send(null);
    },
  );
  typed.put(
    "/:documentId/restore",
    {
      schema: {
        operationId: "restoreDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        response: {
          204: z.null(),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.lifecycle(
        requirePrincipal(request.principal),
        request.params.documentId,
        "restore",
        request.id,
        request.headers["idempotency-key"],
      );
      return reply.code(204).send(null);
    },
  );
  typed.delete(
    "/:documentId/permanent",
    {
      schema: {
        operationId: "permanentlyDeleteDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        response: {
          204: z.null(),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.lifecycle(
        requirePrincipal(request.principal),
        request.params.documentId,
        "purge",
        request.id,
        request.headers["idempotency-key"],
      );
      return reply.code(204).send(null);
    },
  );
  typed.delete(
    "/:documentId",
    {
      schema: {
        operationId: "trashDocument",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        response: {
          204: z.null(),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.lifecycle(
        requirePrincipal(request.principal),
        request.params.documentId,
        "trash",
        request.id,
        request.headers["idempotency-key"],
      );
      return reply.code(204).send(null);
    },
  );
  typed.put(
    "/:documentId/acl/:identityId",
    {
      schema: {
        operationId: "setDocumentAcl",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentAclParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        body: setDocumentAclBodySchema,
        response: {
          200: documentAclSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.setAcl(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.params.identityId,
        "actions" in request.body ? request.body.actions : [],
        request.id,
        request.headers["idempotency-key"],
        "role" in request.body ? request.body.role : undefined,
      ),
  );
  typed.delete(
    "/:documentId/acl/:identityId",
    {
      schema: {
        operationId: "removeDocumentAcl",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentAclParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        response: {
          204: z.null(),
          401: errorResponseSchema,
          409: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await service.removeAcl(
        requirePrincipal(request.principal),
        request.params.documentId,
        request.params.identityId,
        request.id,
        request.headers["idempotency-key"],
      );
      return reply.code(204).send(null);
    },
  );
  typed.post(
    "/:documentId/collaboration-session",
    {
      schema: {
        operationId: "createCollaborationSession",
        tags: ["collaboration"],
        security: bearerSecurity,
        params: documentParamsSchema,
        body: collaborationSessionBodySchema,
        response: {
          201: collaborationSessionSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          409: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createCollaborationSession(
            requirePrincipal(request.principal),
            request.params.documentId,
            request.body,
          ),
        ),
  );
}
