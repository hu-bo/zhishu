import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { NotificationRepository } from "./notification.repository.js";
export { insertNotifications, documentRecipients } from "./notification.repository.js";

const cursorSchema = z
  .string()
  .max(300)
  .refine((value) => {
    try {
      return z
        .object({ at: z.string().datetime(), id: z.string().uuid() })
        .strict()
        .safeParse(JSON.parse(Buffer.from(value, "base64url").toString())).success;
    } catch {
      return false;
    }
  }, "通知分页游标无效");
export async function notificationsModule(app: FastifyInstance) {
  const repository = new NotificationRepository(app.db);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const common = {
    tags: ["notifications"],
    security: [{ bearerAuth: [] }],
    response: { 400: errorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
  };
  typed.get(
    "/notifications",
    {
      schema: {
        ...common,
        operationId: "listNotifications",
        querystring: z
          .object({
            unread: z
              .enum(["true", "false"])
              .default("false")
              .transform((v) => v === "true"),
            before: cursorSchema.optional(),
            limit: z.coerce.number().int().min(1).max(50).default(20),
          })
          .strict(),
        response: {
          ...common.response,
          200: z
            .object({
              items: z.array(
                z
                  .object({
                    id: z.string().uuid(),
                    type: z.enum(["comment", "mention", "permission", "share", "deleted"]),
                    message: z.string(),
                    actorName: z.string(),
                    documentId: z.string().nullable(),
                    documentTitle: z.string().nullable(),
                    workspaceId: z.string().nullable(),
                    available: z.boolean(),
                    createdAt: z.string().datetime(),
                    readAt: z.string().datetime().nullable(),
                  })
                  .strict(),
              ),
              unreadCount: z.number().int().nonnegative(),
              nextCursor: z.string().nullable(),
            })
            .strict(),
        },
      },
    },
    (request) => repository.list(request.principal!, request.query),
  );
  typed.post(
    "/notifications/:notificationId/read",
    {
      schema: {
        ...common,
        operationId: "markNotificationRead",
        params: z.object({ notificationId: z.string().uuid() }).strict(),
        response: { ...common.response, 204: z.null() },
      },
    },
    async (request, reply) => {
      await repository.read(request.principal!, request.params.notificationId);
      return reply.code(204).send(null);
    },
  );
  typed.post(
    "/notifications/read-all",
    {
      schema: {
        ...common,
        operationId: "markAllNotificationsRead",
        response: { ...common.response, 204: z.null() },
      },
    },
    async (request, reply) => {
      await repository.read(request.principal!);
      return reply.code(204).send(null);
    },
  );
}
