import type { DocumentSnapshot, SnapshotCompatibilityOptions } from "@zhishu/document-contracts";
import type {
  DocumentVersion,
  EvidenceArtifactResolver,
  WritingRequest,
  EvidenceBundle,
} from "@zhishu/ai-contracts";

/**
 * Pure writing input. The application owns the thread and run identities; the proposal
 * payload never copies them. This type must stay free of DSH, LangChain and database
 * references so the compiler sub-entry can be consumed independently.
 */
export interface WritingInput {
  /** Stable per-conversation thread identity used for deterministic Block IDs. */
  threadId: string;
  /** Run identity: proposal content binds to it externally, never inside the payload. */
  runId: string;
  /** Target baseline captured in the Run context at admission. */
  document: DocumentVersion;
  baseStructureRevision: number;
  request: WritingRequest;
  snapshot: DocumentSnapshot & { generationId: string; durableSeq: number };
  evidence?: EvidenceBundle;
  prompt: { id: string; version: string; systemInstruction: string };
  /** Only the currently allowed turns; the host rebuilds this after any revision change. */
  history?: { role: "user" | "assistant"; content: string }[];
}
export interface CompilerOptions {
  compatibility?: SnapshotCompatibilityOptions;
  researchAvailable?: boolean;
  webAvailable?: boolean;
  /** Resolves an evidenceId to its committed artifact id; citations must carry it. */
  artifactResolver?: EvidenceArtifactResolver;
}
