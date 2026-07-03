import type { Promo } from '../../promo-selector/types';
import { selectPromoList, type SelectionTrace } from '../../promo-selector';
import { stripToAdvertisement, recordTraceObservability, type SelectPromoDeps } from './handle';
import type { PromoListResult, SelectPromoParams } from './types';

/**
 * select-promo-list model: like handleSelectPromo but returns the WHOLE ordered,
 * eligibility-filtered sequence in one response — powers the onboarding tour,
 * which the storefront plays as a client-side cursor (no per-step re-fetch, no
 * excludeIds loop).
 *
 * Drops the `chain` checker unconditionally: tour ORDER is owned by the
 * queue-index array (queue-<name>.json ids[]), which is strictly stronger than
 * chain's eligible-after-predecessor-impression rule. `chain` stays intact and
 * active for the generic select-promo path (every other queue). Reuses the SAME
 * SelectPromoDeps + the SAME strip/observability helpers as handleSelectPromo so
 * checker semantics + wiring can't drift.
 */
export async function handleSelectPromoList(
  params: SelectPromoParams,
  deps: SelectPromoDeps,
): Promise<PromoListResult> {
  const { configService, userService, billingService, impressionStore, listingService, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const queueName = params.queue ?? 'main';

  let promos: Promo[];
  let persist: boolean;
  try {
    const result = await configService.getQueue(queueName);
    promos = result.promos;
    persist = result.persist;
  } catch (err) {
    logger?.error({ err }, 'select-promo-list: config service unavailable');
    return { status: 'error', reason: 'config_service_unavailable' };
  }

  // chain always dropped (order = queue index). Persist queues auto-skip limit+cooldown
  // (as select-promo does); on replay the route adds ['limit','cooldown'] via skipCheckers.
  const skip = [...(params.skipCheckers ?? []), 'chain', ...(persist ? ['limit', 'cooldown'] : [])];

  let steps: Promo[];
  let trace: SelectionTrace | undefined;
  try {
    steps = await selectPromoList(
      promos,
      {
        userId: params.userId,
        authenticated: params.user?.authenticated ?? false,
        now,
        section: params.context?.section,
        category: params.context?.category,
        device: params.device,
        formats: params.formats,
        excludeIds: params.excludeIds,
      },
      {
        skip,
        deps: { userService, billingService, impressionStore, listingService },
        logger,
        onTrace: (t) => {
          trace = t;
        },
      },
    );
  } catch (err) {
    // Umbrella for user-service / billing-service / impression-store failure
    // (same as select-promo — the userData supplier bundles all three).
    logger?.error({ err }, 'select-promo-list: user data load failed');
    return { status: 'error', reason: 'impression_store_unavailable' };
  }

  if (trace) recordTraceObservability(deps, queueName, params, trace);

  if (promos.length === 0) {
    logger?.info({ queue: queueName }, 'select-promo-list: queue resolved to zero promos');
    return { status: 'skipped', reason: 'no_promo' };
  }
  if (steps.length === 0) {
    // Non-empty queue but every step filtered — a real "nothing to show" for this user.
    return { status: 'skipped', reason: 'no_promo' };
  }
  // Incident visibility (2026-07-03 class): a list shorter than the queue means
  // steps were filtered by checkers OR dropped from the pool (malformed promo) —
  // surface the delta the deterministic list would otherwise hide.
  if (steps.length < promos.length) {
    logger?.info(
      { queue: queueName, queued: promos.length, returned: steps.length },
      'select-promo-list: some steps filtered/dropped',
    );
  }
  return { status: 'ok', steps: steps.map(stripToAdvertisement) };
}
