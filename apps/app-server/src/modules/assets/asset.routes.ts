import { idempotencyKeyHeadersSchema } from "../../shared/idempotency.schema.js";
import { requirePrincipal } from "../identity/principal.js";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import type { AssetService } from "./asset.service.js";
import {
  assetAccessSchema,
  assetDocumentParamsSchema,
  assetReferenceSchema,
  assetSchema,
  assetUploadParamsSchema,
  assetUploadSchema,
  cancelAssetUploadSchema,
  completeAssetUploadBodySchema,
  createAssetReferenceBodySchema,
  createAssetUploadBodySchema,
  documentAssetParamsSchema,
} from "./asset.schema.js";

const bearerSecurity = [{ bearerAuth: [] }];

export async function assetRoutes(app: FastifyInstance, service: AssetService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    "/documents/:documentId/asset-uploads",
    {
      schema: {
        operationId: "createAssetUpload",
        tags: ["assets"],
        security: bearerSecurity,
        params: assetDocumentParamsSchema,
        headers: idempotencyKeyHeadersSchema,
        body: createAssetUploadBodySchema,
        response: {
          201: assetUploadSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await service.createUpload(
            requirePrincipal(request.principal),
            request.params.documentId,
            request.body,
            request.headers["idempotency-key"],
          ),
        ),
  );
  typed.post(
    "/asset-uploads/:assetId/complete",
    {
      schema: {
        operationId: "completeAssetUpload",
        tags: ["assets"],
        security: bearerSecurity,
        params: assetUploadParamsSchema,
        body: completeAssetUploadBodySchema,
        response: {
          200: assetSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.completeUpload(
        requirePrincipal(request.principal),
        request.params.assetId,
        request.body.sha256,
      ),
  );
  typed.delete(
    "/asset-uploads/:assetId",
    {
      schema: {
        operationId: "cancelAssetUpload",
        tags: ["assets"],
        security: bearerSecurity,
        params: assetUploadParamsSchema,
        response: {
          200: cancelAssetUploadSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.cancelUpload(requirePrincipal(request.principal), request.params.assetId),
  );
  typed.post(
    "/documents/:documentId/assets/:assetId/references",
    {
      schema: {
        operationId: "createAssetReference",
        tags: ["assets"],
        security: bearerSecurity,
        params: documentAssetParamsSchema,
        body: createAssetReferenceBodySchema,
        response: {
          201: assetReferenceSchema,
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
          await service.addReference(
            requirePrincipal(request.principal),
            request.params.documentId,
            request.params.assetId,
            request.body,
          ),
        ),
  );
  typed.get(
    "/assets/:assetId/access",
    {
      schema: {
        operationId: "getAssetAccess",
        tags: ["assets"],
        security: bearerSecurity,
        params: assetUploadParamsSchema,
        response: {
          200: assetAccessSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request) =>
      service.createAccess(requirePrincipal(request.principal), request.params.assetId),
  );
}
