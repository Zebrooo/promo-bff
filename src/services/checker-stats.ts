/**
 * Checker-observability aggregator. Folds every selectPromo SelectionTrace into
 * in-memory counters keyed by (minute bucket, queue, promoId, checker, outcome,
 * reason) and flushes them once a minute as ONE batch INSERT into
 * public.promo_checker_stats on the abkhaz-auto Supabase (миграция 0108).
 * Grafana reads the table via the read-only grafana_ro role — no checker or
 * promo names are hardcoded anywhere, new ones show up in the stats by
 * themselves.
 *
 * Per-request results land in the same table under the reserved checker name
 * '$result' (outcome 'selected'|'no_promo', promo_id = winner or '-').
 *
 * Failure policy: a failed INSERT logs a warn and merges the snapshot back into
 * the live counters, so nothing is lost — the next interval retries. Nothing in
 * here ever throws into the caller; when AA Supabase is unconfigured (dev,
 * tests) this degrades to a no-op service like the other stores.
 */
import { config, type SupabaseConfig } from '../config';
import type { SelectionTrace } from '../promo-selector';

/** Reserved pseudo-checker name for the per-request outcome row. */
export const RESULT_CHECKER = '$result';

/** Default flush cadence. */
export const FLUSH_INTERVAL_MS = 60_000;

/** ASCII unit separator — cannot appear in queue/promo/checker names or reasons. */
const KEY_SEP = '\u001f';

export interface CheckerStatsLogger {
  warn?(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

export interface CheckerStatsService {
  /** Fold one selection trace into the counters. Sync, never throws. */
  recordSelection(queue: string, trace: SelectionTrace): void;
  /** Write pending counters to the DB; on failure they are kept for the next flush. */
  flush(): Promise<void>;
  /** Start the periodic flush timer (unref'ed — never holds the process open). */
  start(): void;
  /** Stop the timer and flush what's left (bound to Fastify onClose). */
  stop(): Promise<void>;
}

export interface CheckerStatsOptions {
  cfg?: SupabaseConfig;
  flushIntervalMs?: number;
  logger?: CheckerStatsLogger;
}

interface StatRow {
  bucket_start: string;
  queue: string;
  promo_id: string;
  checker: string;
  outcome: string;
  reason: string;
  count: number;
}

function createNoopService(): CheckerStatsService {
  return {
    recordSelection: () => {},
    flush: async () => {},
    start: () => {},
    stop: async () => {},
  };
}

/** Floor a date to the start of its minute (the time-series bucket). */
function minuteBucket(d: Date): string {
  const t = new Date(d);
  t.setUTCSeconds(0, 0);
  return t.toISOString();
}

export function createCheckerStatsService(opts: CheckerStatsOptions = {}): CheckerStatsService {
  const cfg = opts.cfg ?? config.aaSupabase;
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopService();

  const intervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const table = `${url}/rest/v1/promo_checker_stats`;
  const counters = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  function bump(bucket: string, queue: string, promoId: string, checker: string, outcome: string, reason: string): void {
    const key = [bucket, queue, promoId, checker, outcome, reason].join(KEY_SEP);
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function recordSelection(queue: string, trace: SelectionTrace): void {
    const bucket = minuteBucket(new Date());
    for (const cand of trace.candidates) {
      for (const chk of cand.checks) bump(bucket, queue, cand.promoId, chk.checker, chk.outcome, chk.reason);
    }
    bump(
      bucket,
      queue,
      trace.selectedPromoId ?? '-',
      RESULT_CHECKER,
      trace.selectedPromoId ? 'selected' : 'no_promo',
      '',
    );
  }

  async function doFlush(): Promise<void> {
    if (counters.size === 0) return;
    // Snapshot-and-clear so increments recorded DURING the insert are kept for
    // the next flush instead of being double-written.
    const snapshot = new Map(counters);
    counters.clear();
    const rows: StatRow[] = [...snapshot].map(([key, count]) => {
      const [bucket_start, queue, promo_id, checker, outcome, reason] = key.split(KEY_SEP);
      return { bucket_start, queue, promo_id, checker, outcome, reason, count };
    });
    try {
      const res = await fetch(table, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'content-type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(rows),
        // Real cancellation (not a race-and-forget): a hung insert would otherwise
        // both block the next flush and risk double-counting after the merge-back.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`checker-stats write failed: HTTP ${res.status}`);
      opts.logger?.debug?.({ rows: rows.length }, 'checker-stats: flushed');
    } catch (err) {
      // Keep the counts: merge the snapshot back (summing with anything recorded
      // meanwhile) so the next interval retries the whole batch.
      for (const [key, count] of snapshot) counters.set(key, (counters.get(key) ?? 0) + count);
      opts.logger?.warn?.({ err, pendingKeys: counters.size }, 'checker-stats: flush failed, will retry next interval');
    }
  }

  function flush(): Promise<void> {
    inFlight ??= doFlush().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      void flush();
    }, intervalMs);
    timer.unref?.();
  }

  async function stop(): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Wait out an in-flight insert first, then drain whatever is left (including
    // counts a failed in-flight flush merged back).
    if (inFlight) await inFlight;
    await flush();
  }

  return { recordSelection, flush, start, stop };
}
