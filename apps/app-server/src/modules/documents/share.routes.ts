import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
import { errorResponseSchema } from "./document.schema.js";
import type { ShareService } from "./share.service.js";
import {
  createShareBodySchema,
  documentShareParamsSchema,
  documentSharesParamsSchema,
  shareListSchema,
  shareSchema,
} from "./share.schema.js";

const bearerSecurity = [{ bearerAuth: [] }];

export async function shareRoutes(app: FastifyInstance, service: ShareService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["documents"],
    security: bearerSecurity,
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  };
  typed.post(
    "/:documentId/shares",
    {
      schema: {
        ...common,
        operationId: "createDocumentShare",
        params: documentSharesParamsSchema,
        body: createShareBodySchema,
        response: { ...common.response, 201: shareSchema },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      const share = await service.create(
        request.principal,
        request.params.documentId,
        request.body,
      );
      return reply.code(201).send(share);
    },
  );
  typed.get(
    "/:documentId/shares",
    {
      schema: {
        ...common,
        operationId: "listDocumentShares",
        params: documentSharesParamsSchema,
        response: { ...common.response, 200: shareListSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.list(request.principal, request.params.documentId);
    },
  );
  typed.delete(
    "/:documentId/shares/:shareId",
    {
      schema: {
        ...common,
        operationId: "revokeDocumentShare",
        params: documentShareParamsSchema,
        response: { ...common.response, 204: z.null() },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.revoke(request.principal, request.params.documentId, request.params.shareId);
      return reply.code(204).send(null);
    },
  );
}
