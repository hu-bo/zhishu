import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { PluginRecord } from "@deepseek-ai/dsh-session";
import type { WritingProposalPayload, WritingRunContext } from "@zhishu/ai-contracts";

/**
 * Native writing execution types. This package drives the official DSH kernel only.
 * Product Runs, messages, artifacts and events are owned by the shared application
 * service; the kernel reports transitions through WritingTurnHost callbacks.
 */

export class WritingRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "WritingRuntimeError";
  }
}

export type NativeApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface TurnIdentity {
  conversationId: string;
  runId: string;
  attempt: number;
  contextRevision: number;
}

/** One execution turn handed from the host to the native runtime. */
export interface WritingTurnRequest extends TurnIdentity {
  inputText: string;
  /** Deterministic native session id for (conversation, contextRevision). */
  nativeSessionId: string;
  /**
   * Native user message identity. Persisted by the host before delivery so a crash can
   * re-deliver the same idempotent message, never a duplicated turn.
   */
  plannedNativeMessageId?: string;
  deliveryConfirmed?: boolean;
  /** Known native turn from a previous attempt, used for restart settle without redelivery. */
  knownTurn?: number;
  deadlineAtMs: number;
  /** Purpose payload for tools: capture, intent, web flags and reference artifacts. */
  context: WritingRunContext;
}

export interface WritingApprovalRequest extends TurnIdentity {
  approvalId: string;
  action: string;
  description?: string;
  expiresAt: string;
}

export type TurnStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface WritingTurnResult extends TurnIdentity {
  status: TurnStatus;
  errorCode?: string;
  nativeMessageId: string;
  deliveryConfirmed: boolean;
  turn?: number;
  /** Trusted output text: plugin record result or assistant text, already size-checked. */
  resultText?: string;
  /** Native turn executed tools; automatic replay of side effects stays blocked. */
  hasToolFacts: boolean;
  /** Proposals compiled by tools during this turn. */
  proposals: readonly WritingProposalPayload[];
  pluginRecords: readonly PluginRecord[];
}

/** All product persistence happens host-side; the runtime aborts when a callback throws. */
export interface WritingTurnHost {
  /** Current authorization and revision check before each model request. */
  authorize(turn: TurnIdentity): Promise<void>;
  /** Budgeted model-call reservation with fencing; throwing stops the kernel request. */
  reserveModelCall(turn: TurnIdentity): Promise<void>;
  onDeliveryPlanned(turn: TurnIdentity, nativeMessageId: string): Promise<void>;
  onDeliveryConfirmed(turn: TurnIdentity, nativeMessageId: string): Promise<void>;
  /** Persist waiting-approval plus the approval DTO; resolution arrives via decide(). */
  onApprovalRequested(request: WritingApprovalRequest): Promise<void>;
  onApprovalResolved(
    request: WritingApprovalRequest,
    outcome: NativeApprovalOutcome,
  ): Promise<void>;
  /** Live preview frames only; durable delivery never depends on these. */
  emitPreview(
    turn: TurnIdentity,
    frame: { streamEpoch: string; revision: number; index: number; text: string },
  ): void;
}

/** Read-only turn access handed to tool installers so tools resolve run-specific inputs. */
export interface WritingSessionAccess {
  readonly conversationId: string;
  readonly contextRevision: number;
  /** The active turn or undefined between turns; tools must fail when absent. */
  currentTurn(): WritingTurnRequest | undefined;
  /** Compile-stage proposal capture; the host persists the artifact at settle. */
  captureProposal(proposal: WritingProposalPayload): void;
}

export interface WritingRuntimeOptions {
  configure(ctx: Context): Promise<void>;
  /** "required" installs an official SessionPersistence in configure; ephemeral is test-only. */
  persistence: "required" | "ephemeral";
  agentOptions: AgentOptions;
  configurationId?: string;
  /** Per-session tool and prompt assembly, run inputs resolved via the session access. */
  setup?(ctx: Context, agent: Agent, access: WritingSessionAccess): Promise<void> | void;
  /** Trusted proposal record for output text fallbacks; validated by the host when persisting. */
  resultText?(records: readonly PluginRecord[], turnText: string): string | undefined;
  limits?: Partial<{
    maxSessions: number;
    maxModelCalls: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  }>;
  onError?(code: string, conversationId: string): void;
}

export interface NativeWritingSession {
  readonly conversationId: string;
  readonly contextRevision: number;
  readonly nativeSessionId: string;
  execute(
    request: WritingTurnRequest,
    host: WritingTurnHost,
    signal: AbortSignal,
  ): Promise<WritingTurnResult>;
  /** Reconcile an unfinished run from the native log without a new model turn. */
  settle(
    request: WritingTurnRequest,
    host: WritingTurnHost,
    signal: AbortSignal,
  ): Promise<WritingTurnResult>;
  decide(approvalId: string, decision: "allow-once" | "reject"): Promise<void>;
  cancelActive(runId: string): void;
  pluginRecords(): readonly PluginRecord[];
  dispose(): Promise<void>;
}

export interface WritingRuntime {
  /** Attach (create or resume) the native session for one conversation context revision. */
  attach(input: {
    conversationId: string;
    contextRevision: number;
    nativeSessionId: string;
    restore: boolean;
  }): Promise<NativeWritingSession>;
  dispose(): Promise<void>;
}
