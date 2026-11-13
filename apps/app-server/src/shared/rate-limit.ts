/**
 * In-memory sliding-window rate limiter for cheap abuse guards on public endpoints. It is
 * per-process (not a distributed quota): the goal is to bound expensive work such as scrypt
 * verification from a single source, not to enforce a global business budget. Keys are
 * bounded so a flood of distinct identities cannot grow memory without limit.
 */
export interface RateLimiter {
  /** True when the hit is within budget; false when the caller should be rejected. */
  allow(key: string, now?: number): boolean;
}

export function createSlidingWindowLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  const { limit, windowMs } = options;
  const maxKeys = options.maxKeys ?? 10_000;
  const hits = new Map<string, number[]>();
  const prune = (now: number) => {
    for (const [key, times] of hits) {
      const kept = times.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  };
  let lastPrune = 0;
  return {
    allow(key, now = Date.now()) {
      // Amortized cleanup keeps the map bounded without a timer.
      if (now - lastPrune >= windowMs) {
        prune(now);
        lastPrune = now;
      }
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Evict the oldest keys when a flood of distinct identities exceeds the cap.
      if (hits.size > maxKeys) {
        const excess = hits.size - maxKeys;
        let removed = 0;
        for (const oldest of hits.keys()) {
          hits.delete(oldest);
          if (++removed >= excess) break;
        }
      }
      return true;
    },
  };
}
