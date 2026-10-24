import type { ReactNode } from "react";
export type MessagePart =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "code"; text: string; language?: string }
  | { id: string; kind: "image"; src: string; alt: string }
  | { id: string; kind: "tool"; title: string; status: string }
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
}
export interface AttachmentView {
  id: string;
  label: string;
  status?: string;
}
