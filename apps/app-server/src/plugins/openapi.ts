import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { documentContractJsonSchemas } from "@zhishu/document-contracts";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

type SwaggerTransformObject = import("@fastify/swagger").SwaggerTransformObject;

function toOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toOpenApiSchema);
  if (typeof value !== "object" || value === null) return value;

  const schema = { ...(value as Record<string, unknown>) };
  delete schema.$id;
  delete schema.$schema;
  if (schema.$ref === "DocumentBlock" || schema.$ref === "DocumentContent")
    schema.$ref = `#/components/schemas/${schema.$ref}`;
  for (const [key, child] of Object.entries(schema)) schema[key] = toOpenApiSchema(child);
  return schema;
}

function transformOpenApiDocument(
  source: Parameters<SwaggerTransformObject>[0],
): ReturnType<SwaggerTransformObject> {
  if (!("openapiObject" in source)) return {};

  const { servers, ...document } = source.openapiObject;
  void servers;
  const schemas = Object.fromEntries(
    documentContractJsonSchemas.map((schema) => [schema.$id, toOpenApiSchema(schema)]),
  );
  return {
    ...document,
    openapi: "3.1.0",
    components: {
      ...document.components,
      schemas: { ...document.components?.schemas, ...schemas },
    },
  } as unknown as ReturnType<SwaggerTransformObject>;
}

export async function registerOpenApi(app: FastifyInstance, enableUi: boolean): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Application API", version: "0.1.0" },
      servers: [],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
        },
      },
    },
    transform: jsonSchemaTransform,
    transformObject: transformOpenApiDocument,
  });
  if (enableUi) {
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }
}
