/**
 * DSH kernel primitives hosts need to plug product persistence and models into the
 * runtime the kernel owns (`apps/app-server` consumes them only through this module,
 * so no app package depends on @deepseek-ai directly).
 */
export type { Context } from "@deepseek-ai/cordis";
export type { Agent } from "@deepseek-ai/dsh-agent";
export { LlmAdapter, ToolCallId, type GenerateOptions } from "@deepseek-ai/dsh-llm";
export {
  SessionLogOffset,
  type PluginRecord,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
export {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  SessionHandleClosedError,
  SessionReadOnlyError,
  SessionOwnershipLostError,
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionAccess as NativeSessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
} from "@deepseek-ai/dsh-session-persistence";
export { createLaunchEnvironmentSnapshot } from "@deepseek-ai/dsh-launch-environment";
export * as PiAiProvider from "@deepseek-ai/dsh-llm-pi-ai";
