import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../../shared/domain-error.js";
import {
  catalogChildrenSchema,
  catalogDeletionImpactSchema,
  catalogParamsSchema,
  catalogSchema,
  catalogWorkspaceParamsSchema,
  createCatalogBodySchema,
  documentLocateSchema,
  moveCatalogBodySchema,
  updateCatalogBodySchema,
} from "./catalog.schema.js";
import type { CatalogService } from "./catalog.service.js";
import { documentParamsSchema, errorResponseSchema } from "./document.schema.js";

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

export async function catalogRoutes(app: FastifyInstance, service: CatalogService): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["knowledge"],
    security: bearerSecurity,
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
    },
  };
  typed.post(
    "/workspaces/:workspaceId/catalogs",
    {
      schema: {
        ...common,
        operationId: "createCatalog",
        params: z.object({ workspaceId: catalogWorkspaceParamsSchema.shape.workspaceId }).strict(),
        headers: idempotencyKeyHeadersSchema,
        body: createCatalogBodySchema,
        response: { ...common.response, 201: catalogSchema },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      const catalog = await service.create(
        request.principal,
        request.params.workspaceId,
        request.body,
        request.headers["idempotency-key"],
      );
      return reply.code(201).send(catalog);
    },
  );
  typed.get(
    "/workspaces/:workspaceId/catalogs/:catalogId/children",
    {
      schema: {
        ...common,
        operationId: "listCatalogChildren",
        params: catalogWorkspaceParamsSchema,
        response: { ...common.response, 200: catalogChildrenSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.listChildren(
        request.principal,
        request.params.workspaceId,
        request.params.catalogId,
      );
    },
  );
  typed.patch(
    "/catalogs/:catalogId",
    {
      schema: {
        ...common,
        operationId: "updateCatalog",
        params: catalogParamsSchema,
        body: updateCatalogBodySchema,
        response: { ...common.response, 200: catalogSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.update(request.principal, request.params.catalogId, request.body);
    },
  );
  typed.patch(
    "/catalogs/:catalogId/location",
    {
      schema: {
        ...common,
        operationId: "moveCatalog",
        params: catalogParamsSchema,
        body: moveCatalogBodySchema,
        response: { ...common.response, 200: catalogSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.move(request.principal, request.params.catalogId, request.body);
    },
  );
  typed.get(
    "/catalogs/:catalogId/deletion-impact",
    {
      schema: {
        ...common,
        operationId: "getCatalogDeletionImpact",
        params: catalogParamsSchema,
        response: { ...common.response, 200: catalogDeletionImpactSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.deletionImpact(request.principal, request.params.catalogId);
    },
  );
  typed.delete(
    "/catalogs/:catalogId",
    {
      schema: {
        ...common,
        operationId: "deleteCatalog",
        params: catalogParamsSchema,
        response: { ...common.response, 204: z.null() },
      },
    },
    async (request, reply) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      await service.delete(request.principal, request.params.catalogId);
      return reply.code(204).send(null);
    },
  );
  typed.get(
    "/documents/:documentId/locate",
    {
      schema: {
        ...common,
        operationId: "locateDocument",
        params: documentParamsSchema,
        response: { ...common.response, 200: documentLocateSchema },
      },
    },
    async (request) => {
      if (!request.principal)
        throw new DomainError("UNAUTHENTICATED", "Authentication is required");
      return service.locate(request.principal, request.params.documentId);
    },
  );
}
