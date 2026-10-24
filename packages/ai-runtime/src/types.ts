import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { DocumentSnapshot, SnapshotCompatibilityOptions } from "@zhishu/document-contracts";
import type {
  AiTaskEvent,
  AuthoringRequest,
  EvidenceBundle,
  EvidenceItem,
} from "@zhishu/ai-contracts";
export interface GenerationLimits {
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxOutputBytes: number;
  maxModelCalls: number;
  maxSearchCalls: number;
  maxSourceReads: number;
}
export const DEFAULT_GENERATION_LIMITS: Readonly<GenerationLimits> = Object.freeze({
  timeoutMs: 120_000,
  maxInputTokens: 32_768,
  maxOutputTokens: 4_096,
  maxOutputBytes: 32_768,
  maxModelCalls: 12,
  maxSearchCalls: 6,
  maxSourceReads: 6,
});
export interface PromptPolicy {
  id: string;
  version: string;
  systemInstruction: string;
}
export interface AuthoringInput {
  threadId: string;
  request: AuthoringRequest;
  snapshot: DocumentSnapshot;
  /** Trusted application revision, independent of snapshotRevision. */
  structureRevision: number;
  evidence?: EvidenceBundle;
  prompt: PromptPolicy;
  history?: { role: "user" | "assistant"; content: string }[];
}
export interface ResearchHit {
  sourceId: string;
  title: string;
  excerpt: string;
}
export interface ResearchTools {
  searchKnowledge(query: string, signal: AbortSignal): Promise<readonly ResearchHit[]>;
  readSource(sourceId: string, signal: AbortSignal): Promise<readonly EvidenceItem[]>;
}
export interface RuntimeOptions {
  model: BaseChatModel;
  checkpointer: BaseCheckpointSaver;
  limits: GenerationLimits;
  /** Stable provider/model/configuration identity; never include credentials. */
  modelVersion: string;
  researchTools?: ResearchTools;
  countTokens(text: string): number;
  compatibility?: SnapshotCompatibilityOptions;
  verifyEvidence?: (items: readonly EvidenceItem[], signal: AbortSignal) => Promise<boolean>;
  /** Application atomically reserves cumulative run budgets before external calls, including replay. */
  reserveUsage?: (
    input: {
      threadId: string;
      kind: "model" | "search" | "read";
      inputTokens: number;
      maxOutputTokens: number;
    },
    signal: AbortSignal,
  ) => Promise<void>;
}
export interface AuthoringRuntime {
  generate(input: AuthoringInput, signal: AbortSignal): AsyncIterable<AiTaskEvent>;
  resume(input: AuthoringInput, signal: AbortSignal): AsyncIterable<AiTaskEvent>;
}
