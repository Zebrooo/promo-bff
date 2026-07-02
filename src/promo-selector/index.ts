import type { Promo } from './types';
import {
  Checker,
  loadSuppliers,
  WEB_CHECKERS,
  type CheckContext,
  type Logger,
  type SupplierDeps,
  type SupplierId,
  type SuppliersData,
} from './checkers';

export { WEB_CHECKERS };
export type { SupplierDeps };

/** How a single checker judged a single candidate promo. */
export type CheckOutcome = 'pass' | 'fail' | 'skip';

export interface CheckerTraceEntry {
  checker: string;
  outcome: CheckOutcome;
  /** fail → the checker's expect() string; skip → the shouldSkip() reason; pass → ''. */
  reason: string;
}

export interface CandidateTrace {
  promoId: string;
  /** Checker verdicts in evaluation order; stops at the first fail (later checkers never ran). */
  checks: CheckerTraceEntry[];
}

/**
 * Full record of one selectPromo walk: every evaluated candidate with its
 * per-checker verdicts, plus the winner (null = nothing passed). Candidates
 * after the winner (and promos dropped by excludeIds BEFORE the walk) are
 * absent — they were never evaluated.
 */
export interface SelectionTrace {
  candidates: CandidateTrace[];
  selectedPromoId: string | null;
}

export interface SelectPromoContext {
  userId: string;
  authenticated: boolean;
  now: Date;
  section?: string;
  category?: string;
  /** Requesting device; gates promos by deviceTarget. Undefined = no device filter. */
  device?: 'desktop' | 'touch';
  /** Formats the requesting surface accepts; gates promos by format. Undefined/empty = no filter. */
  formats?: string[];
  /** Promo ids to drop from the queue BEFORE the checkers run. Undefined/empty = no exclusion. */
  excludeIds?: string[];
}

export interface SelectPromoOptions {
  /** Defaults to WEB_CHECKERS. */
  checkers?: Checker<SupplierId>[];
  /** Checker names to skip entirely (consumer skipCheckers + persist auto-skip). */
  skip?: string[];
  deps: SupplierDeps;
  logger?: Logger;
  /**
   * Observability hook: called exactly once per walk (right before returning)
   * with the full SelectionTrace. Omitted = zero-overhead (no trace collected).
   * A throwing callback is swallowed — observability must never break selection.
   */
  onTrace?: (trace: SelectionTrace) => void;
}

/**
 * Walks the queue in order and returns the first promo that passes every active
 * checker (AND). Loads the union of required suppliers once before the loop.
 * Throws only if a supplier load fails (caller maps that to an error envelope).
 */
export async function selectPromo(
  promos: Promo[],
  ctx: SelectPromoContext,
  opts: SelectPromoOptions,
): Promise<Promo | null> {
  const checkers = opts.checkers ?? WEB_CHECKERS;
  const skip = opts.skip ?? [];
  const active = checkers.filter((c) => !skip.includes(c.name));
  // Consumer-supplied exclusion (session-seen list) applies BEFORE the checker
  // walk, so an excluded promo can't win even when it passes every checker.
  const excludeIds = ctx.excludeIds ?? [];
  const candidates = excludeIds.length > 0 ? promos.filter((p) => !excludeIds.includes(p.id)) : promos;
  const data = await loadSuppliers(active, { userId: ctx.userId, authenticated: ctx.authenticated }, opts.deps);

  // Trace is collected only when a consumer asked for it; the extra shouldSkip()
  // classification call is pure/cheap by the Checker contract, and run() itself
  // stays the single source of truth for the actual pass/fail decision.
  const trace: SelectionTrace | null = opts.onTrace ? { candidates: [], selectedPromoId: null } : null;
  const emitTrace = () => {
    if (!trace || !opts.onTrace) return;
    try {
      opts.onTrace(trace);
    } catch {
      // observability must never break selection
    }
  };

  for (const promo of candidates) {
    const ctxP: CheckContext = {
      promo,
      userId: ctx.userId,
      authenticated: ctx.authenticated,
      now: ctx.now,
      section: ctx.section,
      category: ctx.category,
      device: ctx.device,
      formats: ctx.formats,
    };
    const checks: CheckerTraceEntry[] = [];
    let passed = true;
    for (const c of active) {
      // Classification only (run() re-evaluates shouldSkip internally).
      const skipReason = trace ? c.shouldSkip(ctxP) : false;
      // Cast off Partial is safe: `active` drives both loadSuppliers and this
      // loop, so every supplier any active checker declares is present in `data`,
      // and each checker reads only its own declared id.
      const ok = await c.run(ctxP, data as SuppliersData<SupplierId>, opts.logger);
      if (trace) {
        checks.push(
          skipReason
            ? { checker: c.name, outcome: 'skip', reason: skipReason }
            : ok
              ? { checker: c.name, outcome: 'pass', reason: '' }
              : { checker: c.name, outcome: 'fail', reason: c.expect() },
        );
      }
      if (!ok) {
        passed = false;
        break;
      }
    }
    trace?.candidates.push({ promoId: promo.id, checks });
    if (passed) {
      if (trace) trace.selectedPromoId = promo.id;
      emitTrace();
      return promo;
    }
  }
  emitTrace();
  return null;
}
