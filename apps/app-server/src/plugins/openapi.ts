import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

export async function registerOpenApi(app: FastifyInstance, enableUi: boolean): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: { title: "Projects API", version: "0.1.0" },
      servers: [],
    },
    transform: jsonSchemaTransform,
  });
  if (enableUi) {
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }
}
