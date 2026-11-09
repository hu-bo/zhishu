import { createHash } from "node:crypto";
import type { DocumentContent } from "@zhishu/document-contracts";

export type DocumentAssetReference = { assetId: string; blockId: string; mediaType: string };
export type ProjectionSummary = { blockCount: number; textLength: number; assetCount: number };

type ContentNode = {
  type?: unknown;
  text?: unknown;
  attrs?: { assetId?: unknown; blockId?: unknown; mediaType?: unknown } | null;
  content?: unknown;
};

const isAsset = (node: ContentNode) => node.type === "image" || node.type === "pdfAttachment";

/** Persisted summaries and references use last-child-first DFS without allocating diagnostic paths. */
function* documentNodes(content: unknown): Generator<ContentNode> {
  const pending = [content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    const node = value as ContentNode;
    yield node;
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
}

/** Import reports alone need source-ordered diagnostic locations, including malformed assets. */
export function inspectDocumentContent(content: unknown) {
  let blockCount = 0;
  const assetPaths: string[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value: content, path: "$" }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (typeof current.value !== "object" || current.value === null) continue;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1)
        pending.push({ value: current.value[index], path: `${current.path}/${index}` });
      continue;
    }
    const node = current.value as ContentNode;
    if (typeof node.attrs?.blockId === "string") blockCount += 1;
    if (isAsset(node)) assetPaths.push(`${current.path}/attrs`);
    if (Array.isArray(node.content))
      for (let index = node.content.length - 1; index >= 0; index -= 1)
        pending.push({ value: node.content[index], path: `${current.path}/content/${index}` });
  }
  return { blockCount, assetCount: assetPaths.length, assetPaths };
}

export function summarizeDocumentContent(content: DocumentContent): ProjectionSummary {
  const summary: ProjectionSummary = { blockCount: 0, textLength: 0, assetCount: 0 };
  for (const node of documentNodes(content)) {
    if (typeof node.attrs?.blockId === "string") summary.blockCount += 1;
    if (node.type === "text" && typeof node.text === "string")
      summary.textLength += [...node.text].length;
    if (isAsset(node)) summary.assetCount += 1;
  }
  return summary;
}

export function collectAssetReferences(content: DocumentContent): DocumentAssetReference[] {
  const references: DocumentAssetReference[] = [];
  for (const node of documentNodes(content))
    if (
      isAsset(node) &&
      typeof node.attrs?.assetId === "string" &&
      typeof node.attrs.blockId === "string" &&
      typeof node.attrs.mediaType === "string"
    )
      references.push({
        assetId: node.attrs.assetId,
        blockId: node.attrs.blockId,
        mediaType: node.attrs.mediaType,
      });
  return references;
}

// Projection hashes intentionally retain stored JSON order; request fingerprints use stable-json.
export function hashDocumentContent(content: DocumentContent): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
