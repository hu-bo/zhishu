import { Value } from "@sinclair/typebox/value";
import {
  DocumentBlockSchema,
  DocumentContentSchema,
  OperationBatchSchema,
  TableCellSchema,
  TableHeaderSchema,
  TableRowSchema,
  TableSchema,
  TaskListSchema,
} from "./schema.js";
import type { DocumentBlock, DocumentContent, OperationBatch } from "./schema.js";
import { validateDocumentContent } from "./validation.js";

export type OperationErrorCode =
  | "invalid-content"
  | "unknown-extension"
  | "duplicate-block-id"
  | "target-missing"
  | "stale-target"
  | "stale-generation"
  | "read-only"
  | "collaboration-structure-disabled"
  | "invalid-operation"
  | "limit-exceeded";

export interface OperationError {
  code: OperationErrorCode;
  path: string;
  message: string;
  recoverable: boolean;
}

export type ApplyOperationResult =
  | {
      success: true;
      operationId: string;
      content: DocumentContent;
      createdBlockIds: string[];
      deletedBlockIds: string[];
    }
  | { success: false; operationId?: string; error: OperationError };

export interface ApplyOperationContext {
  documentId: string;
  generationId?: string;
  readOnly?: boolean;
  hashBlock?: (block: DocumentBlock) => string;
}

interface MutableNode extends Record<string, unknown> {
  type: string;
  attrs?: Record<string, unknown>;
  content?: unknown[];
}

interface BlockLocation {
  block: MutableNode;
  parent: unknown[];
  index: number;
}

class OperationFailure extends Error {
  constructor(readonly detail: OperationError) {
    super(detail.message);
  }
}

function fail(code: OperationErrorCode, path: string, message: string, recoverable = true): never {
  throw new OperationFailure({ code, path, message, recoverable });
}

function mutableNode(value: unknown): MutableNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as MutableNode)
    : undefined;
}

function blockId(node: MutableNode | undefined): string | undefined {
  return typeof node?.attrs?.blockId === "string" ? node.attrs.blockId : undefined;
}

function locateBlock(content: DocumentContent, id: string): BlockLocation | undefined {
  const arrays: unknown[][] = [content.content as unknown[]];
  while (arrays.length > 0) {
    const current = arrays.pop();
    if (!current) continue;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const node = mutableNode(current[index]);
      if (!node) continue;
      if (blockId(node) === id) return { block: node, parent: current, index };
      if (Array.isArray(node.content)) arrays.push(node.content);
    }
  }
  return undefined;
}

function containsBlock(node: MutableNode, id: string): boolean {
  const pending: unknown[] = [node];
  while (pending.length > 0) {
    const current = mutableNode(pending.pop());
    if (!current) continue;
    if (blockId(current) === id) return true;
    if (Array.isArray(current.content)) pending.push(...current.content);
  }
  return false;
}

function collectBlockIds(node: MutableNode): string[] {
  const ids: string[] = [];
  const pending: MutableNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const id = blockId(current);
    if (id) ids.push(id);
    if (Array.isArray(current.content)) {
      for (const child of current.content) {
        const childNode = mutableNode(child);
        if (childNode) pending.push(childNode);
      }
    }
  }
  return ids;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function directIndex(nodes: unknown[], id: string): number {
  return nodes.findIndex((item) => blockId(mutableNode(item)) === id);
}

function targetArray(
  content: DocumentContent,
  parentBlockId: string | null,
  path: string,
): unknown[] {
  if (parentBlockId === null) return content.content as unknown[];
  const parent = locateBlock(content, parentBlockId);
  if (!parent) fail("target-missing", path, "Target parent does not exist.");
  if (!Array.isArray(parent.block.content))
    fail("invalid-operation", path, "Target parent cannot contain blocks.");
  if (
    !["blockquote", "callout", "bulletList", "orderedList", "listItem", "taskList"].includes(
      parent.block.type,
    )
  )
    fail("invalid-operation", path, "Target parent cannot contain blocks.");
  return parent.block.content;
}

function insertionIndex(
  nodes: unknown[],
  beforeBlockId: string | undefined,
  afterBlockId: string | undefined,
  path: string,
): number {
  if (beforeBlockId && afterBlockId)
    fail("invalid-operation", path, "Specify either beforeBlockId or afterBlockId, not both.");
  if (beforeBlockId) {
    const index = directIndex(nodes, beforeBlockId);
    if (index < 0)
      fail("target-missing", path, "The before Block is not a child of the target parent.");
    return index;
  }
  if (afterBlockId) {
    const index = directIndex(nodes, afterBlockId);
    if (index < 0)
      fail("target-missing", path, "The after Block is not a child of the target parent.");
    return index + 1;
  }
  return nodes.length;
}

function operationSchemaIssues(batch: unknown): OperationError[] {
  const references = [
    DocumentBlockSchema,
    DocumentContentSchema,
    TaskListSchema,
    TableSchema,
    TableRowSchema,
    TableCellSchema,
    TableHeaderSchema,
  ];
  if (Value.Check(OperationBatchSchema, references, batch)) return [];
  return [...Value.Errors(OperationBatchSchema, references, batch)].map((error) => ({
    code: "invalid-content",
    path: error.path || "$",
    message: error.message,
    recoverable: true,
  }));
}

export function applyOperationBatch(
  contentInput: unknown,
  batchInput: unknown,
  context: ApplyOperationContext,
): ApplyOperationResult {
  const schemaIssues = operationSchemaIssues(batchInput);
  const operationId =
    typeof batchInput === "object" && batchInput !== null && "operationId" in batchInput
      ? String((batchInput as { operationId: unknown }).operationId)
      : undefined;
  if (schemaIssues.length > 0)
    return { success: false, operationId, error: schemaIssues[0] as OperationError };

  const batch = batchInput as OperationBatch;
  if (context.readOnly)
    return {
      success: false,
      operationId: batch.operationId,
      error: { code: "read-only", path: "$", message: "Document is read-only.", recoverable: true },
    };
  if (batch.documentId !== context.documentId)
    return {
      success: false,
      operationId: batch.operationId,
      error: {
        code: "stale-target",
        path: "$.documentId",
        message: "Operation targets another document.",
        recoverable: true,
      },
    };
  if (batch.generationId !== undefined && batch.generationId !== context.generationId)
    return {
      success: false,
      operationId: batch.operationId,
      error: {
        code: "stale-generation",
        path: "$.generationId",
        message: "Operation targets another document generation.",
        recoverable: true,
      },
    };

  const inputValidation = validateDocumentContent(contentInput);
  if (!inputValidation.success)
    return {
      success: false,
      operationId: batch.operationId,
      error: {
        code: "invalid-content",
        path: inputValidation.issues[0]?.path ?? "$",
        message: inputValidation.issues[0]?.message ?? "Current document content is invalid.",
        recoverable: false,
      },
    };

  try {
    for (let index = 0; index < (batch.preconditions?.length ?? 0); index += 1) {
      const precondition = batch.preconditions?.[index];
      if (!precondition) continue;
      const location = locateBlock(inputValidation.data, precondition.blockId);
      if (!location)
        fail("target-missing", `$.preconditions/${index}`, "Precondition target no longer exists.");
      if (precondition.contentHash !== undefined) {
        if (!context.hashBlock)
          fail(
            "invalid-operation",
            `$.preconditions/${index}/contentHash`,
            "No content hash provider is configured.",
          );
        if (context.hashBlock(location.block as DocumentBlock) !== precondition.contentHash)
          fail(
            "stale-target",
            `$.preconditions/${index}/contentHash`,
            "Target content has changed.",
          );
      }
    }

    const working = structuredClone(inputValidation.data);
    const createdBlockIds: string[] = [];
    const deletedBlockIds: string[] = [];

    for (let index = 0; index < batch.operations.length; index += 1) {
      const operation = batch.operations[index];
      if (!operation) continue;
      const path = `$.operations/${index}`;
      switch (operation.type) {
        case "insert-block": {
          const target = targetArray(working, operation.parentBlockId, `${path}/parentBlockId`);
          const at = insertionIndex(target, operation.beforeBlockId, operation.afterBlockId, path);
          target.splice(at, 0, structuredClone(operation.block));
          appendUnique(createdBlockIds, collectBlockIds(operation.block as MutableNode));
          break;
        }
        case "delete-block": {
          const target = locateBlock(working, operation.targetBlockId);
          if (!target)
            fail("target-missing", `${path}/targetBlockId`, "Target Block does not exist.");
          appendUnique(deletedBlockIds, collectBlockIds(target.block));
          target.parent.splice(target.index, 1);
          break;
        }
        case "replace-block": {
          const target = locateBlock(working, operation.targetBlockId);
          if (!target)
            fail("target-missing", `${path}/targetBlockId`, "Target Block does not exist.");
          const replacement = structuredClone(operation.block) as MutableNode;
          if (!replacement.attrs)
            fail("invalid-content", `${path}/block/attrs`, "Replacement Block has no attributes.");
          replacement.attrs.blockId = operation.targetBlockId;
          const existingChildIds = new Set(
            collectBlockIds(target.block).filter((id) => id !== operation.targetBlockId),
          );
          const replacementChildIds = new Set(
            collectBlockIds(replacement).filter((id) => id !== operation.targetBlockId),
          );
          appendUnique(
            deletedBlockIds,
            [...existingChildIds].filter((id) => !replacementChildIds.has(id)),
          );
          appendUnique(
            createdBlockIds,
            [...replacementChildIds].filter((id) => !existingChildIds.has(id)),
          );
          target.parent.splice(target.index, 1, replacement);
          break;
        }
        case "wrap-block": {
          const target = locateBlock(working, operation.targetBlockId);
          if (!target)
            fail("target-missing", `${path}/targetBlockId`, "Target Block does not exist.");
          const wrapper = structuredClone(operation.wrapper) as MutableNode;
          if (!wrapper.attrs)
            fail("invalid-content", `${path}/wrapper/attrs`, "Wrapper Block has no attributes.");
          if (!Array.isArray(wrapper.content))
            fail(
              "invalid-content",
              `${path}/wrapper/content`,
              "Wrapper Block must contain Blocks.",
            );
          const targetIds = new Set(collectBlockIds(target.block));
          wrapper.content.unshift(target.block);
          appendUnique(
            createdBlockIds,
            collectBlockIds(wrapper).filter((id) => !targetIds.has(id)),
          );
          target.parent.splice(target.index, 1, wrapper);
          break;
        }
        case "move-block": {
          const target = locateBlock(working, operation.targetBlockId);
          if (!target)
            fail("target-missing", `${path}/targetBlockId`, "Target Block does not exist.");
          if (operation.parentBlockId && containsBlock(target.block, operation.parentBlockId))
            fail(
              "invalid-operation",
              `${path}/parentBlockId`,
              "A Block cannot be moved into itself or its descendant.",
            );
          target.parent.splice(target.index, 1);
          const destination = targetArray(
            working,
            operation.parentBlockId,
            `${path}/parentBlockId`,
          );
          const at = insertionIndex(
            destination,
            operation.beforeBlockId,
            operation.afterBlockId,
            path,
          );
          destination.splice(at, 0, target.block);
          break;
        }
      }
    }

    const outputValidation = validateDocumentContent(working);
    if (!outputValidation.success) {
      const firstIssue = outputValidation.issues[0];
      fail(
        firstIssue?.code ?? "invalid-content",
        firstIssue?.path ?? "$",
        firstIssue?.message ?? "Operation batch would produce invalid content.",
      );
    }
    return {
      success: true,
      operationId: batch.operationId,
      content: outputValidation.data,
      createdBlockIds,
      deletedBlockIds,
    };
  } catch (error) {
    if (error instanceof OperationFailure)
      return { success: false, operationId: batch.operationId, error: error.detail };
    throw error;
  }
}
