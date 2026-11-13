import { canonicalJson } from "@zhishu/ai-contracts";

/**
 * Stable object key ordering for persisted request and migration fingerprints. Delegates to the
 * single canonical-JSON implementation in ai-contracts (byte-identical for validated JSON); the
 * "null" fallback preserves the legacy top-level undefined behavior.
 */
export function stableJsonStringify(value: unknown): string {
  return canonicalJson(value) ?? "null";
}
