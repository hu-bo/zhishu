import type { DocumentContent } from "./schema.js";

export type DocumentMentionReference = { identityId: string; blockId: string };
/** One occurrence per member and containing text block; labels never act as identities. */
export function collectDocumentMentions(content: DocumentContent): DocumentMentionReference[] {
  const found = new Map<string, DocumentMentionReference>();
  const pending: { node: unknown; blockId?: string }[] = [{ node: content }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (!entry.node || typeof entry.node !== "object" || Array.isArray(entry.node)) continue;
    const node = entry.node as {
      type?: string;
      attrs?: { identityId?: string; blockId?: string };
      content?: unknown[];
    };
    const blockId = node.attrs?.blockId ?? entry.blockId;
    if (node.type === "mention" && blockId && node.attrs?.identityId) {
      const reference = { identityId: node.attrs.identityId, blockId };
      found.set(JSON.stringify([blockId, reference.identityId]), reference);
    }
    for (const child of node.content ?? []) pending.push({ node: child, blockId });
  }
  return [...found.values()];
}
