import {
  applyOperationBatch,
  type DocumentContent,
  type OperationBatch,
} from "@zhishu/document-contracts";
import type { AuthoringProposal } from "./schema.js";
import { canonicalJson } from "./canonical-json.js";

export interface ReplacementDecision {
  blockId: string;
  action: "accept" | "reject";
}
export interface ReplacementReview {
  revision: number;
  decisions: ReplacementDecision[];
  version: AuthoringProposal["document"];
  structureRevision: number;
}

/** Stable block identities bind review controls to trusted proposal operations. */
type ReviewOperation = Extract<
  OperationBatch["operations"][number],
  {
    type: "replace-block" | "delete-block" | "insert-block";
  }
>;
export function replacementChanges(
  proposal: AuthoringProposal,
  original: DocumentContent,
): { blockId: string; operation: ReviewOperation }[] {
  return proposal.operationBatch.operations.flatMap<{
    blockId: string;
    operation: ReviewOperation;
  }>((operation) => {
    if (operation.type === "replace-block" || operation.type === "delete-block") {
      const old = original.content.find((block) => block.attrs.blockId === operation.targetBlockId);
      if (
        operation.type === "replace-block" &&
        canonicalJson(old) === canonicalJson(operation.block)
      )
        return [];
      return [{ blockId: operation.targetBlockId, operation }];
    }
    return operation.type === "insert-block"
      ? [{ blockId: operation.block.attrs.blockId, operation }]
      : [];
  });
}

/** Derive only selected changes; accepted tail insertions keep their proposal order. */
export function replacementBatch(
  proposal: AuthoringProposal,
  original: DocumentContent,
  current: DocumentContent,
  selectedIds: readonly string[],
  operationId: string,
): OperationBatch | null {
  const changes = replacementChanges(proposal, original);
  const selected = new Set(selectedIds);
  if (
    !selected.size ||
    selected.size !== selectedIds.length ||
    selectedIds.some((id) => !changes.some((change) => change.blockId === id))
  )
    return null;
  const operations: OperationBatch["operations"] = [];
  let content = current;
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    if (!selected.has(change.blockId)) continue;
    let operation = change.operation;
    if (operation.type === "insert-block") {
      const following = changes
        .slice(index + 1)
        .find(
          (other) =>
            other.operation.type === "insert-block" &&
            content.content.some((block) => block.attrs.blockId === other.blockId),
        );
      const last = content.content.at(-1)?.attrs.blockId;
      operation = {
        type: "insert-block",
        parentBlockId: null,
        block: operation.block,
        ...(following ? { beforeBlockId: following.blockId } : last ? { afterBlockId: last } : {}),
      };
    }
    const applied = applyOperationBatch(
      content,
      { ...proposal.operationBatch, operationId, preconditions: [], operations: [operation] },
      {
        documentId: proposal.document.documentId,
        generationId: proposal.document.generationId,
      },
    );
    if (!applied.success) return null;
    content = applied.content;
    operations.push(operation);
  }
  return { ...proposal.operationBatch, operationId, preconditions: [], operations };
}
