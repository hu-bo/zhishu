import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { documentContractJsonSchemas } from "@zhishu/document-contracts";
import {
  AuthoringRequestSchema,
  AuthoringProposalSchema,
  ChatRequestSchema,
  ChatResultSchema,
  AiTaskEventSchema,
  AiTaskEventV2Schema,
} from "@zhishu/ai-contracts";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import { errorResponseSchema } from "../shared/error.schema.js";
import {
  ChatSnapshotSchema,
  SubmitChatMessageSchema,
  ChatFrameSchema,
} from "@zhishu/chat-contracts";
import { ImageJobSchema } from "@zhishu/ai-plugins/contracts";

type SwaggerTransformObject = import("@fastify/swagger").SwaggerTransformObject;

// Derive the component from the same Zod contract used by HTTP serialization.
const sharedErrorResponse = jsonSchemaTransform({
  schema: { body: errorResponseSchema },
  url: "",
}).schema.body;
const errorSchemaFingerprint = JSON.stringify(sharedErrorResponse);

function toOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toOpenApiSchema);
  if (typeof value !== "object" || value === null) return value;

  const schema = { ...(value as Record<string, unknown>) };
  delete schema.$id;
  delete schema.$schema;
  if (typeof schema.$ref === "string" && !schema.$ref.startsWith("#"))
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
    [
      ...documentContractJsonSchemas,
      AuthoringRequestSchema,
      AuthoringProposalSchema,
      ChatRequestSchema,
      ChatResultSchema,
      AiTaskEventSchema,
      AiTaskEventV2Schema,
    ].map((schema) => [schema.$id, toOpenApiSchema(schema)]),
  );
  Object.assign(schemas, {
    ErrorResponse: sharedErrorResponse,
    WritingChatSnapshot: toOpenApiSchema(ChatSnapshotSchema),
    SubmitWritingMessage: toOpenApiSchema(SubmitChatMessageSchema),
    WritingChatFrame: toOpenApiSchema(ChatFrameSchema),
    WritingImageJob: toOpenApiSchema(ImageJobSchema),
  });
  const paths = document.paths as Record<string, Record<string, unknown>>;
  for (const [path, operations] of Object.entries(paths)) {
    if (!path.startsWith("/api/writing/conversations")) continue;
    for (const operation of Object.values(operations)) {
      const op = operation as {
        requestBody?: { content?: Record<string, { schema?: unknown }> };
        responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
      };
      if (path.includes("/images")) {
        const json = op.responses?.["200"]?.content?.["application/json"];
        if (json && !path.endsWith("/access"))
          json.schema = path.endsWith("/images")
            ? { type: "array", items: { $ref: "#/components/schemas/WritingImageJob" } }
            : { $ref: "#/components/schemas/WritingImageJob" };
        continue;
      }
      if (path.endsWith("/messages") && op.requestBody?.content?.["application/json"])
        op.requestBody.content["application/json"].schema = {
          $ref: "#/components/schemas/SubmitWritingMessage",
        };
      if (path.endsWith("/events")) {
        if (op.responses?.["200"])
          op.responses["200"].content = { "text/event-stream": { schema: { type: "string" } } };
      } else if (op.responses?.["200"]?.content?.["application/json"])
        op.responses["200"].content["application/json"].schema = {
          $ref: "#/components/schemas/WritingChatSnapshot",
        };
      const accepted = op.responses?.["202"]?.content?.["application/json"];
      if (accepted)
        accepted.schema = {
          type: "object",
          required: ["runId", "snapshot"],
          properties: {
            runId: { type: "string" },
            snapshot: { $ref: "#/components/schemas/WritingChatSnapshot" },
          },
        };
    }
  }
  for (const [path, reference] of [
    ["/api/ai/chat", "ChatRequest"],
    ["/api/ai/authoring", "AuthoringRequest"],
  ]) {
    const operation = paths[path!]?.post as
      | {
          requestBody?: {
            content?: Record<string, { schema?: { properties?: Record<string, unknown> } }>;
          };
          responses?: Record<string, { content?: Record<string, unknown> }>;
        }
      | undefined;
    const properties = operation?.requestBody?.content?.["application/json"]?.schema?.properties;
    if (properties) properties.request = { $ref: `#/components/schemas/${reference}` };
    if (operation?.responses?.["200"]?.content)
      operation.responses["200"].content["text/event-stream"] = {
        schema: { type: "string" },
        "x-event-schema": {
          $ref: `#/components/schemas/${reference === "ChatRequest" ? "AiTaskEventV2" : "AiTaskEvent"}`,
        },
      };
  }
  for (const [path, operations] of Object.entries(paths)) {
    for (const operation of Object.values(operations)) {
      const responses = (
        operation as {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                { schema?: { $ref?: string; properties?: Record<string, unknown> } }
              >;
            }
          >;
        }
      )?.responses;
      for (const response of Object.values(responses ?? {})) {
        const json = response.content?.["application/json"];
        // The provider v4 document-wide resolver fails on literal null defaults.
        if (json && JSON.stringify(json.schema) === errorSchemaFingerprint) {
          json.schema = { $ref: "#/components/schemas/ErrorResponse" };
          continue;
        }
        if (!path.startsWith("/api/ai/")) continue;
        const properties = json?.schema?.properties;
        if (!properties) continue;
        if ("result" in properties)
          properties.result = {
            anyOf: [
              { $ref: "#/components/schemas/AuthoringProposal" },
              { $ref: "#/components/schemas/ChatResult" },
              { type: "null" },
            ],
          };
        if ("snapshot" in properties)
          properties.snapshot = { $ref: "#/components/schemas/DocumentSnapshot" };
      }
    }
  }
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
