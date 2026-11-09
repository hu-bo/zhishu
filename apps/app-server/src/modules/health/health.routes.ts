import { timingSafeEqual } from "node:crypto";
import { sql } from "../../../database/index.js";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { DocumentProjectionRepository } from "../documents/index.js";
import type { OperationsMetrics } from "./operations-metrics.js";

export async function healthRoutes(
  app: FastifyInstance,
  metrics: OperationsMetrics,
  metricsBearerToken?: string,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const projections = new DocumentProjectionRepository(app.db);
  typed.get(
    "/health/live",
    {
      schema: {
        operationId: "getLiveness",
        tags: ["health"],
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => ({ status: "ok" as const }),
  );
  typed.get(
    "/health/ready",
    {
      schema: {
        operationId: "getReadiness",
        tags: ["health"],
        response: {
          200: z.object({
            status: z.literal("ok"),
            documentProjection: z.object({
              pending: z.number().int().nonnegative(),
              processing: z.number().int().nonnegative(),
              dead: z.number().int().nonnegative(),
            }),
          }),
        },
      },
    },
    async () => {
      await app.db.execute(sql`select 1`);
      const documentProjection = await projections.getProjectionQueueStatus();
      return { status: "ok" as const, documentProjection };
    },
  );
  typed.get(
    "/metrics",
    {
      schema: {
        operationId: "getMetrics",
        tags: ["health"],
        response: { 200: z.string(), 401: z.string(), 404: z.string() },
      },
    },
    async (request, reply) => {
      const contentType = "text/plain; version=0.0.4; charset=utf-8";
      if (!metricsBearerToken) {
        return reply.code(404).type(contentType).send("Not found\n");
      }
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const supplied = Buffer.from(token);
      const expected = Buffer.from(metricsBearerToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return reply.code(401).type(contentType).send("Unauthorized\n");
      }
      return reply.type(contentType).send(metrics.renderPrometheus());
    },
  );
}
