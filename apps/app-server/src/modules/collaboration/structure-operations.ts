import type { DocumentBlock, DocumentContent, OperationBatch } from "@zhishu/document-contracts";
import { applyOperationBatch } from "@zhishu/document-contracts/operations";
import { validateDocumentContent } from "@zhishu/document-contracts";
import * as Y from "yjs";

const MAX_OPERATION_RECEIPTS = 10_000;
const MAX_TOMBSTONES = 100_000;
const MAX_STRUCTURE_BYTES = 5 * 1024 * 1024;
const containerTypes = new Set(["blockquote", "bulletList", "orderedList", "listItem"]);

export const structureMetaMapName = "zhishu.structure.v1";
export const structureNodeMapName = "zhishu.structure.nodes.v1";
export const structureOrderMapName = "zhishu.structure.orders.v1";
export const structureTombstoneMapName = "zhishu.structure.tombstones.v1";
export const structureOperationMapName = "zhishu.structure.operations.v1";

export type StructureOperationReceipt = {
  requestHash: string;
  revision: number;
};

export type StoredStructureState = {
  version: 1;
  revision: number;
  content: DocumentContent;
  tombstones: string[];
  operations: Record<string, StructureOperationReceipt>;
};

export type StructureOperationResult =
  | { status: "accepted" | "duplicate"; revision: number }
  | { status: "conflict" | "rejected"; revision: number; code: string };

type ProjectedStructure = {
  rootIds: string[];
  nodes: Map<string, string>;
  orders: Map<string, string>;
};

function isBlock(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blockId(block: DocumentBlock): string {
  return block.attrs.blockId;
}

function parseIdList(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.some((id) => typeof id !== "string" || !/^block_[A-Za-z0-9_-]{1,64}$/.test(id))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function projectContent(content: DocumentContent): ProjectedStructure {
  const nodes = new Map<string, string>();
  const orders = new Map<string, string>();
  const visit = (block: DocumentBlock): void => {
    const id = blockId(block);
    const serialized = structuredClone(block) as unknown as Record<string, unknown>;
    if (containerTypes.has(block.type)) {
      const children = ((block as unknown as { content?: DocumentBlock[] }).content ??
        []) as DocumentBlock[];
      orders.set(id, JSON.stringify(children.map(blockId)));
      delete serialized.content;
      for (const child of children) visit(child);
    }
    nodes.set(id, JSON.stringify(serialized));
  };
  for (const block of content.content) visit(block);
  return { rootIds: content.content.map(blockId), nodes, orders };
}

export function emptyStructureState(): StoredStructureState {
  return {
    version: 1,
    revision: 0,
    content: { type: "doc", content: [] },
    tombstones: [],
    operations: {},
  };
}

function collectContentBlockIds(content: DocumentContent): Set<string> {
  const ids = new Set<string>();
  const pending: unknown[] = [...content.content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!isBlock(value)) continue;
    const attrs = value.attrs;
    if (isBlock(attrs) && typeof attrs.blockId === "string") ids.add(attrs.blockId);
    if (Array.isArray(value.content)) pending.push(...value.content);
  }
  return ids;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isBlock(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sameDocumentContent(left: DocumentContent, right: DocumentContent): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export type ContentProjectionResult =
  { success: true; state: StoredStructureState } | { success: false; code: string };

export function projectContentUpdateToStructure(
  state: StoredStructureState,
  currentContent: DocumentContent,
  nextContent: DocumentContent,
): ContentProjectionResult {
  const isUninitialized = state.revision === 0 && state.content.content.length === 0;
  const indexedCurrent = isUninitialized ? currentContent : state.content;
  if (!sameDocumentContent(indexedCurrent, currentContent)) {
    return { success: false, code: "structure-projection-out-of-sync" };
  }

  const currentIds = collectContentBlockIds(indexedCurrent);
  const nextIds = collectContentBlockIds(nextContent);
  const tombstones = new Set(state.tombstones);
  for (const id of nextIds) {
    if (!currentIds.has(id) && tombstones.has(id)) {
      return { success: false, code: "retired-block-id-reused" };
    }
  }
  for (const id of currentIds) if (!nextIds.has(id)) tombstones.add(id);
  if (tombstones.size > MAX_TOMBSTONES) {
    return { success: false, code: "block-id-tombstone-capacity" };
  }

  const contentUnchanged = sameDocumentContent(indexedCurrent, nextContent);
  if (contentUnchanged && (!isUninitialized || currentContent.content.length === 0)) {
    return { success: true, state };
  }
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    return { success: false, code: "structure-revision-capacity" };
  }
  const next: StoredStructureState = {
    version: 1,
    revision,
    content: structuredClone(nextContent),
    tombstones: [...tombstones],
    operations: state.operations,
  };
  if (estimateStructureBytes(next) > MAX_STRUCTURE_BYTES) {
    return { success: false, code: "structure-state-capacity" };
  }
  return { success: true, state: next };
}

function estimateStructureBytes(state: StoredStructureState): number {
  const projection = projectContent(state.content);
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(projection.rootIds)).byteLength;
  for (const [id, value] of projection.nodes)
    bytes += encoder.encode(id).byteLength + encoder.encode(value).byteLength;
  for (const [id, value] of projection.orders)
    bytes += encoder.encode(id).byteLength + encoder.encode(value).byteLength;
  for (const id of state.tombstones) bytes += encoder.encode(id).byteLength;
  for (const [id, value] of Object.entries(state.operations)) {
    bytes += encoder.encode(id).byteLength + encoder.encode(JSON.stringify(value)).byteLength;
  }
  return bytes;
}

export function readStoredStructureState(document: Y.Doc): StoredStructureState | null {
  const meta = document.getMap<unknown>(structureMetaMapName);
  const nodes = document.getMap<string>(structureNodeMapName);
  const orders = document.getMap<string>(structureOrderMapName);
  const tombstones = document.getMap<boolean>(structureTombstoneMapName);
  const operations = document.getMap<string>(structureOperationMapName);
  const rawRevision = meta.get("revision");
  if (rawRevision === undefined) {
    return meta.size === 0 &&
      nodes.size === 0 &&
      orders.size === 0 &&
      tombstones.size === 0 &&
      operations.size === 0
      ? emptyStructureState()
      : null;
  }
  if (
    rawRevision === null ||
    typeof rawRevision !== "number" ||
    !Number.isSafeInteger(rawRevision) ||
    rawRevision < 1 ||
    meta.get("version") !== 1
  ) {
    return null;
  }
  const rootValue = meta.get("root");
  if (typeof rootValue !== "string") return null;
  const rootIds = parseIdList(rootValue);
  if (!rootIds) return null;

  let serializedBytes = new TextEncoder().encode(rootValue).byteLength;
  for (const [id, value] of nodes) {
    serializedBytes +=
      new TextEncoder().encode(id).byteLength + new TextEncoder().encode(value).byteLength;
  }
  for (const [id, value] of orders) {
    serializedBytes +=
      new TextEncoder().encode(id).byteLength + new TextEncoder().encode(value).byteLength;
  }
  for (const [id, value] of operations) {
    serializedBytes +=
      new TextEncoder().encode(id).byteLength + new TextEncoder().encode(value).byteLength;
  }
  for (const id of tombstones.keys()) serializedBytes += new TextEncoder().encode(id).byteLength;
  if (serializedBytes > MAX_STRUCTURE_BYTES || tombstones.size > MAX_TOMBSTONES) return null;

  const visited = new Set<string>();
  const expectedOrders = new Set<string>();
  const buildBlock = (id: string): DocumentBlock | null => {
    if (visited.has(id)) return null;
    const rawNode = nodes.get(id);
    if (rawNode === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawNode);
    } catch {
      return null;
    }
    const parsedRecord = isBlock(parsed) ? parsed : null;
    const attrs = parsedRecord?.attrs;
    if (
      !parsedRecord ||
      typeof attrs !== "object" ||
      attrs === null ||
      (attrs as Record<string, unknown>).blockId !== id
    ) {
      return null;
    }
    visited.add(id);
    const childOrder = orders.get(id);
    if (typeof parsedRecord.type !== "string") return null;
    if (containerTypes.has(parsedRecord.type)) {
      if (Object.hasOwn(parsedRecord, "content") || childOrder === undefined) return null;
      const children = parseIdList(childOrder);
      if (!children) return null;
      expectedOrders.add(id);
      const builtChildren: DocumentBlock[] = [];
      for (const childId of children) {
        const child = buildBlock(childId);
        if (!child) return null;
        builtChildren.push(child);
      }
      parsedRecord.content = builtChildren;
    } else if (childOrder !== undefined) {
      return null;
    }
    return parsedRecord as unknown as DocumentBlock;
  };

  const contentBlocks: DocumentBlock[] = [];
  for (const id of rootIds) {
    const block = buildBlock(id);
    if (!block) return null;
    contentBlocks.push(block);
  }
  if (
    visited.size !== nodes.size ||
    expectedOrders.size !== orders.size ||
    [...tombstones].some(
      ([id, retired]) =>
        retired !== true || !/^block_[A-Za-z0-9_-]{1,64}$/.test(id) || nodes.has(id),
    )
  ) {
    return null;
  }

  const validation = validateDocumentContent({ type: "doc", content: contentBlocks });
  if (!validation.success) return null;

  const operationReceipts: Record<string, StructureOperationReceipt> = {};
  if (operations.size > MAX_OPERATION_RECEIPTS) return null;
  for (const [operationId, rawReceipt] of operations) {
    if (!/^op_[A-Za-z0-9_-]{1,64}$/.test(operationId)) return null;
    try {
      const receipt = JSON.parse(rawReceipt) as Partial<StructureOperationReceipt>;
      if (
        typeof receipt.requestHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.requestHash) ||
        typeof receipt.revision !== "number" ||
        !Number.isSafeInteger(receipt.revision) ||
        receipt.revision < 1 ||
        receipt.revision > rawRevision
      ) {
        return null;
      }
      operationReceipts[operationId] = {
        requestHash: receipt.requestHash,
        revision: receipt.revision,
      };
    } catch {
      return null;
    }
  }

  return {
    version: 1,
    revision: rawRevision,
    content: validation.data,
    tombstones: [...tombstones.keys()],
    operations: operationReceipts,
  };
}

export function writeStoredStructureState(
  document: Y.Doc,
  next: StoredStructureState,
  operationId?: string,
): void {
  const projection = projectContent(next.content);
  const meta = document.getMap<unknown>(structureMetaMapName);
  const nodes = document.getMap<string>(structureNodeMapName);
  const orders = document.getMap<string>(structureOrderMapName);
  const tombstones = document.getMap<boolean>(structureTombstoneMapName);
  const operations = document.getMap<string>(structureOperationMapName);

  if (
    projection.nodes.size > 20_000 ||
    projection.orders.size > 20_000 ||
    estimateStructureBytes(next) > MAX_STRUCTURE_BYTES ||
    next.tombstones.length > MAX_TOMBSTONES
  ) {
    throw new Error("structure-node-capacity");
  }
  document.transact(() => {
    if (meta.get("version") !== 1) meta.set("version", 1);
    const rootOrder = JSON.stringify(projection.rootIds);
    if (meta.get("root") !== rootOrder) meta.set("root", rootOrder);
    meta.set("revision", next.revision);

    for (const id of nodes.keys()) if (!projection.nodes.has(id)) nodes.delete(id);
    for (const [id, value] of projection.nodes) {
      if (nodes.get(id) !== value) nodes.set(id, value);
    }
    for (const parentId of orders.keys())
      if (!projection.orders.has(parentId)) orders.delete(parentId);
    for (const [parentId, value] of projection.orders) {
      if (orders.get(parentId) !== value) orders.set(parentId, value);
    }
    for (const id of next.tombstones) if (!tombstones.has(id)) tombstones.set(id, true);

    if (operationId) {
      const receipt = next.operations[operationId];
      if (receipt) operations.set(operationId, JSON.stringify(receipt));
    }
  }, "server-structure-operation");
}

export function applyStructuredOperation(
  state: StoredStructureState,
  input: {
    batch: OperationBatch;
    requestHash: string;
    baseRevision: number;
    documentId: string;
    generationId: string;
  },
): { state: StoredStructureState; result: StructureOperationResult } {
  const previous = state.operations[input.batch.operationId];
  if (previous) {
    return {
      state,
      result:
        previous.requestHash === input.requestHash
          ? { status: "duplicate", revision: previous.revision }
          : {
              status: "rejected",
              revision: state.revision,
              code: "operation-id-reused",
            },
    };
  }
  if (input.baseRevision !== state.revision) {
    return {
      state,
      result: { status: "conflict", revision: state.revision, code: "stale-structure-revision" },
    };
  }
  if (Object.keys(state.operations).length >= MAX_OPERATION_RECEIPTS) {
    return {
      state,
      result: { status: "rejected", revision: state.revision, code: "operation-receipt-capacity" },
    };
  }

  const applied = applyOperationBatch(state.content, input.batch, {
    documentId: input.documentId,
    generationId: input.generationId,
  });
  if (!applied.success) {
    return {
      state,
      result: { status: "rejected", revision: state.revision, code: applied.error.code },
    };
  }

  const tombstones = new Set(state.tombstones);
  for (const id of applied.createdBlockIds) {
    if (tombstones.has(id) || applied.deletedBlockIds.includes(id)) {
      return {
        state,
        result: { status: "rejected", revision: state.revision, code: "retired-block-id-reused" },
      };
    }
  }
  for (const id of applied.deletedBlockIds) tombstones.add(id);
  if (tombstones.size > MAX_TOMBSTONES) {
    return {
      state,
      result: { status: "rejected", revision: state.revision, code: "block-id-tombstone-capacity" },
    };
  }

  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    return {
      state,
      result: { status: "rejected", revision: state.revision, code: "structure-revision-capacity" },
    };
  }
  const nextState: StoredStructureState = {
    version: 1,
    revision,
    content: applied.content,
    tombstones: [...tombstones],
    operations: {
      ...state.operations,
      [input.batch.operationId]: { requestHash: input.requestHash, revision },
    },
  };
  if (estimateStructureBytes(nextState) > MAX_STRUCTURE_BYTES) {
    return {
      state,
      result: { status: "rejected", revision: state.revision, code: "structure-state-capacity" },
    };
  }
  return { state: nextState, result: { status: "accepted", revision } };
}
