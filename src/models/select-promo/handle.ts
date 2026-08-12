import type { ConfigService } from '../../services/config-service';
import type { UserService } from '../../services/user-service';
import type { BillingService } from '../../services/billing-service';
import type { ImpressionStore } from '../../services/impression-store';
import type { ListingService } from '../../services/listing-service';
import type { CheckerStatsService } from '../../services/checker-stats';
import type { SelectionTraceService } from '../../services/selection-trace';
import type { Promo } from '../../promo-selector/types';
import { selectPromo, type SelectionTrace } from '../../promo-selector';
import { resolveUserIdentity, type Advertisement, type ModelResult, type SelectPromoParams } from './types';

/** Minimal logger shape (Fastify's logger satisfies it; tests pass nothing). */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

export interface SelectPromoDeps {
  configService: ConfigService;
  userService: UserService;
  billingService: BillingService;
  impressionStore: ImpressionStore;
  listingService: ListingService;
  logger?: Logger;
  /** Checker-observability sink (promo_checker_stats aggregator). Optional: absent in tests. */
  checkerStats?: CheckerStatsService;
  /** Per-request trace sink (promo_selection_traces, userId-level drill-down). Optional: absent in tests. */
  selectionTrace?: SelectionTraceService;
  /** Injectable clock for deterministic tests; defaults to real time. */
  now?: () => Date;
}

/**
 * Strip a Promo to the renderable Advertisement (server-only selection fields
 * removed). Shared by handleSelectPromo + handleSelectPromoList so the strip
 * can't drift from the Advertisement Omit.
 */
export function stripToAdvertisement(promo: Promo): Advertisement {
  const { name, startsAt, endsAt, targeting, maxImpressionsPerUser, cooldownHours, afterPromoId, audience, sections, categories, sellerStatus, ...ad } = promo;
  return ad;
}

/**
 * Fold a selection trace into the aggregate (promo_checker_stats) + write the
 * per-request row (promo_selection_traces) + debug-log it. Shared by both
 * handlers so the observability wiring can't drift.
 */
export function recordTraceObservability(
  deps: SelectPromoDeps,
  queueName: string,
  params: SelectPromoParams,
  trace: SelectionTrace,
): void {
  deps.checkerStats?.recordSelection(queueName, trace);
  deps.selectionTrace?.record({
    userId: params.userId,
    queue: queueName,
    device: params.device,
    section: params.context?.section,
    category: params.context?.category,
    formats: params.formats,
    excludeIds: params.excludeIds,
    trace,
  });
  deps.logger?.debug?.({ trace: { queue: queueName, ...trace } }, 'promo selection trace');
}

/**
 * select-promo model: resolve the queue from S3, build the per-request context,
 * and run the checker chain. The checkers pull user data via the userData
 * supplier; this handler no longer fetches profile/impressions itself.
 */
export async function handleSelectPromo(
  params: SelectPromoParams,
  deps: SelectPromoDeps,
): Promise<ModelResult> {
  const { configService, userService, billingService, impressionStore, listingService, logger } = deps;
  const now = deps.now?.() ?? new Date();
  const identity = resolveUserIdentity(params.user);

  const queueName = params.queue ?? 'main';

  let promos: Promo[];
  let persist: boolean;
  try {
    const result = await configService.getQueue(queueName);
    promos = result.promos;
    persist = result.persist;
  } catch (err) {
    logger?.error({ err }, 'select-promo: config service unavailable');
    return { status: 'error', reason: 'config_service_unavailable' };
  }

  const skip = [...(params.skipCheckers ?? []), ...(persist ? ['limit', 'cooldown'] : [])];

  let promo: Promo | null;
  let trace: SelectionTrace | undefined;
  try {
    promo = await selectPromo(
      promos,
      {
        userId: params.userId,
        isAuthorized: identity.isAuthorized,
        identityKind: identity.identityKind,
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
    // The userData supplier bundles profile + subscription + impressions in one
    // load, so this single catch covers a user-service, billing-service, OR
    // impression-store failure. The `impression_store_unavailable` reason is a
    // deliberate umbrella for all three (kept stable for consumers); the log
    // stays neutral so on-call isn't pointed only at Supabase.
    logger?.error({ err }, 'select-promo: user data load failed');
    return { status: 'error', reason: 'impression_store_unavailable' };
  }

  // Observability: fold the per-checker verdicts into the minute-bucket counters
  // (promo_checker_stats → Grafana) + the per-request row (promo_selection_traces)
  // + the FULL trace in the debug log (one LOG_LEVEL=debug away).
  if (trace) recordTraceObservability(deps, queueName, params, trace);

  if (!promo) {
    // Same client answer either way (reason kept stable for consumers), but the
    // logs must tell "the queue had nothing to offer" (empty — or missing in
    // S3, which config-service warns about separately) apart from "checkers
    // filtered every candidate" (2026-05-31 incident mechanics).
    if (promos.length === 0) {
      logger?.info({ queue: queueName }, 'select-promo: queue resolved to zero promos');
    }
    return { status: 'skipped', reason: 'no_promo' };
  }

  // Hand back the whole promo, minus server-only selection fields.
  return { status: 'ok', data: stripToAdvertisement(promo) };
}
