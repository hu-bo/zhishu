import type {
  AssistantPluginId,
  AssistantRunContext,
  EvidenceBundle,
  WritingDraftPayload,
  WritingProposalPayload,
} from "@zhishu/ai-contracts";
import type { DshRuntimeOptions, TurnHost, TurnRequest, TurnResult } from "@zhishu/dsh-agent";
import type { PluginRecord } from "@zhishu/dsh-agent/kernel";
import type { AnswerPorts, PlatformResearchPorts } from "@zhishu/ai-plugins/rag";
import type { WebResearchPorts } from "@zhishu/ai-plugins/research";
import type { ScopePorts } from "@zhishu/ai-plugins/scope";
import type { ImagePorts } from "@zhishu/ai-plugins/image";
import type { WebSearchPort } from "@zhishu/ai-plugins/contracts";
import type { DraftInput, WritingInput } from "@zhishu/ai-plugins/types";

/**
 * Unified assistant orchestration types. One DSH execution serves every accepted command;
 * plugins are composed per session and re-checked per Run. Product Runs, budgets, leases
 * and the outbox stay in the application service.
 */

export interface AssistantTurnRequest extends TurnRequest {
  context: AssistantRunContext;
  /**
   * Bounded currently-allowed product history, injected only when initializing a fresh
   * native context (e.g. continuing a pre-unification conversation). Never fabricated turns.
   */
  history?: { role: "user" | "assistant"; content: string }[];
  /** The Run ledger already carries retrieved evidence; skip deterministic pre-retrieval. */
  retrievalDone?: boolean;
}

/** Writing ports resolved by the host from the active turn (live snapshot at generation). */
export interface AssistantWritingPorts {
  buildInput(): Promise<WritingInput | undefined> | WritingInput | undefined;
  buildDraftInput(): DraftInput;
  verify(signal: AbortSignal): Promise<void>;
  save(proposal: WritingProposalPayload, callId: string, signal: AbortSignal): Promise<void>;
  saveDraft(draft: WritingDraftPayload, callId: string, signal: AbortSignal): Promise<void>;
  schemaVersion: number;
  systemInstruction: string;
}

/**
 * Every external effect arrives through host ports. The runtime owns no store, model SDK,
 * credentials or checkpoint; the host implements these against the shared product service.
 */
export interface AssistantPorts {
  scope: ScopePorts;
  platform: PlatformResearchPorts;
  answer: AnswerPorts;
  /** Present only when the server configured a web provider; public entries never get it. */
  web?: { ports: WebResearchPorts; search: WebSearchPort };
  writing: AssistantWritingPorts;
  /** Present only when the server configured image generation and storage. */
  image?: ImagePorts;
  /** Deterministic pre-retrieval for grounded question turns (server-authorized scope). */
  retrieve(query: string, signal: AbortSignal): Promise<EvidenceBundle>;
  /** Idempotent evidence registration bound to the Run ledger. */
  registerEvidence(bundle: EvidenceBundle, stepId: string, signal: AbortSignal): Promise<void>;
}

export interface AssistantRuntimeOptions extends Omit<DshRuntimeOptions, "setup" | "resultText"> {
  /** Flat ports, or a per-conversation factory when the host resolves run state by conversation. */
  ports: AssistantPorts | ((conversationId: string) => AssistantPorts);
}

export interface AssistantSession {
  readonly conversationId: string;
  readonly contextRevision: number;
  readonly nativeSessionId: string;
  execute(request: AssistantTurnRequest, host: TurnHost, signal: AbortSignal): Promise<TurnResult>;
  settle(request: AssistantTurnRequest, host: TurnHost, signal: AbortSignal): Promise<TurnResult>;
  decide(approvalId: string, decision: "allow-once" | "reject"): Promise<void>;
  cancelActive(runId: string): void;
  pluginRecords(): readonly PluginRecord[];
  dispose(): Promise<void>;
}

export interface AssistantRuntime {
  /** Attach the native session for one conversation context revision with its plugin set. */
  attach(input: {
    conversationId: string;
    contextRevision: number;
    nativeSessionId: string;
    restore: boolean;
    plugins: readonly AssistantPluginId[];
  }): Promise<AssistantSession>;
  dispose(): Promise<void>;
}
