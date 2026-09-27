import type { Anchor } from "./schema.js";

export type AnchorTargetStatus =
  "current" | "stale-document" | "stale-generation" | "target-missing";

export interface AnchorTargetContext {
  documentId: string;
  generationId: string;
  blockIds: ReadonlySet<string>;
}

/** Checks identity and target availability before a host resolves the opaque Yjs positions. */
export function checkAnchorTarget(
  anchor: Pick<Anchor, "documentId" | "generationId" | "startBlockId" | "endBlockId">,
  current: AnchorTargetContext,
): AnchorTargetStatus {
  if (anchor.documentId !== current.documentId) return "stale-document";
  if (anchor.generationId !== current.generationId) return "stale-generation";
  if (!current.blockIds.has(anchor.startBlockId) || !current.blockIds.has(anchor.endBlockId))
    return "target-missing";
  return "current";
}
