import type { CollaborationPresence, OperationBatch } from "@zhishu/document-contracts";

export type CollaborationSessionInfo = {
  documentId: string;
  generationId: string;
  schemaVersion: number;
  extensions: readonly { name: string; version: string; required: boolean }[];
  compatibility: { readable: true; writable: boolean };
  durableSeq: number;
  documentName: string;
  providerUrl: string;
  token: string;
  expiresAt: string;
  readOnly: boolean;
  capabilities: { durableAck: true; readOnly: true };
};

export type CollaborationConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "denied" | "closed";

export type CollaborationSyncStatus = "loading" | "catching-up" | "current" | "incompatible";
export type CollaborationPersistenceStatus =
  "clean" | "pending" | "persisted" | "failed" | "unknown";

export type CollaborationStatus = {
  connection: CollaborationConnectionStatus;
  sync: CollaborationSyncStatus;
  persistence: CollaborationPersistenceStatus;
  durableSeq: number;
  pendingUpdateCount: number;
  errorCode?: string;
};

export type DurableReceipt = {
  type: "persisted";
  protocolVersion: 1;
  generationId: string;
  updateId: string;
  updateHash: string;
  durableSeq: number;
};

export type StructureOperationResult =
  | {
      type: "structure-operation-result";
      protocolVersion: 1;
      operationId: string;
      status: "accepted" | "duplicate";
      revision: number;
      durableSeq: number;
    }
  | {
      type: "structure-operation-result";
      protocolVersion: 1;
      operationId: string;
      status: "conflict" | "rejected";
      revision: number;
      durableSeq: number;
      code: string;
    };

export type CollaborationStatusListener = (status: CollaborationStatus) => void;

export type CollaborationPresenceInput = Omit<CollaborationPresence, "protocolVersion">;

export type CollaborationPresenceState = CollaborationPresence & {
  clientId: number;
  local: boolean;
};

export type CollaborationPresenceListener = (
  presences: readonly CollaborationPresenceState[],
) => void;

export type { CollaborationPresence, OperationBatch };
