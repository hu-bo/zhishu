import { createContext, useContext } from "react";
import type { EditorController } from "@zhishu/editor-core";
import type { OperationBatch } from "@zhishu/document-contracts";
import type { EditorStore } from "./store.js";

export interface EditorHostServices {
  confirmExternalLink?: (href: string) => boolean;
  openExternalLink?: (href: string) => void | Promise<void>;
  requestUpload?: (file: File, signal: AbortSignal) => Promise<EditorUploadResult>;
  resolveAssetURL?: (assetId: string, signal: AbortSignal) => Promise<string>;
  reportError?: (error: Error) => void;
  requestFeedback?: (
    request: { message: string; blockId?: string },
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

export interface EditorUploadResult {
  assetId: string;
  fileName: string;
  mediaType: string;
}

export interface EditorCollaborationStatus {
  connection: "idle" | "connecting" | "connected" | "reconnecting" | "denied" | "closed";
  sync: "loading" | "catching-up" | "current" | "incompatible";
  persistence?: "clean" | "pending" | "persisted" | "failed" | "unknown";
  durableSeq?: number;
  pendingUpdateCount?: number;
  errorCode?: string;
}

export interface EditorCollaborationPresence {
  clientId: number;
  local: boolean;
  displayName: string;
  color: string;
  selection?: { anchor: string; head: string };
}

export type EditorStructureOperationResult =
  | { status: "accepted" | "duplicate"; revision: number; durableSeq: number }
  | { status: "conflict" | "rejected"; revision: number; durableSeq: number; code: string };

export interface EditorCollaborationSession {
  key: string;
  readOnly: boolean;
  getStatus(): EditorCollaborationStatus;
  subscribe(listener: (status: EditorCollaborationStatus) => void): () => void;
  getPresences?(): readonly EditorCollaborationPresence[];
  subscribePresence?(
    listener: (presences: readonly EditorCollaborationPresence[]) => void,
  ): () => void;
  waitUntilSynced(): Promise<void>;
  getStructureRevision?(): number;
  submitStructureOperation?(batch: OperationBatch): Promise<EditorStructureOperationResult>;
  retry?(): void;
}

export interface EditorInstanceContextValue {
  status: "initializing" | "ready" | "failed";
  controller: EditorController | null;
  error?: Error;
  retry: () => void;
  store: EditorStore;
  hostServices: EditorHostServices;
  collaborationStatus: EditorCollaborationStatus | null;
  collaborationPresences: readonly EditorCollaborationPresence[];
  collaboration: EditorCollaborationSession | null;
}

export const editorContext = createContext<EditorInstanceContextValue | null>(null);

export function useEditorInstance(): EditorInstanceContextValue {
  const value = useContext(editorContext);
  if (!value) throw new Error("useEditorInstance must be used inside EditorProvider.");
  return value;
}

export function useEditorHost(): EditorHostServices {
  return useEditorInstance().hostServices;
}

export function useEditorCollaborationStatus(): EditorCollaborationStatus | null {
  return useEditorInstance().collaborationStatus;
}

export function useEditorCollaborationPresences(): readonly EditorCollaborationPresence[] {
  return useEditorInstance().collaborationPresences;
}
