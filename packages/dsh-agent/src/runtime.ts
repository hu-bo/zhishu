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
import { DshChatSession } from "./session.js";
import { DshRuntimeError, type RuntimeOptions } from "./types.js";
import { chatProjection } from "./projection.js";

export async function createDshRuntime(options: RuntimeOptions) {
  if (
    Object.values(options.limits ?? {}).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    ) ||
    (options.limits?.timeoutMs ?? 1) > 2147483647
  )
    throw new DshRuntimeError("INVALID_LIMITS");
  const ctx = new Context();
  const sessions = new Map<string, Promise<DshChatSession>>();
  let closing = false;
  try {
    for (const plugin of [Llm, Sessions, Projections]) await ctx.plugin(plugin);
    ctx.sessionProjections.register(chatProjection);
    await ctx.plugin(Prompt, { includeHarnessIdentity: false });
    await ctx.plugin(Tools, { mode: "native", maxParallelSubCalls: 1 });
    await ctx.plugin(Registry);
    await ctx.plugin(Approval, {});
    await options.configure(ctx);
    if (options.persistence === "required" && !ctx.get("sessionPersistence"))
      throw new DshRuntimeError("PERSISTENCE_REQUIRED");
    if (ctx.get("sessionPersistence")) await ctx.plugin(Checkpoint);
    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
  const attach = async (id: string, restore: boolean) => {
    if (closing) throw new DshRuntimeError("RUNTIME_CLOSED");
    await options.authorize?.(id);
    const existing = sessions.get(id);
    if (existing) return existing;
    if (sessions.size >= (options.limits?.maxSessions ?? 16))
      throw new DshRuntimeError("RESOURCE_LIMIT");
    const pending = DshChatSession.open(ctx, options, id, restore, () => sessions.delete(id));
    sessions.set(id, pending);
    try {
      return await pending;
    } catch (error) {
      sessions.delete(id);
      throw error;
    }
  };
  return {
    createSession: (id: string) => attach(id, false),
    restoreSession: (id: string) => attach(id, true),
    async dispose() {
      closing = true;
      const owned = await Promise.allSettled(sessions.values());
      const results = await Promise.allSettled(
        owned.filter((r) => r.status === "fulfilled").map((r) => r.value.dispose()),
      );
      await ctx.fiber.dispose();
      if (results.some((r) => r.status === "rejected")) throw new DshRuntimeError("CLOSE_FAILED");
    },
  };
}
export type DshChatRuntime = Awaited<ReturnType<typeof createDshRuntime>>;
