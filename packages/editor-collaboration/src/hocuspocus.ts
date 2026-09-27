import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { validateCollaborationPresence } from "@zhishu/document-contracts";
import type { CollaborationPresence, OperationBatch } from "@zhishu/document-contracts";
import type {
  CollaborationPresenceInput,
  CollaborationPresenceListener,
  CollaborationPresenceState,
  CollaborationSessionInfo,
  CollaborationStatus,
  CollaborationStatusListener,
  DurableReceipt,
  StructureOperationResult,
} from "./index.js";

type PendingUpdate = { updateId: string; updateBytes: Uint8Array };
type PersistedMessage = {
  type: "persisted";
  protocolVersion: 1;
  generationId: string;
  updateHash: string;
  durableSeq: number;
};
type StatelessMessage =
  | PersistedMessage
  | StructureOperationResult
  | { type: "persistence-error"; protocolVersion: 1; code: string; updateHash: string }
  | { type: "persistence-pending"; protocolVersion: 1; updateHash: string };

type PendingStructureOperation = {
  resolve: (result: StructureOperationResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type SessionTicketMetadata = {
  tenantId: string;
  subject: string;
  documentId: string;
  generationId: string;
  schemaVersion: number;
  extensions: readonly { name: string; version: string; required: boolean }[];
  readOnly: boolean;
  expiresAt: number;
};

const presenceField = "zhishu";
const minPresenceUpdateIntervalMs = 100;

function decodeRelativePositionToken(token: string): void {
  const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  Y.decodeRelativePosition(bytes);
}

function readPresence(value: unknown): CollaborationPresence | null {
  const result = validateCollaborationPresence(value);
  if (!result.success) return null;
  try {
    if (result.data.selection) {
      decodeRelativePositionToken(result.data.selection.anchor);
      decodeRelativePositionToken(result.data.selection.head);
    }
    return result.data;
  } catch {
    return null;
  }
}

// The server authenticates the HMAC; the client only compares principal scope across refreshes.
function readSessionTicketMetadata(token: string): SessionTicketMetadata | null {
  if (token.length > 4096) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || !/^[A-Za-z0-9_-]{43}$/u.test(signature) || extra !== undefined)
    return null;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.audience !== "document-collaboration" ||
      typeof value.tenantId !== "string" ||
      typeof value.subject !== "string" ||
      typeof value.documentId !== "string" ||
      typeof value.generationId !== "string" ||
      typeof value.schemaVersion !== "number" ||
      !Array.isArray(value.extensions) ||
      typeof value.readOnly !== "boolean" ||
      typeof value.expiresAt !== "number"
    ) {
      return null;
    }
    return value as unknown as SessionTicketMetadata;
  } catch {
    return null;
  }
}

function ticketMatchesSession(
  ticket: SessionTicketMetadata | null,
  session: CollaborationSessionInfo,
): ticket is SessionTicketMetadata {
  return (
    ticket !== null &&
    ticket.documentId === session.documentId &&
    ticket.generationId === session.generationId &&
    ticket.schemaVersion === session.schemaVersion &&
    ticket.readOnly === session.readOnly &&
    JSON.stringify(ticket.extensions) === JSON.stringify(session.extensions) &&
    Math.floor(Date.parse(session.expiresAt) / 1000) === ticket.expiresAt
  );
}

export type HocuspocusSessionOptions = {
  document: Y.Doc;
  session: CollaborationSessionInfo;
  supportedSchemaVersions?: readonly number[];
  supportedExtensions?: readonly { name: string; version: string }[];
  refreshSession?: () => Promise<CollaborationSessionInfo>;
  onPendingUpdate?: (updateId: string) => void;
  onPersisted?: (receipt: DurableReceipt) => void;
  onError?: (code: string) => void;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hashUpdate(update: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("secure-crypto-unavailable");
  const digestInput = Uint8Array.from(update);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", digestInput.buffer as ArrayBuffer),
  );
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function parseStateless(payload: string): StatelessMessage | null {
  if (payload.length > 1024) return null;
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (value.protocolVersion !== 1 || typeof value.type !== "string") return null;
    if (
      value.type === "persisted" &&
      typeof value.generationId === "string" &&
      typeof value.updateHash === "string" &&
      /^[a-f0-9]{64}$/u.test(value.updateHash) &&
      typeof value.durableSeq === "number" &&
      Number.isSafeInteger(value.durableSeq) &&
      value.durableSeq >= 0
    ) {
      return value as unknown as PersistedMessage;
    }
    if (
      value.type === "structure-operation-result" &&
      typeof value.operationId === "string" &&
      /^op_[A-Za-z0-9_-]{1,64}$/.test(value.operationId) &&
      ["accepted", "duplicate", "conflict", "rejected"].includes(String(value.status)) &&
      typeof value.revision === "number" &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      typeof value.durableSeq === "number" &&
      Number.isSafeInteger(value.durableSeq) &&
      value.durableSeq >= 0 &&
      (value.status === "accepted" ||
        value.status === "duplicate" ||
        typeof value.code === "string")
    ) {
      return value as StructureOperationResult;
    }
    if (
      value.type === "persistence-error" &&
      typeof value.code === "string" &&
      typeof value.updateHash === "string" &&
      /^[a-f0-9]{64}$/u.test(value.updateHash)
    ) {
      return value as StatelessMessage;
    }
    if (value.type === "persistence-pending" && typeof value.updateHash === "string") {
      return value as StatelessMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export class HocuspocusCollaborationSession {
  readonly provider: HocuspocusProvider;
  readonly key: string;
  private readonly pending = new Map<string, PendingUpdate>();
  private readonly acknowledgedBeforeHash = new Map<string, PersistedMessage>();
  private readonly errorsBeforeHash = new Map<string, string>();
  private readonly persisted = new Map<string, DurableReceipt>();
  private readonly failedUpdateIds = new Set<string>();
  private readonly listeners = new Set<CollaborationStatusListener>();
  private readonly presenceListeners = new Set<CollaborationPresenceListener>();
  private readonly options: HocuspocusSessionOptions;
  private state: CollaborationStatus;
  private destroyed = false;
  private hashingCount = 0;
  private currentSession: CollaborationSessionInfo;
  private readonly principalBinding: { tenantId: string; subject: string };
  private sessionRefreshTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingStructureOperations = new Map<string, PendingStructureOperation>();
  private waitingForReconnect?: (event: { status: string }) => void;
  private localPresence: CollaborationPresence | null = null;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private lastPresenceUpdateAt = 0;
  private readonly onAwarenessChange = () => {
    if (this.destroyed) return;
    const presences = this.getPresences();
    for (const listener of this.presenceListeners) {
      this.invokeConsumer(() => listener(presences));
    }
  };
  private readonly onDocumentUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this.provider || this.destroyed) return;
    if (this.currentSession.readOnly) {
      this.publish({ persistence: "failed", errorCode: "read-only-session" });
      this.reportError("read-only-session");
      return;
    }
    this.hashingCount += 1;
    this.publish({ persistence: "pending" });
    let hashingReleased = false;
    void hashUpdate(update)
      .then((updateHash) => {
        if (this.destroyed) {
          this.hashingCount -= 1;
          hashingReleased = true;
          return;
        }
        const updateId = `${this.currentSession.generationId}:${updateHash}`;
        const earlyReceipt = this.acknowledgedBeforeHash.get(updateHash);
        if (earlyReceipt) {
          this.acknowledgedBeforeHash.delete(updateHash);
          this.failedUpdateIds.delete(updateId);
          const receipt = { ...earlyReceipt, updateId };
          this.rememberPersisted(receipt);
          this.hashingCount -= 1;
          hashingReleased = true;
          this.invokeConsumer(() => this.options.onPersisted?.(receipt));
          this.publish({
            durableSeq: Math.max(this.state.durableSeq, earlyReceipt.durableSeq),
            persistence:
              this.pending.size === 0 && this.hashingCount === 0 ? "persisted" : "pending",
          });
          return;
        }
        const earlyError = this.errorsBeforeHash.get(updateHash);
        if (earlyError) this.errorsBeforeHash.delete(updateHash);
        this.hashingCount -= 1;
        hashingReleased = true;
        this.pending.set(updateHash, { updateId, updateBytes: Uint8Array.from(update) });
        if (earlyError) {
          this.failedUpdateIds.add(updateId);
          this.publish({ persistence: "failed", errorCode: earlyError });
        } else {
          this.publish({ persistence: "pending", pendingUpdateCount: this.pending.size });
        }
        this.invokeConsumer(() => this.options.onPendingUpdate?.(updateId));
        if (!earlyError && this.provider.isSynced) this.requestPendingReplay();
      })
      .catch(() => {
        this.publish({ persistence: "failed", errorCode: "update-hash-failed" });
        this.reportError("update-hash-failed");
      })
      .finally(() => {
        if (!hashingReleased) this.hashingCount -= 1;
        if (this.destroyed) return;
        if (
          this.hashingCount === 0 &&
          this.pending.size === 0 &&
          this.state.persistence === "pending"
        ) {
          this.publish({
            persistence: this.state.durableSeq > 0 ? "persisted" : "clean",
            pendingUpdateCount: 0,
          });
        } else {
          this.publish({});
        }
      });
  };

  constructor(options: HocuspocusSessionOptions) {
    this.options = options;
    this.currentSession = options.session;
    this.key = `${options.session.documentId}:${options.session.generationId}`;
    const ticket = readSessionTicketMetadata(options.session.token);
    if (!ticketMatchesSession(ticket, options.session)) {
      throw new TypeError("The collaboration session ticket does not match its session metadata.");
    }
    this.principalBinding = { tenantId: ticket.tenantId, subject: ticket.subject };
    if (
      options.session.compatibility?.readable !== true ||
      options.session.compatibility.writable === options.session.readOnly
    ) {
      throw new TypeError("The collaboration session is not compatible for reading.");
    }
    if (options.session.capabilities.durableAck !== true) {
      throw new TypeError("The selected Provider does not support durable acknowledgements.");
    }
    if (!(options.supportedSchemaVersions ?? [1]).includes(options.session.schemaVersion)) {
      throw new TypeError("The session document uses an unsupported content schema.");
    }
    const supportedExtensions = new Set(
      (options.supportedExtensions ?? []).map(
        (extension) => `${extension.name}@${extension.version}`,
      ),
    );
    if (
      options.session.extensions.some(
        (extension) =>
          extension.required && !supportedExtensions.has(`${extension.name}@${extension.version}`),
      )
    ) {
      throw new TypeError("The session requires an unsupported document extension.");
    }
    this.state = {
      connection: "idle",
      sync: "loading",
      persistence: "clean",
      durableSeq: options.session.durableSeq,
      pendingUpdateCount: 0,
    };
    options.document.on("update", this.onDocumentUpdate);
    this.provider = new HocuspocusProvider({
      url: options.session.providerUrl,
      name: options.session.documentName,
      document: options.document,
      token: async () => {
        if (!options.refreshSession) return this.currentSession.token;
        const refreshed = await options.refreshSession();
        const refreshedTicket = readSessionTicketMetadata(refreshed.token);
        if (
          !ticketMatchesSession(refreshedTicket, refreshed) ||
          refreshedTicket.tenantId !== this.principalBinding.tenantId ||
          refreshedTicket.subject !== this.principalBinding.subject
        ) {
          throw new Error("collaboration-principal-changed");
        }
        if (
          refreshed.documentId !== this.currentSession.documentId ||
          refreshed.generationId !== this.currentSession.generationId ||
          refreshed.documentName !== this.currentSession.documentName ||
          refreshed.schemaVersion !== this.currentSession.schemaVersion ||
          JSON.stringify(refreshed.extensions) !== JSON.stringify(this.currentSession.extensions) ||
          refreshed.providerUrl !== this.currentSession.providerUrl ||
          refreshed.compatibility?.readable !== true ||
          refreshed.compatibility.writable === refreshed.readOnly
        ) {
          throw new Error("collaboration-generation-changed");
        }
        this.currentSession = refreshed;
        this.scheduleSessionRefresh();
        this.publish({});
        return refreshed.token;
      },
      flushDelay: false,
      onStatus: ({ status }) => {
        if (
          this.destroyed ||
          this.state.connection === "denied" ||
          this.state.connection === "closed"
        )
          return;
        const connection =
          status === "connected"
            ? "connected"
            : status === "connecting"
              ? "connecting"
              : "reconnecting";
        this.publish({ connection });
        if (connection === "connected") this.republishPresence();
        if (connection !== "connected" && this.pending.size + this.hashingCount > 0)
          this.publish({ persistence: "unknown" });
      },
      onSynced: ({ state }) => {
        if (this.destroyed) return;
        this.publish({ sync: state ? "current" : "catching-up" });
        if (state) this.requestPendingReplay();
      },
      onStateless: ({ payload }) => this.handleStateless(payload),
      onAuthenticationFailed: ({ reason }) => {
        if (this.destroyed) return;
        this.publish({ connection: "denied", sync: "incompatible", errorCode: reason });
        this.reportError(reason);
      },
      onClose: ({ event }) => {
        if (this.destroyed) return;
        if (this.pending.size + this.hashingCount > 0) this.publish({ persistence: "unknown" });
        if (
          event.code === 1008 ||
          event.code === 4401 ||
          event.code === 4403 ||
          (event.reason !== "" && event.reason !== "Server closed the connection")
        ) {
          this.publish({ connection: "denied", errorCode: event.reason || "access-denied" });
        }
      },
    });
    this.provider.awareness?.on("change", this.onAwarenessChange);
    this.scheduleSessionRefresh();
    this.provider.connect();
  }

  getStatus(): CollaborationStatus {
    return { ...this.state };
  }

  getPendingUpdateIds(): string[] {
    return [...this.pending.values()].map((update) => update.updateId);
  }

  get readOnly(): boolean {
    return this.currentSession.readOnly;
  }

  waitUntilSynced(timeoutMs = 15_000): Promise<void> {
    const initial = this.getStatus();
    if (initial.connection === "connected" && initial.sync === "current") return Promise.resolve();
    if (
      initial.connection === "denied" ||
      initial.connection === "closed" ||
      initial.sync === "incompatible"
    ) {
      return Promise.reject(new Error(initial.errorCode ?? "collaboration-session-unavailable"));
    }

    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => {};
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error("collaboration-sync-timeout")), timeoutMs);
      const listener: CollaborationStatusListener = (status) => {
        if (status.connection === "connected" && status.sync === "current") finish();
        else if (
          status.connection === "denied" ||
          status.connection === "closed" ||
          status.sync === "incompatible"
        ) {
          finish(new Error(status.errorCode ?? "collaboration-session-unavailable"));
        }
      };
      this.listeners.add(listener);
      unsubscribe = () => this.listeners.delete(listener);
      listener(this.getStatus());
    });
  }

  getStructureRevision(): number {
    const meta = this.options.document.getMap<unknown>("zhishu.structure.v1");
    const revision = meta.get("revision");
    if (revision === undefined && meta.get("version") === undefined) return 0;
    if (meta.get("version") !== 1) throw new Error("invalid-structure-state");
    if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) {
      return revision;
    }
    throw new Error("invalid-structure-state");
  }

  submitStructureOperation(
    batch: OperationBatch,
    baseStructureRevision?: number,
    timeoutMs = 15_000,
  ): Promise<StructureOperationResult> {
    if (this.destroyed) return Promise.reject(new Error("collaboration-session-closed"));
    if (this.currentSession.readOnly)
      return Promise.reject(new Error("collaboration-session-read-only"));
    if (this.state.connection !== "connected" || this.state.sync !== "current") {
      return Promise.reject(new Error("collaboration-session-not-current"));
    }
    if (
      batch.documentId !== this.currentSession.documentId ||
      (batch.generationId !== undefined && batch.generationId !== this.currentSession.generationId)
    ) {
      return Promise.reject(new Error("stale-collaboration-generation"));
    }
    let revision: number;
    try {
      revision = baseStructureRevision ?? this.getStructureRevision();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("invalid-structure-state"));
    }
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return Promise.reject(new TypeError("baseStructureRevision must be a non-negative integer."));
    }
    if (this.pendingStructureOperations.has(batch.operationId)) {
      return Promise.reject(new Error("structure-operation-already-pending"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingStructureOperations.delete(batch.operationId);
        reject(new Error("structure-operation-timeout"));
      }, timeoutMs);
      this.pendingStructureOperations.set(batch.operationId, { resolve, reject, timeout });
      try {
        this.provider.sendStateless(
          JSON.stringify({
            type: "structure-operation",
            protocolVersion: 1,
            baseStructureRevision: revision,
            batch,
          }),
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pendingStructureOperations.delete(batch.operationId);
        reject(error instanceof Error ? error : new Error("structure-operation-send-failed"));
      }
    });
  }

  subscribe(listener: CollaborationStatusListener): () => void {
    this.listeners.add(listener);
    this.invokeConsumer(() => listener(this.getStatus()));
    return () => this.listeners.delete(listener);
  }

  getPresences(): CollaborationPresenceState[] {
    const awareness = this.provider.awareness;
    if (!awareness) return [];
    const presences: CollaborationPresenceState[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      const presence = readPresence(state[presenceField]);
      if (!presence) continue;
      presences.push({ ...presence, clientId, local: clientId === awareness.clientID });
    }
    return presences.sort((left, right) => left.clientId - right.clientId);
  }

  subscribePresence(listener: CollaborationPresenceListener): () => void {
    this.presenceListeners.add(listener);
    this.invokeConsumer(() => listener(this.getPresences()));
    return () => this.presenceListeners.delete(listener);
  }

  setPresence(presence: CollaborationPresenceInput | null): void {
    if (this.destroyed) throw new Error("collaboration-session-closed");
    if (presence === null) {
      this.localPresence = null;
      this.withdrawPresence();
      return;
    }
    const result = validateCollaborationPresence({ protocolVersion: 1, ...presence });
    if (!result.success) throw new TypeError("invalid-collaboration-presence");
    const normalized = readPresence(result.data);
    if (!normalized) throw new TypeError("invalid-collaboration-presence");
    this.localPresence = normalized;
    this.schedulePresenceUpdate();
  }

  async waitForPersisted(
    updateIds?: readonly string[],
    timeoutMs = 10_000,
  ): Promise<{
    status: "persisted" | "pending" | "failed";
    durableSeq: number;
  }> {
    const requested = updateIds ? new Set(updateIds) : null;
    const isComplete = () =>
      requested
        ? [...requested].every((id) => this.persisted.has(id))
        : this.pending.size === 0 && this.hashingCount === 0;
    const hasFailed = () =>
      requested
        ? [...requested].some((id) => this.failedUpdateIds.has(id))
        : this.state.persistence === "failed";
    if (isComplete()) return { status: "persisted", durableSeq: this.state.durableSeq };
    if (hasFailed()) return { status: "failed", durableSeq: this.state.durableSeq };

    return new Promise((resolve) => {
      const listener: CollaborationStatusListener = () => {
        if (isComplete()) finish("persisted");
        else if (hasFailed()) finish("failed");
      };
      const finish = (status: "persisted" | "pending" | "failed") => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve({ status, durableSeq: this.state.durableSeq });
      };
      const timer = setTimeout(() => finish("pending"), timeoutMs);
      this.listeners.add(listener);
    });
  }

  disconnect(): void {
    if (this.destroyed) return;
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = undefined;
    }
    this.withdrawPresence();
    this.provider.disconnect();
    this.publish({ connection: "closed" });
  }

  retry(): void {
    if (this.destroyed) return;
    this.publish({ connection: "connecting", sync: "loading", errorCode: undefined });
    const websocket = this.provider.configuration.websocketProvider;
    const connect = () =>
      void websocket.connect().catch(() => {
        if (!this.destroyed) this.publish({ connection: "reconnecting" });
      });
    if (this.waitingForReconnect) websocket.off("status", this.waitingForReconnect);
    if (websocket.status === "disconnected") {
      connect();
      return;
    }
    this.waitingForReconnect = ({ status }) => {
      if (status !== "disconnected") return;
      websocket.off("status", this.waitingForReconnect!);
      this.waitingForReconnect = undefined;
      connect();
    };
    websocket.on("status", this.waitingForReconnect);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = undefined;
    }
    this.options.document.off("update", this.onDocumentUpdate);
    this.withdrawPresence();
    this.provider.awareness?.off("change", this.onAwarenessChange);
    if (this.waitingForReconnect) {
      this.provider.configuration.websocketProvider.off("status", this.waitingForReconnect);
      this.waitingForReconnect = undefined;
    }
    this.provider.destroy();
    for (const [operationId, pending] of this.pendingStructureOperations) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("collaboration-session-closed"));
      this.pendingStructureOperations.delete(operationId);
    }
    if (this.pending.size > 0) this.publish({ persistence: "unknown" });
    this.publish({ connection: "closed" });
    this.listeners.clear();
    this.presenceListeners.clear();
  }

  private schedulePresenceUpdate(): void {
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    const delay = Math.max(
      0,
      minPresenceUpdateIntervalMs - (Date.now() - this.lastPresenceUpdateAt),
    );
    if (delay === 0) {
      this.writeLocalPresence();
      return;
    }
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.writeLocalPresence();
    }, delay);
  }

  private scheduleSessionRefresh(): void {
    if (this.sessionRefreshTimer) clearTimeout(this.sessionRefreshTimer);
    this.sessionRefreshTimer = undefined;
    const expiresAt = Date.parse(this.currentSession.expiresAt);
    const now = Date.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      this.expireSession("collaboration-session-expired");
      return;
    }
    const remainingMs = expiresAt - now;
    const renewBeforeMs = Math.min(30_000, remainingMs / 2);
    const delay = this.options.refreshSession ? remainingMs - renewBeforeMs : remainingMs;
    this.sessionRefreshTimer = setTimeout(
      () => {
        this.sessionRefreshTimer = undefined;
        if (this.destroyed) return;
        if (!this.options.refreshSession) {
          this.expireSession("collaboration-session-expired");
          return;
        }
        void this.provider.sendToken().catch(() => {
          this.expireSession("collaboration-session-refresh-failed");
        });
      },
      Math.max(0, delay),
    );
  }

  private expireSession(errorCode: string): void {
    if (this.destroyed) return;
    this.publish({
      connection: "denied",
      sync: "incompatible",
      errorCode,
      persistence: this.pending.size + this.hashingCount > 0 ? "unknown" : this.state.persistence,
    });
    this.provider.configuration.websocketProvider.disconnect();
  }

  private writeLocalPresence(): void {
    if (this.destroyed) return;
    const awareness = this.provider.awareness;
    if (!awareness || !this.localPresence) return;
    awareness.setLocalStateField(presenceField, structuredClone(this.localPresence));
    this.lastPresenceUpdateAt = Date.now();
  }

  private republishPresence(): void {
    if (!this.localPresence) return;
    const existing = this.provider.awareness?.getLocalState()?.[presenceField];
    if (JSON.stringify(existing) !== JSON.stringify(this.localPresence)) this.writeLocalPresence();
  }

  private withdrawPresence(): void {
    if (this.presenceTimer) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = undefined;
    }
    const awareness = this.provider.awareness;
    const localValue = awareness?.getLocalState()?.[presenceField];
    if (awareness && localValue !== undefined && localValue !== null) {
      awareness.setLocalStateField(presenceField, null);
    }
  }

  private requestPendingReplay(): void {
    if (this.currentSession.readOnly) return;
    for (const [updateHash, update] of this.pending) {
      try {
        this.provider.sendStateless(
          JSON.stringify({
            type: "durable-replay",
            protocolVersion: 1,
            updateHash,
            updateBase64: toBase64Url(update.updateBytes),
          }),
        );
      } catch {
        this.publish({ persistence: "unknown", errorCode: "update-replay-send-failed" });
        this.reportError("update-replay-send-failed");
        return;
      }
    }
  }

  private handleStateless(payload: string): void {
    if (this.destroyed) return;
    const message = parseStateless(payload);
    if (!message) return;
    if (message.type === "structure-operation-result") {
      const pending = this.pendingStructureOperations.get(message.operationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingStructureOperations.delete(message.operationId);
      pending.resolve(message);
      return;
    }
    if (message.type === "persisted") {
      if (message.generationId !== this.currentSession.generationId) return;
      this.errorsBeforeHash.delete(message.updateHash);
      this.failedUpdateIds.delete(`${message.generationId}:${message.updateHash}`);
      const update = this.pending.get(message.updateHash);
      if (update) {
        this.pending.delete(message.updateHash);
        this.failedUpdateIds.delete(update.updateId);
        const receipt = {
          ...message,
          updateId: update.updateId,
        };
        this.rememberPersisted(receipt);
        this.invokeConsumer(() => this.options.onPersisted?.(receipt));
      } else if (this.hashingCount > 0) {
        this.acknowledgedBeforeHash.set(message.updateHash, message);
        if (this.acknowledgedBeforeHash.size > 256) {
          const oldestHash = this.acknowledgedBeforeHash.keys().next().value;
          if (oldestHash) this.acknowledgedBeforeHash.delete(oldestHash);
        }
      }
      this.publish({
        durableSeq: Math.max(this.state.durableSeq, message.durableSeq),
        pendingUpdateCount: this.pending.size,
        persistence: this.pending.size === 0 && this.hashingCount === 0 ? "persisted" : "pending",
      });
      return;
    }
    if (message.type === "persistence-pending") {
      this.publish({ persistence: "pending" });
      return;
    }
    const failedUpdate = this.pending.get(message.updateHash);
    if (failedUpdate) this.failedUpdateIds.add(failedUpdate.updateId);
    else if (this.hashingCount > 0) {
      this.errorsBeforeHash.set(message.updateHash, message.code);
      if (this.errorsBeforeHash.size > 256) {
        const oldestHash = this.errorsBeforeHash.keys().next().value;
        if (oldestHash) this.errorsBeforeHash.delete(oldestHash);
      }
    }
    this.publish({ persistence: "failed", errorCode: message.code });
    this.reportError(message.code);
  }

  private publish(update: Partial<CollaborationStatus>): void {
    this.state = {
      ...this.state,
      ...update,
      pendingUpdateCount: this.pending.size + this.hashingCount,
    };
    for (const listener of this.listeners) {
      this.invokeConsumer(() => listener(this.getStatus()));
    }
  }

  private rememberPersisted(receipt: DurableReceipt): void {
    this.persisted.set(receipt.updateId, receipt);
    if (this.persisted.size > 512) {
      const oldestUpdateId = this.persisted.keys().next().value;
      if (oldestUpdateId) this.persisted.delete(oldestUpdateId);
    }
  }

  private reportError(code: string): void {
    this.invokeConsumer(() => this.options.onError?.(code));
  }

  private invokeConsumer(callback: () => void): void {
    try {
      callback();
    } catch {
      // Consumer callbacks must not interrupt collaboration state transitions.
    }
  }
}
