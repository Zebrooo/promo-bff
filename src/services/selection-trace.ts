/**
 * Per-request selection-trace store. Where checker-stats.ts AGGREGATES every
 * SelectionTrace into anonymous minute-bucket counters (no identity, no per-call
 * granularity), this keeps ONE ROW PER select-promo request — the userId, the
 * excludeIds, the requesting surface, and the FULL per-candidate/per-checker
 * verdicts as JSONB. That makes "почему юзеру X в этом запросе не показалось
 * промо Y" answerable in Grafana by filtering on user_id, instead of guessing
 * from aggregates.
 *
 * Rows land in public.promo_selection_traces on the abkhaz-auto Supabase
 * (миграция 0109). Grafana reads via the read-only grafana_ro role; a pg_cron
 * job prunes rows past the retention window so the table stays bounded.
 *
 * Buffered + batch-flushed as ONE PostgREST insert (default every 10s, or sooner
 * when the buffer hits MAX_BUFFER). Failure policy mirrors checker-stats: a
 * failed insert re-buffers the batch (bounded — oldest rows dropped past
 * MAX_BUFFER with a warn) and retries next interval. Nothing here throws into
 * the caller; when AA Supabase is unconfigured (dev, tests) it degrades to a
 * no-op service like the other stores.
 */
import { config, type SupabaseConfig } from '../config';
import type { SelectionTrace } from '../promo-selector';

/** Default flush cadence — per-request rows shouldn't sit in memory long. */
export const TRACE_FLUSH_INTERVAL_MS = 10_000;

/**
 * Hard cap on buffered rows. During a DB outage the buffer stops growing at this
 * many rows (oldest dropped with a warn) so a wedged Supabase can't OOM the BFF.
 * Also triggers an early flush when reached during normal operation.
 */
export const MAX_BUFFER = 5_000;

export interface SelectionTraceLogger {
  warn?(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

/** Everything one select-promo walk needs to record, beyond the trace itself. */
export interface SelectionTraceInput {
  userId: string;
  queue: string;
  /** Requesting device (desktop/touch), if the surface sent one. */
  device?: string;
  section?: string;
  category?: string;
  /** Formats the requesting surface accepts (undefined/empty = no filter). */
  formats?: string[];
  /** Session-seen ids the surface asked to drop before the checkers ran. */
  excludeIds?: string[];
  trace: SelectionTrace;
}

export interface SelectionTraceService {
  /** Buffer one per-request trace row. Sync, never throws. */
  record(input: SelectionTraceInput): void;
  /** Write buffered rows to the DB; on failure they are kept for the next flush. */
  flush(): Promise<void>;
  /** Start the periodic flush timer (unref'ed — never holds the process open). */
  start(): void;
  /** Stop the timer and flush what's left (bound to Fastify onClose). */
  stop(): Promise<void>;
}

export interface SelectionTraceOptions {
  cfg?: SupabaseConfig;
  flushIntervalMs?: number;
  maxBuffer?: number;
  logger?: SelectionTraceLogger;
}

/** One row of public.promo_selection_traces (column names are the DB contract). */
interface TraceRow {
  ts: string;
  user_id: string;
  queue: string;
  device: string | null;
  section: string | null;
  category: string | null;
  formats: string[];
  exclude_ids: string[];
  selected_promo_id: string | null;
  outcome: 'selected' | 'no_promo';
  /** trace.candidates verbatim: [{ promoId, checks:[{checker,outcome,reason}] }]. */
  candidates: SelectionTrace['candidates'];
}

function createNoopService(): SelectionTraceService {
  return {
    record: () => {},
    flush: async () => {},
    start: () => {},
    stop: async () => {},
  };
}

export function createSelectionTraceService(opts: SelectionTraceOptions = {}): SelectionTraceService {
  const cfg = opts.cfg ?? config.aaSupabase;
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopService();

  const intervalMs = opts.flushIntervalMs ?? TRACE_FLUSH_INTERVAL_MS;
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER;
  const table = `${url}/rest/v1/promo_selection_traces`;
  let buffer: TraceRow[] = [];
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  function record(input: SelectionTraceInput): void {
    const row: TraceRow = {
      ts: new Date().toISOString(),
      user_id: input.userId,
      queue: input.queue,
      device: input.device ?? null,
      section: input.section ?? null,
      category: input.category ?? null,
      formats: input.formats ?? [],
      exclude_ids: input.excludeIds ?? [],
      selected_promo_id: input.trace.selectedPromoId,
      outcome: input.trace.selectedPromoId ? 'selected' : 'no_promo',
      candidates: input.trace.candidates,
    };
    buffer.push(row);
    if (buffer.length >= maxBuffer) {
      // Drop the OLDEST overflow (keep the freshest — recent requests are what a
      // debugger is looking at) and kick an out-of-band flush.
      if (buffer.length > maxBuffer) {
        const dropped = buffer.length - maxBuffer;
        buffer = buffer.slice(buffer.length - maxBuffer);
        opts.logger?.warn?.({ dropped }, 'selection-trace: buffer overflow, dropped oldest rows');
      }
      void flush();
    }
  }

  async function doFlush(): Promise<void> {
    if (buffer.length === 0) return;
    // Take the batch; new rows recorded DURING the insert go to a fresh buffer
    // and are flushed next interval (no double-write).
    const batch = buffer;
    buffer = [];
    try {
      const res = await fetch(table, {
        method: 'POST',
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          'content-type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`selection-trace write failed: HTTP ${res.status}`);
      opts.logger?.debug?.({ rows: batch.length }, 'selection-trace: flushed');
    } catch (err) {
      // Re-buffer the failed batch AHEAD of anything recorded meanwhile, then
      // enforce the cap (drop oldest) so an outage can't grow memory unbounded.
      buffer = [...batch, ...buffer];
      if (buffer.length > maxBuffer) buffer = buffer.slice(buffer.length - maxBuffer);
      opts.logger?.warn?.({ err, pending: buffer.length }, 'selection-trace: flush failed, will retry next interval');
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
    if (inFlight) await inFlight;
    await flush();
  }

  return { record, flush, start, stop };
}
