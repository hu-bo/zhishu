import { requirePrincipal } from "../identity/principal.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { documentParamsSchema } from "../../shared/resource.schema.js";
import { errorResponseSchema } from "../../shared/error.schema.js";
import {
  knowledgeMoveSchema,
  knowledgeSearchQuerySchema,
  knowledgeSearchResultSchema,
  presetInitializationSchema,
} from "./knowledge.schema.js";
import { workspaceParamsSchema } from "../../shared/resource.schema.js";
import type { KnowledgeService } from "./knowledge.service.js";

export async function knowledgeRoutes(app: FastifyInstance, service: KnowledgeService) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["knowledge"],
    security: [{ bearerAuth: [] }],
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
      429: errorResponseSchema,
    },
  };
  typed.post(
    "/transfer-preview",
    {
      schema: {
        ...common,
        operationId: "previewKnowledgeTransfer",
        body: z
          .object({
            kind: z.enum(["document", "catalog"]),
            resourceId: z.string().regex(/^(doc|cat)_[A-Za-z0-9_-]{1,64}$/),
            targetCatalogId: z.string().regex(/^cat_[A-Za-z0-9_-]{1,64}$/),
          })
          .strict(),
        response: {
          ...common.response,
          200: z
            .object({
              token: z.string(),
              crossWorkspace: z.boolean(),
              documentCount: z.number().int(),
              preservedDirectSubjectCount: z.number().int(),
              targetMemberAccess: z.enum(["inherit-as-configured", "explicit-only"]),
              revokePublicLinks: z.boolean(),
            })
            .strict(),
        },
      },
    },
    (r) => service.previewTransfer(r.principal!, r.body),
  );
  typed.post(
    "/workspaces/:workspaceId/presets",
    {
      schema: {
        ...common,
        operationId: "initializeKnowledgePresets",
        params: workspaceParamsSchema,
        response: { ...common.response, 200: presetInitializationSchema },
      },
    },
    async (request) =>
      service.initializePresets(requirePrincipal(request.principal), request.params.workspaceId),
  );
  typed.patch(
    "/documents/:documentId/location",
    {
      schema: {
        ...common,
        operationId: "moveKnowledgeDocument",
        params: documentParamsSchema,
        body: knowledgeMoveSchema,
        response: {
          ...common.response,
          200: z.object({ metadataRevision: z.number().int().positive() }).strict(),
        },
      },
    },
    async (request) =>
      service.move(requirePrincipal(request.principal), request.params.documentId, request.body),
  );
  typed.get(
    "/search",
    {
      schema: {
        ...common,
        operationId: "searchKnowledgeDocuments",
        querystring: knowledgeSearchQuerySchema,
        response: { ...common.response, 200: knowledgeSearchResultSchema },
      },
    },
    async (request) => service.search(requirePrincipal(request.principal), request.query),
  );
}
