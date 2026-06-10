/**
 * Sliding-window rate limiter, in memory, per key. For the enhance-promo
 * endpoint we want ≤30 requests/hour/advertiser; a sliding window keeps the
 * limit honest at window edges (versus fixed buckets that allow 2× burst).
 *
 * Storage = `Map<key, number[]>` of hit timestamps. We prune stale entries on
 * each hit, so memory stays bounded as long as keys are reasonably small.
 * Single-process only — fine for one BFF instance; if we scale out we'll move
 * to Redis with the same interface.
 */

export interface RateLimitDecision {
  /** True if the attempt is within budget AND has been recorded. */
  ok: boolean;
  /** When `ok=false`, ms until the oldest in-window hit ages out (so the user
   *  can retry). 0 means "right now" (edge case). Omitted when `ok=true`. */
  retryAfterMs?: number;
  /** How many hits the key has in the current window (after this call). */
  count: number;
}

export interface RateLimitStore {
  /** Records an attempt and returns whether it was within budget. A rejected
   *  attempt is NOT recorded — the user's count doesn't keep growing past
   *  the limit. */
  hit(key: string): RateLimitDecision;
  /** Test helpers. */
  clear(): void;
  size(): number;
}

export interface CreateRateLimitOpts {
  /** Max hits per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export function createRateLimitStore(opts: CreateRateLimitOpts): RateLimitStore {
  if (opts.limit <= 0) throw new Error('rate-limit: limit must be > 0');
  if (opts.windowMs <= 0) throw new Error('rate-limit: windowMs must be > 0');
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();

  function prune(arr: number[], cutoff: number) {
    // Timestamps are appended monotonically; drop from the front while ≤ cutoff.
    let i = 0;
    while (i < arr.length && arr[i] <= cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  return {
    hit(key) {
      const t = now();
      const cutoff = t - opts.windowMs;
      const arr = hits.get(key) ?? [];
      prune(arr, cutoff);

      if (arr.length >= opts.limit) {
        const oldest = arr[0];
        const retryAfterMs = Math.max(0, oldest + opts.windowMs - t);
        hits.set(key, arr); // keep pruned array so we don't redo work next call
        return { ok: false, retryAfterMs, count: arr.length };
      }

      arr.push(t);
      hits.set(key, arr);
      return { ok: true, count: arr.length };
    },
    clear() { hits.clear(); },
    size() { return hits.size; },
  };
}
