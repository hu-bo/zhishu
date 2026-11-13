import {
  validateEvidenceBundle,
  type EvidenceBundle,
  type EvidenceItem,
  type EvidenceSource,
} from "@zhishu/ai-contracts";
import { DomainError } from "../../shared/domain-error.js";

/**
 * Merge evidence bundles from multiple retrieval steps into one. evidenceId is a stable
 * identity, so duplicates are collapsed (the bundle contract rejects repeated ids); sources
 * are kept only while a retained item still references them. The result is re-validated so a
 * malformed combination fails closed instead of reaching the model.
 */
export function mergeEvidenceBundles(bundles: EvidenceBundle[]): EvidenceBundle {
  const sources = new Map<string, EvidenceSource>();
  const items: EvidenceItem[] = [];
  for (const bundle of bundles) {
    for (const source of bundle.sources)
      sources.set(`${source.sourceId}\u0000${source.snapshotId}`, source);
    for (const item of bundle.items)
      if (!items.some((existing) => existing.evidenceId === item.evidenceId)) items.push(item);
  }
  const merged: EvidenceBundle = {
    sources: [...sources.values()].filter((source) =>
      items.some(
        (item) => item.sourceId === source.sourceId && item.snapshotId === source.snapshotId,
      ),
    ),
    items,
    freshness: "current",
  };
  if (!validateEvidenceBundle(merged).success) throw new DomainError("CONFLICT", "资料组合不合法");
  return merged;
}
