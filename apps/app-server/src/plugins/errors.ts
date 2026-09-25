import type { FastifyError, FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { DomainError } from "../shared/domain-error.js";

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      code: "NOT_FOUND",
      message: "Route not found",
      requestId: request.id,
    }),
  );
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : 400;
      return reply.code(status).send({
        code: error.code,
        message: error.message,
        requestId: request.id,
        details: error.details,
      });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        requestId: request.id,
      });
    }
    if (isResponseSerializationError(error)) {
      request.log.error(error, "Response serialization failed");
      return reply
        .code(500)
        .send({ code: "INTERNAL_ERROR", message: "Internal server error", requestId: request.id });
    }
    const fastifyError = error as FastifyError;
    const status =
      fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500
        ? fastifyError.statusCode
        : 500;
    request.log.error(error, "Unhandled request error");
    return reply.code(status).send({
      code: status === 500 ? "INTERNAL_ERROR" : (fastifyError.code ?? "BAD_REQUEST"),
      message: status === 500 ? "Internal server error" : "Request could not be processed",
      requestId: request.id,
    });
  });
}
