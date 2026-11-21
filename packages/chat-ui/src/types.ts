import type { ReactNode } from "react";
/** Live status of one streamed tool call shown while a run is in flight. */
export type ToolStepStatus = "running" | "completed" | "failed";
export type MessagePart =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "code"; text: string; language?: string }
  | { id: string; kind: "image"; src: string; alt: string }
  /**
   * Reasoning preview. Preview-only while a run streams; the host never sends it
   * for durable messages. `streaming` keeps the panel open while text still arrives.
   */
  | { id: string; kind: "thinking"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; title: string; status: ToolStepStatus }
  | { id: string; kind: "error"; text: string }
  | {
      id: string;
      kind: "plugin";
      type: string;
      schemaVersion: number;
      fallbackText: string;
      content?: ReactNode;
    };
export interface MessageView {
  id: string;
  role: "user" | "assistant" | "tool";
  parts: readonly MessagePart[];
  status?: string;
  /**
   * Live run stage key for streaming previews (scope/searching/reading/generating/validating).
   * Renders a stage chip; preview text is never a durable answer.
   */
  stage?: string;
}
export type AttachmentKind = "image" | "file";
export type AttachmentStatus = "uploading" | "ready" | "failed";
export interface AttachmentView {
  id: string;
  label: string;
  /** Image attachments render as thumbnails instead of a name chip. */
  kind?: AttachmentKind;
  /** Upload state machine; defaults to "ready" when omitted. */
  status?: AttachmentStatus;
  /** 0–100 upload progress for the uploading state. */
  progress?: number;
  /** Size or dimension hint shown next to the label. */
  meta?: string;
  /** Server-side failure reason surfaced on hover for the failed state. */
  errorText?: string;
  /** Local preview URL for image attachments. */
  thumbnailSrc?: string;
}
/** Shared semantic tones for action cards and badges; dark mode follows the same tokens. */
export type CardTone = "neutral" | "info" | "success" | "warning" | "danger";
