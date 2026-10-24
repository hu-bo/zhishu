import type { DocumentSnapshot, SnapshotCompatibilityOptions } from "@zhishu/document-contracts";
import type { AuthoringRequest, EvidenceBundle, EvidenceItem } from "@zhishu/ai-contracts";
export interface WritingInput {
  threadId: string;
  request: AuthoringRequest;
  snapshot: DocumentSnapshot;
  structureRevision: number;
  evidence?: EvidenceBundle;
  prompt: { id: string; version: string; systemInstruction: string };
  history?: { role: "user" | "assistant"; content: string }[];
}
export interface CompilerOptions {
  compatibility?: SnapshotCompatibilityOptions;
  researchTools?: unknown;
  verifyEvidence?: (items: readonly EvidenceItem[], signal: AbortSignal) => Promise<boolean>;
}
