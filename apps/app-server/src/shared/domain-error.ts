export type DomainErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "SERVICE_UNAVAILABLE"
  | "RESOURCE_LIMIT"
  | "FORBIDDEN"
  | "AI_WRITE_PERSONAL_ONLY"
  | "AI_ACCESS_REVOKED"
  | "IDEMPOTENCY_KEY_REUSED";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DomainError";
  }
}
