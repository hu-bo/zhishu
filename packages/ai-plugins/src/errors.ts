import type { AiErrorCode } from "@zhishu/ai-contracts";
export class AiRuntimeError extends Error {
  constructor(readonly code: AiErrorCode) {
    super(code);
    this.name = "AiRuntimeError";
  }
}
export function fail(code: AiErrorCode): never {
  throw new AiRuntimeError(code);
}
