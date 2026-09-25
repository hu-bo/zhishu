import { sql } from "../../../database/index.js";
import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
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
        response: { 200: z.object({ status: z.literal("ok") }) },
      },
    },
    async () => {
      await app.db.execute(sql`select 1`);
      return { status: "ok" as const };
    },
  );
}
