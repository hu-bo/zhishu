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
  if (
    schema.$ref === "DocumentBlock" ||
    schema.$ref === "DocumentContent" ||
    schema.$ref === "TaskList" ||
    schema.$ref === "Table" ||
    schema.$ref === "TableRow" ||
    schema.$ref === "TableCell" ||
    schema.$ref === "TableHeader"
  )
    schema.$ref = `#/components/schemas/${schema.$ref}`;
  for (const [key, child] of Object.entries(schema)) schema[key] = toOpenApiSchema(child);
  return schema;
}

function setSharedDocumentContentSchema(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const properties = (value as Record<string, unknown>).properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return;
  (properties as Record<string, unknown>).content = {
    $ref: "#/components/schemas/DocumentContent",
  };
}

function patchSharedContentReferences(document: Record<string, unknown>): void {
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) return;
  const pathMap = paths as Record<string, unknown>;
  const patchResponse = (path: string, method: string, status: string): void => {
    const route = pathMap[path];
    if (typeof route !== "object" || route === null || Array.isArray(route)) return;
    const operation = (route as Record<string, unknown>)[method];
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) return;
    const responses = (operation as Record<string, unknown>).responses;
    if (typeof responses !== "object" || responses === null || Array.isArray(responses)) return;
    const response = (responses as Record<string, unknown>)[status];
    if (typeof response !== "object" || response === null || Array.isArray(response)) return;
    const content = (response as Record<string, unknown>).content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) return;
    const json = (content as Record<string, unknown>)["application/json"];
    if (typeof json !== "object" || json === null || Array.isArray(json)) return;
    setSharedDocumentContentSchema((json as Record<string, unknown>).schema);
  };
  const patchRequestBody = (path: string, method: string): void => {
    const route = pathMap[path];
    if (typeof route !== "object" || route === null || Array.isArray(route)) return;
    const operation = (route as Record<string, unknown>)[method];
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) return;
    const requestBody = (operation as Record<string, unknown>).requestBody;
    if (typeof requestBody !== "object" || requestBody === null || Array.isArray(requestBody))
      return;
    const content = (requestBody as Record<string, unknown>).content;
    if (typeof content !== "object" || content === null || Array.isArray(content)) return;
    const json = (content as Record<string, unknown>)["application/json"];
    if (typeof json !== "object" || json === null || Array.isArray(json)) return;
    setSharedDocumentContentSchema((json as Record<string, unknown>).schema);
  };

  patchResponse("/api/documents/{documentId}/content", "get", "200");
  patchResponse("/api/documents/{documentId}/content", "put", "200");
  patchRequestBody("/api/documents/{documentId}/content", "put");
  patchResponse("/api/documents/{documentId}/export", "get", "200");
  patchRequestBody("/api/documents/import", "post");
  patchResponse("/api/documents/{documentId}/versions/{versionId}/content", "get", "200");
}

function transformOpenApiDocument(
  source: Parameters<SwaggerTransformObject>[0],
): ReturnType<SwaggerTransformObject> {
  if (!("openapiObject" in source)) return {};

  const cloned = structuredClone(source.openapiObject);
  const { servers, ...document } = cloned;
  void servers;
  patchSharedContentReferences(document as unknown as Record<string, unknown>);
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
