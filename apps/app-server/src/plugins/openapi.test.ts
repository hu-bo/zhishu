import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { DomainError } from "../shared/domain-error.js";
import { errorResponseSchema } from "../shared/error.schema.js";
import { registerErrorHandlers } from "./errors.js";
import { registerOpenApi } from "./openapi.js";

test("OpenAPI shares errors without changing HTTP serialization or nullable success contracts", async (t) => {
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  await registerOpenApi(app, false);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    "/nullable",
    {
      schema: {
        response: {
          200: z.object({ value: z.string().nullable().default(null) }),
          400: errorResponseSchema,
        },
      },
    },
    async () => ({}),
  );
  typed.get("/quota", { schema: { response: { 429: errorResponseSchema } } }, async () => {
    throw new DomainError("RESOURCE_LIMIT", "Limit reached", { limit: 1 });
  });
  typed.get(
    "/different-error",
    {
      schema: {
        response: {
          400: errorResponseSchema.extend({ retryAt: z.string() }),
        },
      },
    },
    async (_request, reply) =>
      reply.code(400).send({
        code: "RETRY_LATER",
        message: "Try again later",
        requestId: "request",
        retryAt: "later",
      }),
  );
  await app.ready();
  const document = app.swagger() as unknown as {
    paths: Record<
      string,
      {
        get: {
          responses: Record<
            string,
            { content: { "application/json": { schema: Record<string, unknown> } } }
          >;
        };
      }
    >;
    components: {
      schemas: Record<
        string,
        { required?: string[]; properties?: Record<string, Record<string, unknown>> }
      >;
    };
  };
  const response = (path: string, status: string) =>
    document.paths[path]!.get.responses[status]!.content["application/json"].schema;
  const reference = { $ref: "#/components/schemas/ErrorResponse" };
  assert.deepEqual(response("/nullable", "400"), reference);
  assert.deepEqual(response("/quota", "429"), reference);
  const shared = document.components.schemas.ErrorResponse!;
  assert.deepEqual(shared.required, ["code", "message", "requestId"]);
  assert.deepEqual(shared.properties?.details, { type: "object", additionalProperties: {} });
  const success = response("/nullable", "200").properties as Record<string, unknown>;
  assert.deepEqual(success.value, { type: "string", nullable: true, default: null });
  assert.ok(response("/different-error", "400").properties);
  assert.deepEqual((await app.inject("/nullable")).json(), { value: null });
  const quota = await app.inject("/quota");
  assert.equal(quota.statusCode, 429);
  assert.deepEqual(quota.json(), {
    code: "RESOURCE_LIMIT",
    message: "Limit reached",
    requestId: quota.json<{ requestId: string }>().requestId,
    details: { limit: 1 },
  });
});
