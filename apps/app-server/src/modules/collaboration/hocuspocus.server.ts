import { createHash } from "node:crypto";
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from "@tiptap/y-tiptap";
import {
  createEditorSchema,
  normalizeTiptapDocumentJSON,
  validateContentForEditor,
} from "@zhishu/editor-core/schema";
import { messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { Connection, Server } from "@hocuspocus/server";
import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  validateCollaborationPresence,
  validateDocumentContentForSchemaVersion,
  type OperationBatch,
  type DocumentContent,
} from "@zhishu/document-contracts";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "../../../database/index.js";
import type { AppConfig } from "../../config.js";
import type { OperationsMetrics } from "../health/operations-metrics.js";
import { DocumentRepository } from "../documents/document.repository.js";
import type { CollaborationSessionClaims } from "./session-ticket.js";
import { verifySessionTicket } from "./session-ticket.js";
import {
  applyStructuredOperation,
  readStoredStructureState,
  projectContentUpdateToStructure,
  sameDocumentContent,
  structureMetaMapName,
  structureNodeMapName,
  structureOperationMapName,
  structureOrderMapName,
  structureTombstoneMapName,
  writeStoredStructureState,
  type StoredStructureState,
} from "./structure-operations.js";
import { collaborationOwnerLock } from "./owner-lock.js";
import type { CollaborationOwner } from "./owner.js";
import type { Principal } from "../identity/identity.types.js";
import { DomainError } from "../../shared/domain-error.js";
import { createSessionTicket } from "./session-ticket.js";

type CollaborationContext = { collaborationSession?: CollaborationSessionClaims };
type DurableReceipt = {
  generationId: string;
  updateHash: string;
  durableSeq: number;
  updateBytes: Uint8Array;
};

const pendingReceipts = new WeakMap<Connection<CollaborationContext>, DurableReceipt>();
const pendingDocumentLocks = new WeakMap<Connection<CollaborationContext>, () => void>();
const serverOwnedStructureMapNames = [
  structureMetaMapName,
  structureNodeMapName,
  structureOrderMapName,
  structureTombstoneMapName,
  structureOperationMapName,
] as const;

const structureOperationRequestSchema = z
  .object({
    type: z.literal("structure-operation"),
    protocolVersion: z.literal(1),
    baseStructureRevision: z.number().int().nonnegative().safe(),
    batch: z.unknown(),
  })
  .strict();

function closeError(reason: string, code = 1008): Error & { code: number; reason: string } {
  return Object.assign(new Error(reason), { code, reason });
}

function isCloseError(error: unknown): error is Error & { code: number; reason: string } {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === "number" &&
    typeof (error as Error & { reason?: unknown }).reason === "string"
  );
}

function logStorageFailure(
  event: string,
  documentId: string,
  generationId: string,
  error: unknown,
): void {
  console.error(event, {
    documentId,
    generationId,
    errorType: error instanceof Error ? error.name : "unknown",
  });
}

function injectPostCommitCrash(config: AppConfig, contentChanged = true): void {
  if (!config.COLLABORATION_TEST_CRASH_AFTER_COMMIT || !contentChanged) return;
  process.kill(process.pid, "SIGKILL");
  throw new Error("post-commit-crash-injected");
}

function documentNameFor(documentId: string, generationId: string): string {
  return `${documentId}:${generationId}`;
}

function sameExtensions(
  left: readonly { name: string; version: string; required: boolean }[],
  right: readonly { name: string; version: string; required: boolean }[],
): boolean {
  const normalize = (items: typeof left) =>
    [...items]
      .map((item) => `${item.name}@${item.version}:${item.required ? "required" : "optional"}`)
      .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function hasMeaningfulDocumentContent(content: DocumentContent): boolean {
  if (content.content.length === 0) return false;
  if (content.content.length !== 1) return true;
  const [onlyBlock] = content.content;
  const block = onlyBlock as unknown as {
    type?: unknown;
    content?: unknown;
    marks?: unknown;
  };
  const hasInlineContent = Array.isArray(block.content) && block.content.length > 0;
  const hasMarks = Array.isArray(block.marks) && block.marks.length > 0;
  return block.type !== "paragraph" || hasInlineContent || hasMarks;
}

function parseDocumentName(name: string): { documentId: string; generationId: string } | null {
  const separator = name.lastIndexOf(":");
  if (separator <= 0 || separator === name.length - 1) return null;
  const documentId = name.slice(0, separator);
  const generationId = name.slice(separator + 1);
  if (!/^doc_[A-Za-z0-9_-]{1,64}$/.test(documentId)) return null;
  if (!/^gen_[A-Za-z0-9_-]{1,64}$/.test(generationId)) return null;
  return { documentId, generationId };
}

function updateHash(update: Uint8Array): string {
  return createHash("sha256").update(update).digest("hex");
}

function validateUpdateBytes(update: Uint8Array): void {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, update);
  } catch {
    throw closeError("invalid-yjs-update");
  } finally {
    scratch.destroy();
  }
}

export function projectDocumentContent(
  document: Y.Doc,
  schemaVersion: number = CURRENT_DOCUMENT_SCHEMA_VERSION,
): DocumentContent {
  let projected: Record<string, unknown>;
  try {
    projected = yDocToProsemirrorJSON(document, "content");
  } catch {
    throw closeError("invalid-document-content");
  }
  const normalized = normalizeTiptapDocumentJSON(projected) as Record<string, unknown>;
  const content =
    Array.isArray(normalized.content) || normalized.content !== undefined
      ? normalized
      : { ...normalized, content: [] };
  const validation = validateDocumentContentForSchemaVersion(content, schemaVersion);
  if (!validation.success) throw closeError("invalid-document-content");
  return validation.data;
}

function collectAssetReferences(
  content: DocumentContent,
): Array<{ assetId: string; blockId: string; mediaType: string }> {
  const references: Array<{ assetId: string; blockId: string; mediaType: string }> = [];
  const pending: unknown[] = [...content.content];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const block = value as {
      type?: unknown;
      attrs?: { assetId?: unknown; blockId?: unknown; mediaType?: unknown };
      content?: unknown;
    };
    if (
      (block.type === "image" || block.type === "pdfAttachment") &&
      typeof block.attrs?.assetId === "string" &&
      typeof block.attrs.blockId === "string" &&
      typeof block.attrs.mediaType === "string"
    ) {
      references.push({
        assetId: block.attrs.assetId,
        blockId: block.attrs.blockId,
        mediaType: block.attrs.mediaType,
      });
    }
    if (Array.isArray(block.content)) pending.push(...block.content);
  }
  return references;
}

function writeBodyAndStructureState(
  document: Y.Doc,
  state: StoredStructureState,
  operationId: string,
  schemaVersion: number,
): void {
  const editorValidation = validateContentForEditor(state.content, collaborationEditorSchema);
  if (!editorValidation.success) throw closeError("invalid-document-content");

  document.transact(() => {
    prosemirrorJSONToYXmlFragment(
      collaborationEditorSchema,
      editorValidation.content,
      document.getXmlFragment("content"),
    );
    writeStoredStructureState(document, state, operationId);
  }, "server-structure-operation");

  if (
    !sameDocumentContent(projectDocumentContent(document, schemaVersion), editorValidation.content)
  ) {
    throw closeError("body-structure-projection-mismatch");
  }
}

function createValidatedUpdateCandidate(
  document: Y.Doc,
  updateBytes: Uint8Array,
  schemaVersion: number,
): {
  candidate: Y.Doc;
  baseStateVector: Uint8Array;
  currentContent: DocumentContent;
  nextContent: DocumentContent;
} {
  const baseStateVector = Y.encodeStateVector(document);
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(document), "validation-base");
    Y.applyUpdate(candidate, updateBytes, "validation-candidate");
    return {
      candidate,
      baseStateVector,
      currentContent: projectDocumentContent(document, schemaVersion),
      nextContent: projectDocumentContent(candidate, schemaVersion),
    };
  } catch (error) {
    candidate.destroy();
    if (isCloseError(error)) throw error;
    throw closeError("invalid-document-content");
  }
}

function persistedMessage(receipt: {
  generationId: string;
  updateHash: string;
  durableSeq: number;
}): string {
  return JSON.stringify({
    type: "persisted",
    protocolVersion: 1,
    generationId: receipt.generationId,
    updateHash: receipt.updateHash,
    durableSeq: receipt.durableSeq,
  });
}

function structureOperationMessage(input: {
  operationId: string;
  status: "accepted" | "duplicate" | "conflict" | "rejected";
  revision: number;
  durableSeq: number;
  code?: string;
}): string {
  return JSON.stringify({ type: "structure-operation-result", protocolVersion: 1, ...input });
}

function changesServerOwnedStructure(document: Y.Doc, updateBytes: Uint8Array): boolean {
  const protectedNames = new Set<string>(serverOwnedStructureMapNames);
  const protectedTypes = new Set<unknown>(
    serverOwnedStructureMapNames
      .map((name) => document.share.get(name))
      .filter((value): value is NonNullable<typeof value> => value !== undefined),
  );
  const decoded = Y.decodeUpdate(updateBytes);
  const hasProtectedParent = (parent: unknown): boolean =>
    (typeof parent === "string" && protectedNames.has(parent)) ||
    (typeof parent === "object" && parent !== null && protectedTypes.has(parent));
  const findExistingStruct = (clientId: number, clock: number) =>
    (document.store.clients.get(clientId) ?? []).find(
      (struct) => struct.id.clock <= clock && clock < struct.id.clock + struct.length,
    );
  const referencesProtectedParent = (
    struct: (typeof decoded.structs)[number],
    visited = new Set<string>(),
  ): boolean => {
    if ("parent" in struct && hasProtectedParent(struct.parent)) return true;
    for (const origin of ["origin", "rightOrigin"] as const) {
      const id = "origin" in struct ? struct[origin] : null;
      if (!id) continue;
      const key = `${id.client}:${id.clock}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const existing = findExistingStruct(id.client, id.clock);
      if (existing && referencesProtectedParent(existing, visited)) return true;
    }
    return false;
  };
  // Reconnect sync messages also contain already accepted server-owned items.
  // Only new items can mutate the protected maps.
  if (
    decoded.structs.some(
      (struct) =>
        struct.id.clock + struct.length > Y.getState(document.store, struct.id.client) &&
        referencesProtectedParent(struct),
    )
  )
    return true;
  for (const [clientId, ranges] of decoded.ds.clients) {
    const existingStructs = document.store.clients.get(clientId) ?? [];
    for (const struct of existingStructs) {
      if (struct.deleted) continue;
      if (!referencesProtectedParent(struct)) continue;
      if (
        ranges.some(
          (range) =>
            struct.id.clock < range.clock + range.len &&
            struct.id.clock + struct.length > range.clock,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

async function withDocumentLock<T>(
  key: string,
  tails: Map<string, Promise<void>>,
  work: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const tail = previous.then(() => next);
  tails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    releaseNext();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

async function acquireDocumentLock(
  key: string,
  tails: Map<string, Promise<void>>,
): Promise<() => void> {
  const previous = tails.get(key) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const tail = previous.then(() => next);
  tails.set(key, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseNext();
    if (tails.get(key) === tail) tails.delete(key);
  };
}

const replayRequestSchema = z
  .object({
    type: z.literal("durable-replay"),
    protocolVersion: z.literal(1),
    updateHash: z.string().regex(/^[a-f0-9]{64}$/),
    updateBase64: z.string().min(1),
  })
  .strict();

const collaborationEditorSchema = createEditorSchema({ collaborative: true });

export function createCollaborationServer(
  config: AppConfig,
  db: Database,
  pool: Pool,
  onOwnerLockLost: () => void = () => undefined,
  metrics?: Pick<OperationsMetrics, "setCollaborationState">,
) {
  const repository = new DocumentRepository(db);
  const allowedOrigins = new Set(config.COLLABORATION_ALLOWED_ORIGINS);
  const roomConnections = new Map<string, Set<string>>();
  const socketDocuments = new Map<string, Set<string>>();
  const rawConnections = new Set<import("node:net").Socket>();
  const documentLockTails = new Map<string, Promise<void>>();
  const awarenessUpdateTimes = new WeakMap<Connection<CollaborationContext>, number[]>();
  const maxStatelessPayloadBytes = config.COLLABORATION_MAX_UPDATE_BYTES * 3 + 32_768;
  let ownerLeaseClient: PoolClient | undefined;
  const publishCollaborationMetrics = () => {
    metrics?.setCollaborationState({
      websocketConnections: rawConnections.size,
      activeSessions: [...roomConnections.values()].reduce(
        (total, clients) => total + clients.size,
        0,
      ),
      activeRooms: roomConnections.size,
    });
  };
  const server = new Server<CollaborationContext>({
    port: config.COLLABORATION_PORT,
    address: config.COLLABORATION_HOST,
    stopOnSignals: false,
    websocketOptions: {
      maxPayload: maxStatelessPayloadBytes,
    },
    quiet: true,
    async onUpgrade({ request }) {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) throw closeError("origin-not-allowed");
    },
    async beforeHandleAwareness({ states, connection }) {
      if (!connection) return;
      const presenceStates = [...states.values()].filter(
        (state) => state.zhishu !== undefined && state.zhishu !== null,
      );
      if (presenceStates.length === 0) return;

      const now = Date.now();
      const recentUpdates = (awarenessUpdateTimes.get(connection) ?? []).filter(
        (timestamp) => now - timestamp < 1_000,
      );
      const rateLimited = recentUpdates.length >= 30;
      if (!rateLimited) {
        recentUpdates.push(now);
        awarenessUpdateTimes.set(connection, recentUpdates);
      }

      for (const state of presenceStates) {
        const session = connection.context.collaborationSession;
        const validated = validateCollaborationPresence(state.zhishu);
        if (rateLimited || !session || !validated.success) {
          // Awareness is untrusted, temporary display data; invalid presence never blocks edits.
          delete state.zhishu;
        } else {
          state.zhishu = {
            ...validated.data,
            displayName: session.displayName,
            color: session.presenceColor,
          };
        }
      }
    },
    async onAuthenticate({ documentName, token, connectionConfig, socketId }) {
      const session = verifySessionTicket(token, config.COLLABORATION_TOKEN_SECRET);
      const key = parseDocumentName(documentName);
      if (
        !session ||
        !key ||
        documentNameFor(session.documentId, session.generationId) !== documentName
      ) {
        throw closeError("invalid-collaboration-session");
      }
      let active;
      try {
        active = await repository.findActiveForAction(
          key.documentId,
          session.tenantId,
          session.subject,
          "read",
        );
      } catch (error) {
        logStorageFailure(
          "collaboration-auth-check-failed",
          key.documentId,
          key.generationId,
          error,
        );
        throw closeError("collaboration-auth-check-failed", 1011);
      }
      if (
        !active ||
        active.generationId !== key.generationId ||
        active.tenantId !== session.tenantId ||
        active.schemaVersion !== session.schemaVersion ||
        !sameExtensions(active.extensions, session.extensions)
      ) {
        throw closeError("collaboration-access-revoked");
      }
      if (!reserveRoomConnection(socketId, documentName)) {
        throw closeError("collaboration-capacity-reached", 1013);
      }
      connectionConfig.readOnly = session.readOnly;
      return { collaborationSession: session };
    },
    async onDisconnect({ documentName, socketId }) {
      const documents = socketDocuments.get(socketId);
      if (!documents?.delete(documentName)) return;
      if (documents.size === 0) socketDocuments.delete(socketId);
      const clients = roomConnections.get(documentName);
      clients?.delete(socketId);
      if (clients?.size === 0) roomConnections.delete(documentName);
      publishCollaborationMetrics();
    },
    async onTokenSync({ documentName, token, connection, connectionConfig }) {
      const session = verifySessionTicket(token, config.COLLABORATION_TOKEN_SECRET);
      const key = parseDocumentName(documentName);
      const currentSession = connection.context.collaborationSession;
      if (
        !session ||
        !key ||
        session.documentId !== key.documentId ||
        session.generationId !== key.generationId ||
        !currentSession ||
        session.tenantId !== currentSession.tenantId ||
        session.subject !== currentSession.subject
      ) {
        throw closeError("invalid-collaboration-session");
      }
      let active;
      try {
        active = await repository.findActiveForAction(
          key.documentId,
          session.tenantId,
          session.subject,
          session.readOnly ? "read" : "write",
        );
      } catch (error) {
        logStorageFailure(
          "collaboration-token-check-failed",
          key.documentId,
          key.generationId,
          error,
        );
        throw closeError("collaboration-token-check-failed", 1011);
      }
      if (
        !active ||
        active.generationId !== key.generationId ||
        active.tenantId !== session.tenantId ||
        active.schemaVersion !== session.schemaVersion ||
        !sameExtensions(active.extensions, session.extensions)
      ) {
        throw closeError("collaboration-access-revoked");
      }
      connectionConfig.readOnly = session.readOnly;
      connection.readOnly = session.readOnly;
      return { collaborationSession: session };
    },
    async onLoadDocument({ documentName, context }) {
      const key = parseDocumentName(documentName);
      const session = context.collaborationSession;
      if (
        !key ||
        !session ||
        session.documentId !== key.documentId ||
        session.generationId !== key.generationId
      ) {
        throw closeError("invalid-collaboration-session");
      }
      let active;
      try {
        active = await repository.findActiveForAction(
          key.documentId,
          session.tenantId,
          session.subject,
          "read",
        );
      } catch (error) {
        logStorageFailure(
          "collaboration-load-check-failed",
          key.documentId,
          key.generationId,
          error,
        );
        throw closeError("collaboration-load-failed", 1011);
      }
      if (
        !active ||
        active.generationId !== key.generationId ||
        active.tenantId !== session.tenantId ||
        active.schemaVersion !== session.schemaVersion ||
        !sameExtensions(active.extensions, session.extensions)
      ) {
        throw closeError("collaboration-access-revoked");
      }
      const document = new Y.Doc();
      try {
        await repository.replayYjsState(
          {
            documentId: key.documentId,
            generationId: key.generationId,
            targetSeq: active.durableSeq,
          },
          (updateBytes) => Y.applyUpdate(document, updateBytes, "postgres-replay"),
        );
        return document;
      } catch (error) {
        document.destroy();
        logStorageFailure("collaboration-load-failed", key.documentId, key.generationId, error);
        if (isCloseError(error)) throw error;
        throw closeError("collaboration-load-failed", 1011);
      }
    },
    async beforeSync({ context, document, connection, documentName, type, payload }) {
      if (type !== messageYjsSyncStep2 && type !== messageYjsUpdate) return;
      const key = parseDocumentName(documentName);
      const session = context.collaborationSession;
      if (
        !key ||
        !session ||
        session.documentId !== key.documentId ||
        session.generationId !== key.generationId
      ) {
        throw closeError("invalid-collaboration-session");
      }
      const release = await acquireDocumentLock(documentName, documentLockTails);
      pendingDocumentLocks.set(connection, release);
      if (payload.byteLength > config.COLLABORATION_MAX_UPDATE_BYTES) {
        throw closeError("update-too-large", 1009);
      }

      const updateBytes = Uint8Array.from(payload);
      validateUpdateBytes(updateBytes);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (session.expiresAt <= nowSeconds) throw closeError("collaboration-session-expired");
      let active;
      try {
        active = await repository.findActiveForAction(
          key.documentId,
          session.tenantId,
          session.subject,
          connection.readOnly ? "read" : "write",
        );
      } catch (error) {
        logStorageFailure(
          "collaboration-write-check-failed",
          key.documentId,
          key.generationId,
          error,
        );
        throw closeError("durable-persistence-failed", 1011);
      }
      if (
        !active ||
        active.generationId !== key.generationId ||
        active.tenantId !== session.tenantId ||
        active.schemaVersion !== session.schemaVersion ||
        !sameExtensions(active.extensions, session.extensions)
      ) {
        throw closeError("collaboration-access-revoked");
      }
      if (connection.readOnly) {
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), updateBytes)) {
          throw closeError("read-only-session");
        }
        return;
      }
      if (changesServerOwnedStructure(document, updateBytes)) {
        throw closeError("server-owned-structure");
      }
      const sourceUpdateHash = updateHash(updateBytes);
      const { candidate, baseStateVector, currentContent, nextContent } =
        createValidatedUpdateCandidate(document, updateBytes, session.schemaVersion);
      try {
        const currentStructure = readStoredStructureState(document);
        if (!currentStructure) throw closeError("invalid-structure-state");
        const projection = projectContentUpdateToStructure(
          currentStructure,
          currentContent,
          nextContent,
        );
        if (!projection.success) throw closeError(projection.code);
        if (projection.state !== currentStructure) {
          writeStoredStructureState(candidate, projection.state);
        }

        const persistedUpdateBytes = Y.encodeStateAsUpdate(candidate, baseStateVector);
        validateUpdateBytes(persistedUpdateBytes);
        const persistedUpdateHash = updateHash(persistedUpdateBytes);
        const contentChanged = !sameDocumentContent(currentContent, nextContent);
        try {
          const receipt = await repository.persistUpdate({
            documentId: key.documentId,
            generationId: key.generationId,
            tenantId: session.tenantId,
            subjectId: session.subject,
            updateHash: persistedUpdateHash,
            sourceUpdateHash,
            updateBytes: persistedUpdateBytes,
            content: nextContent,
            assetReferences: collectAssetReferences(nextContent),
            contentChanged:
              contentChanged &&
              (hasMeaningfulDocumentContent(currentContent) ||
                hasMeaningfulDocumentContent(nextContent)),
          });
          injectPostCommitCrash(config, contentChanged);
          pendingReceipts.set(connection, {
            generationId: session.generationId,
            updateHash: receipt.updateHash,
            durableSeq: receipt.durableSeq,
            updateBytes: persistedUpdateBytes,
          });
        } catch (error) {
          logStorageFailure(
            "collaboration-update-persistence-failed",
            key.documentId,
            key.generationId,
            error,
          );
          throw closeError("durable-persistence-failed", 1011);
        }
      } finally {
        candidate.destroy();
      }
    },
    async afterHandleMessage({ document, connection, context }) {
      const release = pendingDocumentLocks.get(connection);
      pendingDocumentLocks.delete(connection);
      const receipt = pendingReceipts.get(connection);
      try {
        if (!receipt) return;
        pendingReceipts.delete(connection);
        const session = context.collaborationSession;
        if (!session || session.generationId !== receipt.generationId) return;
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), receipt.updateBytes)) {
          Y.applyUpdate(document, receipt.updateBytes, "server-content-projection");
        }
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), receipt.updateBytes)) return;
        document.broadcastStateless(persistedMessage(receipt));
      } catch {
        return;
      } finally {
        release?.();
      }
    },
    async onStateless({ document, documentName, payload, connection }) {
      if (payload.length > maxStatelessPayloadBytes) return;
      let input: unknown;
      try {
        input = JSON.parse(payload);
      } catch {
        return;
      }
      const structureRequest = structureOperationRequestSchema.safeParse(input);
      if (structureRequest.success) {
        const batch = structureRequest.data.batch as Partial<OperationBatch> | null;
        const operationId =
          typeof batch?.operationId === "string" &&
          /^op_[A-Za-z0-9_-]{1,64}$/.test(batch.operationId)
            ? batch.operationId
            : undefined;
        if (!operationId) return;
        await withDocumentLock(documentName, documentLockTails, async () => {
          const session = connection.context.collaborationSession;
          const key = parseDocumentName(documentName);
          if (
            !session ||
            !key ||
            session.expiresAt <= Math.floor(Date.now() / 1000) ||
            session.documentId !== key.documentId ||
            session.generationId !== key.generationId
          ) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: 0,
                durableSeq: 0,
                code: "session-expired",
              }),
            );
            return;
          }
          const active = await repository.findActiveForAction(
            key.documentId,
            session.tenantId,
            session.subject,
            "write",
          );
          if (
            !active ||
            active.generationId !== key.generationId ||
            active.tenantId !== session.tenantId ||
            active.schemaVersion !== session.schemaVersion ||
            !sameExtensions(active.extensions, session.extensions)
          ) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: 0,
                durableSeq: active?.durableSeq ?? 0,
                code: "access-revoked",
              }),
            );
            return;
          }
          if (connection.readOnly) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: 0,
                durableSeq: active.durableSeq,
                code: "read-only",
              }),
            );
            return;
          }

          const currentState = readStoredStructureState(document);
          if (!currentState) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: 0,
                durableSeq: active.durableSeq,
                code: "invalid-structure-state",
              }),
            );
            return;
          }
          const currentContent = projectDocumentContent(document, session.schemaVersion);
          if (currentState.revision === 0 && currentContent.content.length > 0) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: currentState.revision,
                durableSeq: active.durableSeq,
                code: "structure-projection-not-initialized",
              }),
            );
            return;
          }
          if (!sameDocumentContent(currentState.content, currentContent)) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: currentState.revision,
                durableSeq: active.durableSeq,
                code: "structure-projection-out-of-sync",
              }),
            );
            return;
          }

          const requestHash = createHash("sha256")
            .update(
              JSON.stringify({
                baseStructureRevision: structureRequest.data.baseStructureRevision,
                batch: structureRequest.data.batch,
              }),
            )
            .digest("hex");
          let applied: ReturnType<typeof applyStructuredOperation>;
          try {
            applied = applyStructuredOperation(currentState, {
              batch: structureRequest.data.batch as OperationBatch,
              requestHash,
              baseRevision: structureRequest.data.baseStructureRevision,
              documentId: key.documentId,
              generationId: key.generationId,
            });
          } catch {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: currentState.revision,
                durableSeq: active.durableSeq,
                code: "invalid-operation",
              }),
            );
            return;
          }
          if (applied.result.status !== "accepted") {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                ...applied.result,
                durableSeq: active.durableSeq,
              }),
            );
            return;
          }

          const baseVector = Y.encodeStateVector(document);
          const scratch = new Y.Doc();
          let updateBytes: Uint8Array;
          try {
            Y.applyUpdate(scratch, Y.encodeStateAsUpdate(document));
            writeBodyAndStructureState(scratch, applied.state, operationId, session.schemaVersion);
            updateBytes = Y.encodeStateAsUpdate(scratch, baseVector);
          } catch (error) {
            logStorageFailure(
              "collaboration-structure-projection-failed",
              key.documentId,
              key.generationId,
              error,
            );
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: currentState.revision,
                durableSeq: active.durableSeq,
                code: "structure-update-invalid",
              }),
            );
            return;
          } finally {
            scratch.destroy();
          }
          if (updateBytes.byteLength > config.COLLABORATION_MAX_UPDATE_BYTES) {
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: currentState.revision,
                durableSeq: active.durableSeq,
                code: "structure-update-too-large",
              }),
            );
            return;
          }
          const hash = updateHash(updateBytes);
          let receipt: { updateHash: string; durableSeq: number };
          try {
            const persisted = await repository.persistUpdate({
              documentId: key.documentId,
              generationId: key.generationId,
              tenantId: session.tenantId,
              subjectId: session.subject,
              updateHash: hash,
              updateBytes,
              content: applied.state.content,
              assetReferences: collectAssetReferences(applied.state.content),
              contentChanged: true,
            });
            injectPostCommitCrash(config);
            receipt = { updateHash: persisted.updateHash, durableSeq: persisted.durableSeq };
          } catch (error) {
            logStorageFailure(
              "collaboration-structure-persistence-failed",
              key.documentId,
              key.generationId,
              error,
            );
            connection.sendStateless(
              structureOperationMessage({
                operationId,
                status: "rejected",
                revision: currentState.revision,
                durableSeq: active.durableSeq,
                code: "durable-persistence-failed",
              }),
            );
            return;
          }

          Y.applyUpdate(document, updateBytes, "server-structure-operation");
          document.broadcastStateless(
            persistedMessage({ generationId: key.generationId, ...receipt }),
          );
          connection.sendStateless(
            structureOperationMessage({
              operationId,
              ...applied.result,
              durableSeq: receipt.durableSeq,
            }),
          );
        });
        return;
      }
      const parsed = replayRequestSchema.safeParse(input);
      if (!parsed.success) return;

      const session = connection.context.collaborationSession;
      const key = parseDocumentName(documentName);
      if (
        !session ||
        !key ||
        session.expiresAt <= Math.floor(Date.now() / 1000) ||
        session.documentId !== key.documentId ||
        session.generationId !== key.generationId
      ) {
        connection.sendStateless(
          JSON.stringify({
            type: "persistence-error",
            protocolVersion: 1,
            code: "session-expired",
            updateHash: parsed.data.updateHash,
          }),
        );
        return;
      }

      const bytes = Buffer.from(parsed.data.updateBase64, "base64url");
      if (
        bytes.byteLength > config.COLLABORATION_MAX_UPDATE_BYTES ||
        bytes.toString("base64url") !== parsed.data.updateBase64 ||
        updateHash(bytes) !== parsed.data.updateHash
      ) {
        connection.sendStateless(
          JSON.stringify({
            type: "persistence-error",
            protocolVersion: 1,
            code: "invalid-replay",
            updateHash: parsed.data.updateHash,
          }),
        );
        return;
      }
      try {
        validateUpdateBytes(bytes);
        if (!Y.snapshotContainsUpdate(Y.snapshot(document), bytes)) {
          connection.sendStateless(
            JSON.stringify({
              type: "persistence-pending",
              protocolVersion: 1,
              updateHash: parsed.data.updateHash,
            }),
          );
          return;
        }
        const current = await repository.findActiveForAction(
          key.documentId,
          session.tenantId,
          session.subject,
          "write",
        );
        if (
          !current ||
          current.generationId !== key.generationId ||
          current.tenantId !== session.tenantId ||
          current.schemaVersion !== session.schemaVersion ||
          !sameExtensions(current.extensions, session.extensions)
        ) {
          connection.sendStateless(
            JSON.stringify({
              type: "persistence-error",
              protocolVersion: 1,
              code: "access-revoked",
              updateHash: parsed.data.updateHash,
            }),
          );
          return;
        }
        const existingReceipt = await repository.findUpdateReceipt(
          key.documentId,
          key.generationId,
          parsed.data.updateHash,
        );
        connection.sendStateless(
          persistedMessage({
            generationId: key.generationId,
            updateHash: parsed.data.updateHash,
            durableSeq: existingReceipt?.durableSeq ?? current.durableSeq,
          }),
        );
      } catch (error) {
        logStorageFailure(
          "collaboration-update-replay-failed",
          key.documentId,
          key.generationId,
          error,
        );
        connection.sendStateless(
          JSON.stringify({
            type: "persistence-error",
            protocolVersion: 1,
            code: "durable-persistence-failed",
            updateHash: parsed.data.updateHash,
          }),
        );
      }
    },
  });

  server.httpServer.on("connection", (socket) => {
    if (rawConnections.size >= config.COLLABORATION_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    rawConnections.add(socket);
    publishCollaborationMetrics();
    socket.once("close", () => {
      rawConnections.delete(socket);
      publishCollaborationMetrics();
    });
  });

  const reserveRoomConnection = (socketId: string, documentName: string): boolean => {
    const documents = socketDocuments.get(socketId) ?? new Set<string>();
    if (documents.has(documentName)) return true;
    if (documents.size >= config.COLLABORATION_MAX_DOCUMENTS_PER_CONNECTION) return false;

    const clients = roomConnections.get(documentName);
    if (!clients && roomConnections.size >= config.COLLABORATION_MAX_ACTIVE_ROOMS) return false;
    if (clients && clients.size >= config.COLLABORATION_MAX_ROOM_CONNECTIONS) return false;

    documents.add(documentName);
    socketDocuments.set(socketId, documents);
    const nextClients = clients ?? new Set<string>();
    nextClients.add(socketId);
    roomConnections.set(documentName, nextClients);
    publishCollaborationMetrics();
    return true;
  };

  const releaseOwnerLock = async (): Promise<void> => {
    const client = ownerLeaseClient;
    ownerLeaseClient = undefined;
    if (!client) return;
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        collaborationOwnerLock.namespace,
        collaborationOwnerLock.resource,
      ]);
    } finally {
      client.release();
    }
  };

  const acquireOwnerLock = async (): Promise<void> => {
    const client = await pool.connect();
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [collaborationOwnerLock.namespace, collaborationOwnerLock.resource],
      );
      if (!result.rows[0]?.locked) {
        throw new Error("Another collaboration server already owns this database.");
      }
      ownerLeaseClient = client;
      const handleOwnerLockLost = () => {
        if (ownerLeaseClient !== client) return;
        ownerLeaseClient = undefined;
        client.release(true);
        void server.destroy().catch(() => undefined);
        onOwnerLockLost();
      };
      client.once("error", handleOwnerLockLost);
      client.once("end", handleOwnerLockLost);
    } catch (error) {
      client.release();
      throw error;
    }
  };

  const openOwnedDocument = async (principal: Principal, documentId: string) => {
    if (!ownerLeaseClient) throw new DomainError("SERVICE_UNAVAILABLE", "协同服务尚未就绪");
    const active = await repository.findActiveForAction(
      documentId,
      principal.tenantId,
      principal.identityId,
      "read",
    );
    if (!active) throw new DomainError("NOT_FOUND", "文档不存在或无权访问");
    const { claims } = createSessionTicket(
      {
        tenantId: principal.tenantId,
        documentId,
        generationId: active.generationId,
        schemaVersion: active.schemaVersion,
        extensions: active.extensions,
        subject: principal.identityId,
        displayName: principal.displayName.slice(0, 80) || "成员",
        presenceColor: "#6366f1",
        readOnly: true,
      },
      config.COLLABORATION_TOKEN_SECRET,
      300,
    );
    const direct = await server.hocuspocus.openDirectConnection(
      documentNameFor(documentId, active.generationId),
      { collaborationSession: claims },
    );
    if (!direct.document) throw new DomainError("CONFLICT", "文档会话已关闭");
    return { active, direct, document: direct.document };
  };
  const owner: CollaborationOwner = {
    async snapshot(principal, documentId) {
      return withDocumentLock(documentId, documentLockTails, async () => {
        const loaded = await openOwnedDocument(principal, documentId);
        try {
          // Use the same generation lock as websocket text and structural commands.
          return await withDocumentLock(
            documentNameFor(documentId, loaded.active.generationId),
            documentLockTails,
            async () => {
              const active = await repository.findActiveForAction(
                documentId,
                principal.tenantId,
                principal.identityId,
                "read",
              );
              if (!active || active.generationId !== loaded.active.generationId)
                throw new DomainError("CONFLICT", "文档版本已变化，请重试");
              if (!active.workspaceId) throw new DomainError("CONFLICT", "文档尚未归属空间");
              const state = readStoredStructureState(loaded.document);
              const content = projectDocumentContent(loaded.document, active.schemaVersion);
              if (!state || !sameDocumentContent(state.content, content))
                throw new DomainError("CONFLICT", "正文正在同步，请稍后重试");
              return {
                snapshot: {
                  documentId,
                  generationId: active.generationId,
                  durableSeq: active.durableSeq,
                  schemaVersion: active.schemaVersion,
                  extensions: active.extensions,
                  snapshotRevision: Math.max(1, active.durableSeq),
                  content,
                },
                structureRevision: state.revision,
                workspaceId: active.workspaceId,
                title: active.title,
              };
            },
          );
        } finally {
          await loaded.direct.disconnect();
        }
      });
    },
    async apply(input) {
      const { batch, principal } = input;
      const documentName = documentNameFor(batch.documentId, batch.generationId);
      return withDocumentLock(documentName, documentLockTails, async () => {
        const requestHash = createHash("sha256")
          .update(JSON.stringify({ baseStructureRevision: input.baseStructureRevision, batch }))
          .digest("hex");
        const receiptKey = createHash("sha256")
          .update(`conditional:${batch.generationId}:${batch.operationId}:${requestHash}`)
          .digest("hex");
        const previous = await repository.findUpdateReceipt(
          batch.documentId,
          batch.generationId,
          receiptKey,
        );
        if (previous)
          return {
            operationId: batch.operationId,
            generationId: batch.generationId,
            durableSeq: previous.durableSeq,
            structureRevision: input.baseStructureRevision + 1,
          };
        const loaded = await openOwnedDocument(principal, batch.documentId);
        try {
          if (
            loaded.active.generationId !== batch.generationId ||
            loaded.active.durableSeq !== input.expectedDurableSeq
          )
            throw new DomainError("CONFLICT", "文档已更新，本次未写入。草稿已保留。");
          const state = readStoredStructureState(loaded.document);
          if (
            !state ||
            !sameDocumentContent(
              state.content,
              projectDocumentContent(loaded.document, loaded.active.schemaVersion),
            )
          )
            throw new DomainError("CONFLICT", "正文结构已变化");
          const applied = applyStructuredOperation(state, {
            batch,
            requestHash,
            baseRevision: input.baseStructureRevision,
            documentId: batch.documentId,
            generationId: batch.generationId,
          });
          if (applied.result.status !== "accepted")
            throw new DomainError("CONFLICT", "文档已更新，本次未写入。草稿已保留。");
          const scratch = new Y.Doc();
          let updateBytes: Uint8Array;
          try {
            Y.applyUpdate(scratch, Y.encodeStateAsUpdate(loaded.document));
            writeBodyAndStructureState(
              scratch,
              applied.state,
              batch.operationId,
              loaded.active.schemaVersion,
            );
            updateBytes = Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(loaded.document));
          } finally {
            scratch.destroy();
          }
          if (updateBytes.byteLength > config.COLLABORATION_MAX_UPDATE_BYTES)
            throw new DomainError("VALIDATION_ERROR", "生成内容超出写入限制");
          const persisted = await repository.persistUpdate({
            documentId: batch.documentId,
            generationId: batch.generationId,
            tenantId: principal.tenantId,
            subjectId: principal.identityId,
            updateHash: updateHash(updateBytes),
            sourceUpdateHash: receiptKey,
            updateBytes,
            content: applied.state.content,
            contentChanged: true,
            assetReferences: collectAssetReferences(applied.state.content),
            expectedDurableSeq: input.expectedDurableSeq,
            guard: input.guard,
            record: (tx, durableSeq) =>
              input.record(tx, {
                operationId: batch.operationId,
                generationId: batch.generationId,
                durableSeq,
                structureRevision: applied.result.revision,
              }),
          });
          Y.applyUpdate(loaded.document, updateBytes, "server-structure-operation");
          loaded.document.broadcastStateless(
            persistedMessage({
              generationId: batch.generationId,
              updateHash: persisted.updateHash,
              durableSeq: persisted.durableSeq,
            }),
          );
          return {
            operationId: batch.operationId,
            generationId: batch.generationId,
            durableSeq: persisted.durableSeq,
            structureRevision: applied.result.revision,
          };
        } finally {
          await loaded.direct.disconnect();
        }
      });
    },
  };
  return {
    owner,
    async listen() {
      if (ownerLeaseClient) throw new Error("Collaboration server is already listening.");
      await acquireOwnerLock();
      try {
        await server.listen();
      } catch (error) {
        await releaseOwnerLock();
        throw error;
      }
    },
    async close() {
      try {
        await server.destroy();
      } finally {
        await releaseOwnerLock();
      }
    },
    revokeDocumentSessions(documentId: string, generationId: string): void {
      server.hocuspocus.closeConnections(documentNameFor(documentId, generationId));
    },
    address: () => server.address,
  };
}
