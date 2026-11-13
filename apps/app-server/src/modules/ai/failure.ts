import type { DomainErrorCode } from "../../shared/domain-error.js";

/** Client-facing failure codes for domain errors; any unmapped code is a model failure. */
export type DomainFailureMap = Partial<Record<DomainErrorCode, string>>;

/**
 * Terminal run status for a failure code. The cancelled trigger is universal; the interrupted
 * trigger differs per purpose (qa: OUTPUT_UNKNOWN, writing: SESSION_UNAVAILABLE), so it is a
 * parameter rather than a hardcoded branch.
 */
export function failureRunStatus(
  code: string,
  interruptedCode: string,
): "cancelled" | "interrupted" | "failed" {
  if (code === "CANCELLED") return "cancelled";
  if (code === interruptedCode) return "interrupted";
  return "failed";
}
