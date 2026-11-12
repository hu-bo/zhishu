import { Context } from "@deepseek-ai/cordis";
import Registry from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import Llm from "@deepseek-ai/dsh-llm";
import Sessions from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Approval from "@deepseek-ai/dsh-user-approval";
import * as Checkpoint from "@deepseek-ai/dsh-session-checkpoint-policy";
import { DshWritingSession } from "./session.js";
import { writingProjection } from "./projection.js";
import {
  WritingRuntimeError,
  type NativeWritingSession,
  type WritingRuntime,
  type WritingRuntimeOptions,
} from "./types.js";

/**
 * Official plugin assembly order is dictated by kernel dependencies:
 * Llm → Sessions → Projections → Prompt → Tools → Registry → Approval → configure
 * → Checkpoint (only with persistence) → Loop.
 */
export async function createWritingRuntime(
  options: WritingRuntimeOptions,
): Promise<WritingRuntime> {
  if (
    Object.values(options.limits ?? {}).some(
      (value) => !Number.isSafeInteger(value) || (value ?? 1) <= 0,
    )
  )
    throw new WritingRuntimeError("INVALID_LIMITS");
  const ctx = new Context();
  const sessions = new Map<string, Promise<DshWritingSession>>();
  let closing = false;
  let disposing: Promise<void> | undefined;
  try {
    for (const plugin of [Llm, Sessions, Projections]) await ctx.plugin(plugin);
    ctx.sessionProjections.register(writingProjection);
    await ctx.plugin(Prompt, { includeHarnessIdentity: false });
    await ctx.plugin(Tools, { mode: "native", maxParallelSubCalls: 1 });
    await ctx.plugin(Registry);
    await ctx.plugin(Approval, {});
    await options.configure(ctx);
    if (options.persistence === "required" && !ctx.get("sessionPersistence"))
      throw new WritingRuntimeError("PERSISTENCE_REQUIRED");
    if (ctx.get("sessionPersistence")) await ctx.plugin(Checkpoint);
    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
  const attach = async (input: {
    conversationId: string;
    contextRevision: number;
    nativeSessionId: string;
    restore: boolean;
  }): Promise<NativeWritingSession> => {
    if (closing) throw new WritingRuntimeError("RUNTIME_CLOSED");
    const existing = sessions.get(input.nativeSessionId);
    if (existing) return existing;
    if (sessions.size >= (options.limits?.maxSessions ?? 16))
      throw new WritingRuntimeError("RESOURCE_LIMIT");
    const pending = DshWritingSession.open(ctx, options, input, () =>
      sessions.delete(input.nativeSessionId),
    );
    sessions.set(input.nativeSessionId, pending);
    try {
      return await pending;
    } catch (error) {
      sessions.delete(input.nativeSessionId);
      throw error;
    }
  };
  return {
    attach,
    dispose() {
      closing = true;
      return (disposing ??= (async () => {
        const owned = await Promise.allSettled(sessions.values());
        const results = await Promise.allSettled(
          owned.filter((r) => r.status === "fulfilled").map((r) => r.value.dispose()),
        );
        await ctx.fiber.dispose();
        if (results.some((r) => r.status === "rejected"))
          throw new WritingRuntimeError("CLOSE_FAILED");
      })());
    },
  };
}
