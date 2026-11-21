import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { PluginRecord } from "@deepseek-ai/dsh-session";

/**
 * Native execution types. This package drives the official DSH kernel only and knows no
 * product purpose. Runs, messages, artifacts and events are owned by the application
 * service; the kernel reports transitions through TurnHost callbacks.
 */

export class DshRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DshRuntimeError";
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
export interface TurnRequest extends TurnIdentity {
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
  /** Host-owned run context for tools; the kernel never interprets it. */
  context: unknown;
}

export interface ApprovalRequest extends TurnIdentity {
  approvalId: string;
  action: string;
  description?: string;
  expiresAt: string;
}

export type TurnStatus = "completed" | "failed" | "cancelled" | "interrupted";

export interface TurnResult extends TurnIdentity {
  status: TurnStatus;
  errorCode?: string;
  nativeMessageId: string;
  deliveryConfirmed: boolean;
  turn?: number;
  /** Trusted output text: plugin record result or assistant text, already size-checked. */
  resultText?: string;
  /** Adapter-reported token accounting for this turn; absent when the provider reports none. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Native turn executed tools; automatic replay of side effects stays blocked. */
  hasToolFacts: boolean;
  pluginRecords: readonly PluginRecord[];
}

/** Live preview frame kinds: dense text/thinking deltas plus tool-call process facts. */
export type PreviewChannel = "text" | "thinking" | "tool" | "tool-args";

export interface PreviewToolFact {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
}

/** All product persistence happens host-side; the runtime aborts when a callback throws. */
export interface TurnHost {
  /** Current authorization and revision check before each model request. */
  authorize(turn: TurnIdentity): Promise<void>;
  /** Budgeted model-call reservation with fencing; throwing stops the kernel request. */
  reserveModelCall(turn: TurnIdentity): Promise<void>;
  onDeliveryPlanned(turn: TurnIdentity, nativeMessageId: string): Promise<void>;
  onDeliveryConfirmed(turn: TurnIdentity, nativeMessageId: string): Promise<void>;
  /** Persist waiting-approval plus the approval DTO; resolution arrives via decide(). */
  onApprovalRequested(request: ApprovalRequest): Promise<void>;
  onApprovalResolved(request: ApprovalRequest, outcome: NativeApprovalOutcome): Promise<void>;
  /**
   * Live preview frames only; durable delivery never depends on these.
   * "text" carries model-visible text deltas, "thinking" carries reasoning deltas,
   * "tool-args" carries raw streamed tool arguments (host decides what is presentable),
   * and "tool" is the committed tool lifecycle with no text.
   */
  emitPreview(
    turn: TurnIdentity,
    frame: {
      streamEpoch: string;
      revision: number;
      index: number;
      text: string;
      channel: PreviewChannel;
      tool?: PreviewToolFact;
    },
  ): void;
}

/** Read-only turn access handed to tool installers so tools resolve run-specific inputs. */
export interface SessionAccess {
  readonly conversationId: string;
  readonly contextRevision: number;
  /** The active turn or undefined between turns; tools must fail when absent. */
  currentTurn(): TurnRequest | undefined;
}

export interface DshRuntimeOptions {
  configure(ctx: Context): Promise<void>;
  /** "required" installs an official SessionPersistence in configure; ephemeral is test-only. */
  persistence: "required" | "ephemeral";
  agentOptions: AgentOptions;
  configurationId?: string;
  /** Per-session tool and prompt assembly, run inputs resolved via the session access. */
  setup?(ctx: Context, agent: Agent, access: SessionAccess): Promise<void> | void;
  /** Trusted plugin record result for output text fallbacks; validated by the host when persisting. */
  resultText?(records: readonly PluginRecord[], turnText: string): string | undefined;
  limits?: Partial<{
    maxSessions: number;
    /** Idle sessions are disposed after this long without turn activity (default 10 minutes). */
    sessionIdleMs: number;
    maxModelCalls: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  }>;
  /**
   * Hosts may still observe an idle session (live SSE); retained sessions are skipped by
   * idle eviction and LRU, never by capacity limits on busy sessions.
   */
  retainSession?(nativeSessionId: string): boolean;
  /** A session detached (dispose or eviction); hosts must drop cached handles. Idempotent. */
  onSessionDetached?(nativeSessionId: string): void;
  onError?(code: string, conversationId: string): void;
}

export interface NativeSession {
  readonly conversationId: string;
  readonly contextRevision: number;
  readonly nativeSessionId: string;
  execute(request: TurnRequest, host: TurnHost, signal: AbortSignal): Promise<TurnResult>;
  /** Reconcile an unfinished run from the native log without a new model turn. */
  settle(request: TurnRequest, host: TurnHost, signal: AbortSignal): Promise<TurnResult>;
  /**
   * Record a deterministic exchange (user input plus trusted fixed answer) into the native
   * log without any model call. Idempotent for an already recorded planned message id.
   */
  recordExchange(request: TurnRequest, host: TurnHost, text: string): Promise<TurnResult>;
  decide(approvalId: string, decision: "allow-once" | "reject"): Promise<void>;
  cancelActive(runId: string): void;
  pluginRecords(): readonly PluginRecord[];
  dispose(): Promise<void>;
}

export interface DshRuntime {
  /** Attach (create or resume) the native session for one conversation context revision. */
  attach(input: {
    conversationId: string;
    contextRevision: number;
    nativeSessionId: string;
    restore: boolean;
  }): Promise<NativeSession>;
  dispose(): Promise<void>;
}
