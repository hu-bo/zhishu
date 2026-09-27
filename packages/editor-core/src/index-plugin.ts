import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";
import type { DocumentBlock } from "@zhishu/document-contracts";

export type EditorLimitExceededReason = "document-size" | "document-nodes" | "transaction-steps";

interface PositionEntry {
  position: number;
  version: number;
}

interface BlockIndexState {
  entries: ReadonlyMap<string, PositionEntry>;
  headingIds: ReadonlySet<string>;
  nodeCount: number;
  mappings: readonly Mapping[];
  version: number;
}

export interface IndexedBlock {
  id: string;
  type: string;
  position: number;
  json: DocumentBlock;
}

const maxMappingHistory = 128;
const maxDocumentContentSize = 2 * 1024 * 1024;
const maxDocumentNodes = 20_000;
const maxTransactionSteps = 256;
const blockIndexKey = new PluginKey<BlockIndexState>("zhishuBlockIndex");
const transactionNodeCountDeltas = new WeakMap<Transaction, number>();

function readId(node: { attrs: Record<string, unknown> }): string | undefined {
  const id = node.attrs.blockId;
  return typeof id === "string" ? id : undefined;
}

function indexDocument(doc: ProseMirrorNode): {
  entries: Map<string, PositionEntry>;
  headingIds: Set<string>;
  nodeCount: number;
} {
  const entries = new Map<string, PositionEntry>();
  const headingIds = new Set<string>();
  let nodeCount = 1;
  doc.descendants((node, position) => {
    nodeCount += 1;
    const id = readId(node);
    if (id) {
      entries.set(id, { position, version: 0 });
      if (node.type.name === "heading") headingIds.add(id);
    }
  });
  return { entries, headingIds, nodeCount };
}

function nodesInChangedRange(
  doc: ProseMirrorNode,
  start: number,
  end: number,
): Set<ProseMirrorNode> {
  const from = Math.max(0, start - 1);
  const to = Math.min(doc.content.size, Math.max(end, start + 1) + 1);
  const nodes = new Set<ProseMirrorNode>();
  doc.nodesBetween(from, to, (node) => {
    nodes.add(node);
  });
  return nodes;
}

function transactionNodeCountDelta(transaction: Transaction): number {
  let delta = 0;
  transaction.mapping.maps.forEach((stepMap, mapIndex) => {
    const before = transaction.docs[mapIndex];
    const after = transaction.docs[mapIndex + 1] ?? transaction.doc;
    if (!before) return;
    const previousNodes = new Set<ProseMirrorNode>();
    const nextNodes = new Set<ProseMirrorNode>();
    stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
      for (const node of nodesInChangedRange(before, oldStart, oldEnd)) previousNodes.add(node);
      for (const node of nodesInChangedRange(after, newStart, newEnd)) nextNodes.add(node);
    });
    for (const node of previousNodes) if (!nextNodes.has(node)) delta -= 1;
    for (const node of nextNodes) if (!previousNodes.has(node)) delta += 1;
  });
  return delta;
}

function updateChangedRanges(
  doc: ProseMirrorNode,
  transaction: Transaction,
  entries: Map<string, PositionEntry>,
  headingIds: Set<string>,
  version: number,
): void {
  const mapping = transaction.mapping;
  mapping.maps.forEach((stepMap, mapIndex) => {
    const previousDoc = transaction.docs[mapIndex];
    const laterMaps = mapping.slice(mapIndex + 1);
    stepMap.forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (previousDoc) {
        const oldFrom = Math.max(0, oldStart - 1);
        const oldTo = Math.min(previousDoc.content.size, Math.max(oldEnd, oldStart + 1) + 1);
        previousDoc.nodesBetween(oldFrom, oldTo, (node) => {
          const id = readId(node);
          if (id) {
            entries.delete(id);
            if (node.type.name === "heading") headingIds.delete(id);
          }
        });
      }
      const from = Math.max(0, laterMaps.map(newStart, -1) - 1);
      const to = Math.min(doc.content.size, laterMaps.map(newEnd, 1) + 1);
      doc.nodesBetween(from, to, (node, position) => {
        const id = readId(node);
        if (id) {
          entries.set(id, { position, version });
          if (node.type.name === "heading") headingIds.add(id);
          else headingIds.delete(id);
        }
      });
    });
  });
}

export function createBlockIndexExtension(
  onLimitExceeded?: (reason: EditorLimitExceededReason) => void,
): Extension {
  return Extension.create({
    name: "zhishuBlockIndex",
    addProseMirrorPlugins() {
      let lastReportedLimit: EditorLimitExceededReason | undefined;
      return [
        new Plugin<BlockIndexState>({
          key: blockIndexKey,
          filterTransaction: (transaction, state) => {
            if (!transaction.docChanged) return true;
            const previous = blockIndexKey.getState(state);
            if (!previous) return true;

            let limit: EditorLimitExceededReason | undefined;
            if (transaction.steps.length > maxTransactionSteps) limit = "transaction-steps";
            else if (transaction.doc.content.size > maxDocumentContentSize) limit = "document-size";
            else {
              const delta = transactionNodeCountDelta(transaction);
              transactionNodeCountDeltas.set(transaction, delta);
              if (previous.nodeCount + delta > maxDocumentNodes) limit = "document-nodes";
            }

            if (limit) {
              if (lastReportedLimit !== limit) onLimitExceeded?.(limit);
              lastReportedLimit = limit;
              return false;
            }
            lastReportedLimit = undefined;
            return true;
          },
          state: {
            init: (_config, state) => ({
              ...indexDocument(state.doc),
              mappings: [],
              version: 0,
            }),
            apply: (transaction, previous, _oldState, newState) => {
              if (!transaction.docChanged) return previous;
              const version = previous.version + 1;
              const entries = new Map(previous.entries);
              const headingIds = new Set(previous.headingIds);
              const mappings = [...previous.mappings, transaction.mapping];
              updateChangedRanges(newState.doc, transaction, entries, headingIds, version);
              const delta =
                transactionNodeCountDeltas.get(transaction) ??
                transactionNodeCountDelta(transaction);
              transactionNodeCountDeltas.delete(transaction);
              const nodeCount = previous.nodeCount + delta;

              if (mappings.length > maxMappingHistory) {
                return { ...indexDocument(newState.doc), mappings: [], version: 0 };
              }
              return { entries, headingIds, nodeCount, mappings, version };
            },
          },
        }),
      ];
    },
  });
}

function resolveEntry(
  editor: Editor,
  id: string,
  entry: PositionEntry,
  state: BlockIndexState,
): IndexedBlock | undefined {
  let position = entry.position;
  for (let version = entry.version; version < state.version; version += 1) {
    const mapping = state.mappings[version];
    if (!mapping) return undefined;
    position = mapping.map(position, 1);
  }
  const node = editor.state.doc.nodeAt(position);
  const nodeId = node ? readId(node) : undefined;
  if (!node || nodeId !== id) return undefined;
  return { id: nodeId, type: node.type.name, position, json: node.toJSON() as DocumentBlock };
}

export function findIndexedBlock(editor: Editor, id: string): IndexedBlock | undefined {
  const state = blockIndexKey.getState(editor.state);
  const entry = state?.entries.get(id);
  return state && entry ? resolveEntry(editor, id, entry, state) : undefined;
}

export function getIndexedBlocks(editor: Editor): IndexedBlock[] {
  const state = blockIndexKey.getState(editor.state);
  if (!state) return [];
  const blocks: IndexedBlock[] = [];
  for (const [id, entry] of state.entries) {
    const block = resolveEntry(editor, id, entry, state);
    if (block) blocks.push(block);
  }
  return blocks.sort((left, right) => left.position - right.position);
}

export function getIndexedHeadings(editor: Editor): IndexedBlock[] {
  const state = blockIndexKey.getState(editor.state);
  if (!state) return [];
  const headings: IndexedBlock[] = [];
  for (const id of state.headingIds) {
    const entry = state.entries.get(id);
    if (!entry) continue;
    const heading = resolveEntry(editor, id, entry, state);
    if (heading?.type === "heading") headings.push(heading);
  }
  return headings.sort((left, right) => left.position - right.position);
}
