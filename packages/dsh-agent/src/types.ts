import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentOptions } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { PluginRecord } from "@deepseek-ai/dsh-session";
import type { ChatSnapshot, ChatEvent, Run } from "@zhishu/chat-contracts";

/** Engine delivery identities are durable before inbox insertion. Never browser input. */
export interface ChatRecord {
  snapshot: ChatSnapshot;
  deliveries: Record<string, UserMessage>;
  engineCreated?: boolean;
  configurationId?: string;
}
export interface ChatLease {
  load(): Promise<ChatRecord | undefined>;
  /** Atomic state + outbox commit; reject after writer ownership is lost. */
  commit(record: ChatRecord, event: ChatEvent): Promise<void>;
  close(): Promise<void>;
}
export interface ChatStore {
  acquire(conversationId: string): Promise<ChatLease>;
}
export interface RuntimeOptions {
  store: ChatStore;
  /** Must install an official SessionPersistence provider in required mode. */
  configure(ctx: Context): Promise<void>;
  persistence: "required" | "ephemeral";
  agentOptions: AgentOptions;
  configurationId?: string;
  setup?(ctx: Context, agent: Agent, conversationId: string): Promise<void> | void;
  /** Trusted plugin output, read from the native log after its turn closes. */
  resultText?(records: readonly PluginRecord[], run: Run): string | undefined;
  authorize?(conversationId: string): Promise<void>;
  limits?: Partial<{
    maxSessions: number;
    maxQueued: number;
    maxMessages: number;
    timeoutMs: number;
    maxModelCalls: number;
    maxInputBytes: number;
    maxOutputBytes: number;
  }>;
  onError?(code: string, conversationId: string): void;
}
export class DshRuntimeError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
