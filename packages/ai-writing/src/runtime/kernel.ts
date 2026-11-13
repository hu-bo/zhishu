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
  interface CachedSession {
    pending: Promise<DshWritingSession>;
    detached: () => void;
  }
  const sessions = new Map<string, CachedSession>();
  const evicting = new Map<string, Promise<void>>();
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
  /**
   * Sessions own dedicated writer connections and locks, so idle handles must be recycled:
   * a sweeper disposes sessions idle beyond sessionIdleMs, and a full cache evicts the
   * least recently used idle session before refusing new attaches. Busy or host-retained
   * sessions are never evicted.
   */
  const idleMs = options.limits?.sessionIdleMs ?? 600_000;
  const evict = (id: string, cached: CachedSession): Promise<void> => {
    const existing = evicting.get(id);
    if (existing) return existing;
    const task = cached.pending
      .then((session) =>
        session
          .dispose()
          .catch(() => options.onError?.("SESSION_DISPOSE_FAILED", session.conversationId)),
      )
      .catch(() => undefined)
      .finally(() => {
        evicting.delete(id);
        cached.detached();
      });
    evicting.set(id, task);
    return task;
  };
  const collectEvictable = async (): Promise<
    { id: string; cached: CachedSession; session: DshWritingSession; since: number }[]
  > => {
    const candidates: {
      id: string;
      cached: CachedSession;
      session: DshWritingSession;
      since: number;
    }[] = [];
    for (const [id, cached] of sessions) {
      if (evicting.has(id) || options.retainSession?.(id)) continue;
      const session = await cached.pending.catch(() => undefined);
      const since = session?.idleSince();
      if (!session || since === undefined) continue;
      candidates.push({ id, cached, session, since });
    }
    return candidates;
  };
  let sweeping = false;
  const sweep = async (): Promise<void> => {
    if (sweeping || closing) return;
    sweeping = true;
    try {
      const now = Date.now();
      for (const candidate of await collectEvictable())
        if (now - candidate.since >= idleMs) await evict(candidate.id, candidate.cached);
    } finally {
      sweeping = false;
    }
  };
  const sweeper = setInterval(() => void sweep(), Math.min(idleMs, 30_000));
  sweeper.unref();
  const attach = async (input: {
    conversationId: string;
    contextRevision: number;
    nativeSessionId: string;
    restore: boolean;
  }): Promise<NativeWritingSession> => {
    if (closing) throw new WritingRuntimeError("RUNTIME_CLOSED");
    const id = input.nativeSessionId;
    const existing = sessions.get(id);
    if (existing && !evicting.has(id)) return existing.pending;
    const inFlightEviction = evicting.get(id);
    if (inFlightEviction) await inFlightEviction;
    if (sessions.size >= (options.limits?.maxSessions ?? 16)) {
      const idle = (await collectEvictable()).sort((a, b) => a.since - b.since)[0];
      if (!idle) throw new WritingRuntimeError("RESOURCE_LIMIT");
      await evict(idle.id, idle.cached);
    }
    let detachedFired = false;
    const detached = () => {
      if (detachedFired) return;
      detachedFired = true;
      sessions.delete(id);
      options.onSessionDetached?.(id);
    };
    const cached: CachedSession = {
      pending: DshWritingSession.open(ctx, options, input, detached),
      detached,
    };
    sessions.set(id, cached);
    try {
      return await cached.pending;
    } catch (error) {
      detached();
      throw error;
    }
  };
  return {
    attach,
    dispose() {
      closing = true;
      clearInterval(sweeper);
      return (disposing ??= (async () => {
        await Promise.allSettled(evicting.values());
        const owned = await Promise.allSettled([...sessions.values()].map((s) => s.pending));
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
