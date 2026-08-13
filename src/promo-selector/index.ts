import type { Promo } from './types';
import type { IdentityKind } from './checkers/Checker';
import {
  Checker,
  loadSuppliers,
  WEB_CHECKERS,
  type CheckContext,
  type Logger,
  type PurchaseEntry,
  type SearchHistoryEntry,
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
  /** First-passing winner (selectPromo) or the LAST included id (selectPromoList); null = nothing passed. */
  selectedPromoId: string | null;
  /** selectPromoList only: every included id in order. Undefined for single-select walks. */
  selectedPromoIds?: string[];
}

export interface SelectPromoContext {
  userId: string;
  /** Current login state; affects the audience checker only. */
  isAuthorized: boolean;
  /** Stable identity source; controls account-backed suppliers. */
  identityKind: IdentityKind;
  now: Date;
  section?: string;
  category?: string;
  /** Requesting device; gates promos by deviceTarget. Undefined = no device filter. */
  device?: 'desktop' | 'touch' | 'app';
  /** Formats the requesting surface accepts; gates promos by format. Undefined/empty = no filter. */
  formats?: string[];
  /** Promo ids to drop from the queue BEFORE the checkers run. Undefined/empty = no exclusion. */
  excludeIds?: string[];
  /** Search rows preloaded once by the model handler. */
  searchHistory?: SearchHistoryEntry[];
  /** Purchase history preloaded once by the model handler. */
  purchases?: PurchaseEntry[];
  /** Current wallet balance, preloaded once by the model handler. */
  walletBalanceKopecks?: number;
  /** Wallet movement sum, preloaded once by the model handler. */
  walletMovementKopecks?: number;
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

/** Prepare the shared per-walk state: active checkers, excludeIds-filtered
 *  candidates, the loaded supplier data, and the (optional) trace + emitter.
 *  Both selectPromo and selectPromoList build on this so their setup can't drift. */
async function prepareWalk(promos: Promo[], ctx: SelectPromoContext, opts: SelectPromoOptions) {
  const checkers = opts.checkers ?? WEB_CHECKERS;
  const skip = opts.skip ?? [];
  const active = checkers.filter((c) => !skip.includes(c.name));
  // Consumer-supplied exclusion (session-seen list) applies BEFORE the checker
  // walk, so an excluded promo can't win even when it passes every checker.
  const excludeIds = ctx.excludeIds ?? [];
  const candidates = excludeIds.length > 0 ? promos.filter((p) => !excludeIds.includes(p.id)) : promos;
  const data = await loadSuppliers(active, { userId: ctx.userId, identityKind: ctx.identityKind }, opts.deps);
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
  return { active, candidates, data, trace, emitTrace };
}

/**
 * Evaluate ONE candidate against the active checkers in order; push its
 * CandidateTrace entry when tracing; return whether it passed (stops at the
 * first fail). This is the SINGLE source of checker semantics + trace collection,
 * shared by selectPromo (returns-first) and selectPromoList (accumulates) so a
 * new checker or trace field auto-applies to both.
 */
async function evaluateCandidate(
  promo: Promo,
  ctx: SelectPromoContext,
  active: Checker<SupplierId>[],
  data: SuppliersData<SupplierId>,
  trace: SelectionTrace | null,
  logger?: Logger,
): Promise<boolean> {
  const ctxP: CheckContext = {
    promo,
    userId: ctx.userId,
    isAuthorized: ctx.isAuthorized,
    now: ctx.now,
    section: ctx.section,
    category: ctx.category,
    device: ctx.device,
    formats: ctx.formats,
    searchHistory: ctx.searchHistory,
    purchases: ctx.purchases,
    walletBalanceKopecks: ctx.walletBalanceKopecks,
    walletMovementKopecks: ctx.walletMovementKopecks,
  };
  const checks: CheckerTraceEntry[] = [];
  let passed = true;
  for (const c of active) {
    // Classification only (run() re-evaluates shouldSkip internally).
    const skipReason = trace ? c.shouldSkip(ctxP) : false;
    const ok = await c.run(ctxP, data, logger);
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
  return passed;
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
  const { active, candidates, data, trace, emitTrace } = await prepareWalk(promos, ctx, opts);
  for (const promo of candidates) {
    // Cast off Partial is safe: `active` drives both loadSuppliers and this loop,
    // so every supplier any active checker declares is present in `data`.
    const passed = await evaluateCandidate(promo, ctx, active, data as SuppliersData<SupplierId>, trace, opts.logger);
    if (passed) {
      if (trace) trace.selectedPromoId = promo.id;
      emitTrace();
      return promo;
    }
  }
  emitTrace();
  return null;
}

/**
 * Like selectPromo, but returns EVERY promo that passes (in queue order) instead
 * of stopping at the first. Powers the onboarding tour: the storefront fetches
 * the whole ordered, eligibility-filtered sequence in one call and plays it as a
 * client-side cursor (no per-step re-fetch, no exclude loop). Shares
 * prepareWalk + evaluateCandidate with selectPromo so checker semantics can't
 * drift. NOTE: the onboarding handler drops the `chain` checker — order is owned
 * by the queue-index array, which is strictly stronger than chain's
 * eligible-after-predecessor-impression rule.
 */
export async function selectPromoList(
  promos: Promo[],
  ctx: SelectPromoContext,
  opts: SelectPromoOptions,
): Promise<Promo[]> {
  const { active, candidates, data, trace, emitTrace } = await prepareWalk(promos, ctx, opts);
  const selected: Promo[] = [];
  for (const promo of candidates) {
    const passed = await evaluateCandidate(promo, ctx, active, data as SuppliersData<SupplierId>, trace, opts.logger);
    if (passed) selected.push(promo);
  }
  if (trace) {
    trace.selectedPromoIds = selected.map((p) => p.id);
    // selectedPromoId stays populated for back-compat observability (checker-stats
    // / promo_selection_traces read it): the LAST included id, or null if empty.
    trace.selectedPromoId = selected.length > 0 ? selected[selected.length - 1].id : null;
  }
  emitTrace();
  return selected;
}
