import type { AiErrorCode } from "./schema.js";

/** Single typed failure carrier for both business flows and application adapters. */
export class AiRuntimeError extends Error {
  constructor(readonly code: AiErrorCode) {
    super(code);
    this.name = "AiRuntimeError";
  }
}
export function fail(code: AiErrorCode): never {
  throw new AiRuntimeError(code);
}
