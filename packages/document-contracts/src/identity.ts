import type { DocumentContent } from "./schema.js";
import { validateDocumentContent } from "./validation.js";

export function createBlockId(): string {
  return `block_${globalThis.crypto.randomUUID()}`;
}

export function cloneContentWithFreshBlockIds(
  input: unknown,
  createId: () => string = createBlockId,
): DocumentContent {
  const validation = validateDocumentContent(input);
  if (!validation.success) {
    const firstIssue = validation.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid document content.",
    );
  }

  const copy = structuredClone(validation.data);
  const usedIds = new Set<string>();
  const sourceIds = new Set<string>();
  const collect: unknown[] = [validation.data];
  while (collect.length > 0) {
    const value = collect.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    const attrs = node.attrs;
    if (typeof attrs === "object" && attrs !== null && "blockId" in attrs) {
      const id = (attrs as Record<string, unknown>).blockId;
      if (typeof id === "string") sourceIds.add(id);
    }
    if (Array.isArray(node.content)) collect.push(...node.content);
  }
  for (const id of sourceIds) usedIds.add(id);

  const stack: unknown[] = [copy];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    if (
      typeof node.type === "string" &&
      node.type !== "doc" &&
      typeof node.attrs === "object" &&
      node.attrs !== null &&
      "blockId" in node.attrs
    ) {
      const id = createId();
      if (usedIds.has(id)) {
        throw new TypeError(`Generated Block ID ${id} is not fresh and unique.`);
      }
      usedIds.add(id);
      (node.attrs as Record<string, unknown>).blockId = id;
    }
    if (Array.isArray(node.content)) stack.push(...node.content);
  }

  const clonedValidation = validateDocumentContent(copy);
  if (!clonedValidation.success) {
    const firstIssue = clonedValidation.issues[0];
    throw new TypeError(
      firstIssue
        ? `${firstIssue.path}: ${firstIssue.message}`
        : "Generated Block IDs are not unique.",
    );
  }
  return copy;
}

export function repairDuplicateBlockIds(
  input: unknown,
  createId: () => string = createBlockId,
): { content: DocumentContent; repairedCount: number } {
  const validation = validateDocumentContent(input);
  if (validation.success) return { content: validation.data, repairedCount: 0 };
  if (
    validation.issues.length === 0 ||
    validation.issues.some((item) => item.code !== "duplicate-block-id")
  ) {
    const firstIssue = validation.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid document content.",
    );
  }

  const copy = structuredClone(input) as unknown;
  const sourceIds = new Set<string>();
  const collect: unknown[] = [copy];
  while (collect.length > 0) {
    const value = collect.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    const attrs = node.attrs;
    if (typeof attrs === "object" && attrs !== null && "blockId" in attrs) {
      const id = (attrs as Record<string, unknown>).blockId;
      if (typeof id === "string") sourceIds.add(id);
    }
    if (Array.isArray(node.content)) collect.push(...node.content);
  }

  const seenIds = new Set<string>();
  const generatedIds = new Set<string>();
  const stack: unknown[] = [copy];
  let repairedCount = 0;
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const node = value as Record<string, unknown>;
    if (
      typeof node.type === "string" &&
      node.type !== "doc" &&
      typeof node.attrs === "object" &&
      node.attrs !== null &&
      "blockId" in node.attrs
    ) {
      const attrs = node.attrs as Record<string, unknown>;
      const id = attrs.blockId;
      if (typeof id !== "string") throw new TypeError("Block ID repair encountered an invalid ID.");
      if (seenIds.has(id)) {
        let replacement: string | undefined;
        for (let attempt = 0; attempt < 32; attempt += 1) {
          const candidate = createId();
          if (!sourceIds.has(candidate) && !generatedIds.has(candidate)) {
            replacement = candidate;
            break;
          }
        }
        if (!replacement) throw new TypeError("Block ID repair could not generate a unique ID.");
        attrs.blockId = replacement;
        generatedIds.add(replacement);
        repairedCount += 1;
      } else {
        seenIds.add(id);
      }
    }
    if (Array.isArray(node.content)) {
      for (let index = node.content.length - 1; index >= 0; index -= 1) {
        stack.push(node.content[index]);
      }
    }
  }

  const repairedValidation = validateDocumentContent(copy);
  if (!repairedValidation.success) {
    const firstIssue = repairedValidation.issues[0];
    throw new TypeError(
      firstIssue
        ? `${firstIssue.path}: ${firstIssue.message}`
        : "Block ID repair produced invalid document content.",
    );
  }
  return { content: repairedValidation.data, repairedCount };
}

export function cloneBlockWithFreshIds(
  input: unknown,
  createId: () => string = createBlockId,
): NonNullable<DocumentContent["content"][number]> {
  const validation = validateDocumentContent({ type: "doc", content: [input] });
  if (!validation.success) {
    const firstIssue = validation.issues[0];
    throw new TypeError(
      firstIssue ? `${firstIssue.path}: ${firstIssue.message}` : "Invalid Block.",
    );
  }
  const cloned = cloneContentWithFreshBlockIds(validation.data, createId).content[0];
  if (!cloned) throw new TypeError("The cloned Block is missing.");
  return cloned;
}
