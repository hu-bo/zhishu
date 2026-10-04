import type { Anchor } from "./schema.js";

export type AnchorContextStatus = "current" | "stale-document" | "stale-generation";
export type AnchorTargetStatus = AnchorContextStatus | "target-missing";

export interface AnchorTargetContext {
  documentId: string;
  generationId: string;
  blockIds: ReadonlySet<string>;
}

/** Checks whether an anchor still belongs to the active document generation. */
export function checkAnchorContext(
  anchor: Pick<Anchor, "documentId" | "generationId">,
  current: Pick<AnchorTargetContext, "documentId" | "generationId">,
): AnchorContextStatus {
  if (anchor.documentId !== current.documentId) return "stale-document";
  if (anchor.generationId !== current.generationId) return "stale-generation";
  return "current";
}

/** Checks identity and target availability before a host resolves the opaque Yjs positions. */
export function checkAnchorTarget(
  anchor: Pick<Anchor, "documentId" | "generationId" | "startBlockId" | "endBlockId">,
  current: AnchorTargetContext,
): AnchorTargetStatus {
  const contextStatus = checkAnchorContext(anchor, current);
  if (contextStatus !== "current") return contextStatus;
  if (!current.blockIds.has(anchor.startBlockId) || !current.blockIds.has(anchor.endBlockId))
    return "target-missing";
  return "current";
}
