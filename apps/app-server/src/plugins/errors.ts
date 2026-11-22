import type { FastifyError, FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from "fastify-type-provider-zod";
import { DomainError, type DomainErrorCode } from "../shared/domain-error.js";

/** One HTTP status per domain error code; the table is the single mapping source. */
const DOMAIN_ERROR_STATUS = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  SERVICE_UNAVAILABLE: 503,
  RESOURCE_LIMIT: 429,
  FORBIDDEN: 403,
  AI_WRITE_PERSONAL_ONLY: 403,
  AI_ACCESS_REVOKED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
} satisfies Record<DomainErrorCode, number>;

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
      const status = DOMAIN_ERROR_STATUS[error.code];
      if (status === 401) reply.header("www-authenticate", "Bearer");
      if ((status === 401 || status === 403 || status === 404) && request.principal)
        request.log.info(
          {
            event: "authorization-denied",
            userId: request.principal.userId,
            actorId: request.principal.identityId,
            operation: request.routeOptions.url,
            code: error.code,
          },
          "Protected operation rejected",
        );
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
