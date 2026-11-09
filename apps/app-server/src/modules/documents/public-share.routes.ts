import { requirePrincipal } from "../identity/principal.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { assetAccessSchema } from "../assets/asset.schema.js";
import { documentContentSchema, errorResponseSchema } from "./document.schema.js";
import type { ShareService } from "./share.service.js";
import {
  publicShareDetailSchema,
  shareAssetParamsSchema,
  shareJoinResultSchema,
  shareParamsSchema,
} from "./share.schema.js";

// Public share endpoints are capability-URL based: no identity, no security scheme.
// The share id itself is the secret, so these routes opt out of the identity guard.
const publicSchema = { tags: ["public"] };
const publicConfig = { auth: false } as const;

export async function publicShareRoutes(
  app: FastifyInstance,
  service: ShareService,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/public/shares/:shareId",
    {
      config: publicConfig,
      schema: {
        ...publicSchema,
        operationId: "getPublicShare",
        params: shareParamsSchema,
        response: {
          400: errorResponseSchema,
          // Invalid states are reported in the body (state field), never as HTTP errors,
          // so the reader page can render expiry/revocation without error handling.
          200: publicShareDetailSchema,
        },
      },
    },
    async (request) => service.publicDetail(request.params.shareId),
  );
  typed.get(
    "/public/shares/:shareId/content",
    {
      config: publicConfig,
      schema: {
        ...publicSchema,
        operationId: "getPublicShareContent",
        params: shareParamsSchema,
        response: {
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          200: documentContentSchema,
        },
      },
    },
    async (request) => service.publicContent(request.params.shareId),
  );
  typed.get(
    "/public/shares/:shareId/assets/:assetId/access",
    {
      config: publicConfig,
      schema: {
        ...publicSchema,
        operationId: "getPublicShareAssetAccess",
        params: shareAssetParamsSchema,
        response: {
          400: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
          200: assetAccessSchema,
        },
      },
    },
    async (request) => service.publicAssetAccess(request.params.shareId, request.params.assetId),
  );
  typed.post(
    "/shares/:shareId/join",
    {
      schema: {
        tags: ["public"],
        security: [{ bearerAuth: [] }],
        operationId: "joinShare",
        params: shareParamsSchema,
        response: {
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          200: shareJoinResultSchema,
        },
      },
    },
    async (request) => service.join(requirePrincipal(request.principal), request.params.shareId),
  );
}
