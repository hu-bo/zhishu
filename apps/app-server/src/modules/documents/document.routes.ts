import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
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
  putDocumentContentBodySchema,
  restoreDocumentVersionBodySchema,
} from "./document.schema.js";

const bearerSecurity = [{ bearerAuth: [] }];
const idempotencyKeyHeadersSchema = z
  .object({
    "idempotency-key": z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/)
      .optional(),
  })
  .passthrough();

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
          409: errorResponseSchema,
          413: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.importJson(
        request.principal,
        request.body,
        request.id,
        request.headers["idempotency-key"],
      );
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.list(request.principal, {
        view: request.query.view,
        q: request.query.q,
        sort: request.query.sort,
        direction: request.query.direction,
        limit: request.query.limit,
        offset: request.query.offset,
      });
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.get(request.principal, request.params.documentId);
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.exportJson(request.principal, request.params.documentId, request.id);
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.getContent(request.principal, request.params.documentId);
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.listAcl(request.principal, request.params.documentId);
    },
  );
  typed.put(
    "/:documentId/content",
    {
      bodyLimit: 2_200_000,
      schema: {
        operationId: "putDocumentContent",
        tags: ["documents"],
        security: bearerSecurity,
        params: documentParamsSchema,
        body: putDocumentContentBodySchema,
        response: {
          200: documentContentSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.putContent(
        request.principal,
        request.params.documentId,
        request.body,
        request.id,
      );
    },
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
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return reply
        .code(201)
        .send(
          await service.create(
            request.principal,
            request.body,
            request.id,
            request.headers["idempotency-key"],
          ),
        );
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.listVersions(request.principal, request.params.documentId);
    },
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
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return reply
        .code(201)
        .send(
          await service.createVersion(
            request.principal,
            request.params.documentId,
            request.body,
            request.id,
            request.headers["idempotency-key"],
          ),
        );
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.getVersion(
        request.principal,
        request.params.documentId,
        request.params.versionId,
      );
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.getVersionContent(
        request.principal,
        request.params.documentId,
        request.params.versionId,
      );
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.restoreVersion(
        request.principal,
        request.params.documentId,
        request.params.versionId,
        request.body,
        request.id,
        request.headers["idempotency-key"],
      );
    },
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
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return reply
        .code(201)
        .send(
          await service.copyTemplate(
            request.principal,
            request.params.documentId,
            request.body,
            request.id,
            request.headers["idempotency-key"],
          ),
        );
    },
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.updateTitle(
        request.principal,
        request.params.documentId,
        request.body,
        request.id,
        request.headers["idempotency-key"],
      );
    },
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.setFavorite(request.principal, request.params.documentId, true);
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.setFavorite(request.principal, request.params.documentId, false);
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.lifecycle(
        request.principal,
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.lifecycle(
        request.principal,
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.lifecycle(
        request.principal,
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.lifecycle(
        request.principal,
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
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.setAcl(
        request.principal,
        request.params.documentId,
        request.params.identityId,
        request.body.actions,
        request.id,
        request.headers["idempotency-key"],
      );
    },
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
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.removeAcl(
        request.principal,
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
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return reply
        .code(201)
        .send(
          await service.createCollaborationSession(
            request.principal,
            request.params.documentId,
            request.body,
            request.id,
          ),
        );
    },
  );
}
