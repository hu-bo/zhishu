import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { documentParamsSchema, errorResponseSchema } from "./document.schema.js";
import { documentAccessModes } from "../authorization/permissions.js";
import type { DocumentCommunityService } from "./document-community.service.js";
export async function documentCommunityRoutes(
  app: FastifyInstance,
  service: DocumentCommunityService,
) {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["documents"],
    security: [{ bearerAuth: [] }],
    response: {
      400: errorResponseSchema,
      401: errorResponseSchema,
      404: errorResponseSchema,
      409: errorResponseSchema,
    },
  };
  typed.patch(
    "/:documentId/access",
    {
      schema: {
        ...common,
        operationId: "setDocumentAccessMode",
        params: documentParamsSchema,
        body: z
          .object({
            accessMode: z.enum(documentAccessModes),
            metadataRevision: z.number().int().positive(),
          })
          .strict(),
        response: {
          ...common.response,
          200: z
            .object({
              accessMode: z.enum(documentAccessModes),
              metadataRevision: z.number().int().positive(),
            })
            .strict(),
        },
      },
    },
    (r) => service.setAccess(r.principal!, r.params.documentId, r.body),
  );
  typed.get(
    "/:documentId/comments",
    {
      schema: {
        ...common,
        operationId: "listDocumentComments",
        params: documentParamsSchema,
        querystring: z
          .object({ offset: z.coerce.number().int().min(0).max(10000).default(0) })
          .strict(),
        response: {
          ...common.response,
          200: z
            .object({
              items: z.array(
                z
                  .object({
                    id: z.string().uuid(),
                    authorId: z.string(),
                    authorName: z.string(),
                    body: z.string(),
                    mentionIds: z.array(z.string()),
                    createdAt: z.string().datetime(),
                    canDelete: z.boolean(),
                  })
                  .strict(),
              ),
              hasMore: z.boolean(),
              canComment: z.boolean(),
            })
            .strict(),
        },
      },
    },
    (r) => service.listComments(r.principal!, r.params.documentId, r.query.offset),
  );
  typed.post(
    "/:documentId/comments",
    {
      schema: {
        ...common,
        operationId: "createDocumentComment",
        params: documentParamsSchema,
        body: z
          .object({
            id: z.string().uuid(),
            body: z.string().trim().min(1).max(5000),
            mentionIds: z
              .array(z.string().min(1).max(256))
              .max(10)
              .default([])
              .refine((ids) => new Set(ids).size === ids.length, "提及成员不能重复"),
          })
          .strict(),
        response: { ...common.response, 201: z.object({ id: z.string().uuid() }).strict() },
      },
    },
    async (r, reply) =>
      reply.code(201).send(await service.createComment(r.principal!, r.params.documentId, r.body)),
  );
  typed.delete(
    "/:documentId/comments/:commentId",
    {
      schema: {
        ...common,
        operationId: "deleteDocumentComment",
        params: documentParamsSchema.extend({ commentId: z.string().uuid() }).strict(),
        response: { ...common.response, 204: z.null() },
      },
    },
    async (r, reply) => {
      await service.deleteComment(r.principal!, r.params.documentId, r.params.commentId);
      return reply.code(204).send(null);
    },
  );
}
