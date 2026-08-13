import type { ConfigService } from '../../services/config-service';
import type { UserService } from '../../services/user-service';
import type { BillingService } from '../../services/billing-service';
import type { ImpressionStore } from '../../services/impression-store';
import type { ListingService } from '../../services/listing-service';
import type { SearchHistoryService } from '../../services/search-history-service';
import type { CheckerStatsService } from '../../services/checker-stats';
import type { SelectionTraceService } from '../../services/selection-trace';
import type { Promo } from '../../promo-selector/types';
import { selectPromo, type SelectionTrace } from '../../promo-selector';
import { resolveUserIdentity, type Advertisement, type ModelResult, type SelectPromoParams } from './types';
import type { SearchHistoryEntry, PurchaseEntry } from '../../promo-selector/checkers';
import { hasSearchRule } from '../../promo-selector/checkers/registry/Search';
import type { PurchaseLedgerService } from '../../services/purchase-ledger-service';
import type { BalanceService } from '../../services/balance-service';
import { hasPurchaseRule } from '../../promo-selector/checkers/registry/Purchases';
import { hasBalanceRule } from '../../promo-selector/checkers/registry/Balance';

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
  searchHistoryService: SearchHistoryService;
  purchaseLedgerService: PurchaseLedgerService;
  balanceService: BalanceService;
  logger?: Logger;
  /** Checker-observability sink (promo_checker_stats aggregator). Optional: absent in tests. */
  checkerStats?: CheckerStatsService;
  /** Per-request trace sink (promo_selection_traces, userId-level drill-down). Optional: absent in tests. */
  selectionTrace?: SelectionTraceService;
  /** Injectable clock for deterministic tests; defaults to real time. */
  now?: () => Date;
}

/**
 * Load search history only when this walk can actually evaluate a search rule.
 * Failures degrade to an empty history so targeted promos fail closed while a
 * generic candidate later in the same queue remains available.
 */
export async function loadSearchHistoryForSelection(
  params: SelectPromoParams,
  promos: Promo[],
  skip: string[],
  deps: SelectPromoDeps,
  logPrefix: 'select-promo' | 'select-promo-list',
): Promise<SearchHistoryEntry[]> {
  if (skip.includes('search') || !params.viewerKey || !promos.some(hasSearchRule)) return [];

  try {
    return await deps.searchHistoryService.getSearchHistory(params.viewerKey);
  } catch (err) {
    deps.logger?.error(
      { error: err instanceof Error ? err.message : 'unknown error' },
      `${logPrefix}: search history unavailable`,
    );
    return [];
  }
}

/**
 * Loads wallet data (purchases + current balance + movement) only when this
 * walk can actually evaluate a purchases/balance rule — same short-circuit
 * shape as loadSearchHistoryForSelection. Three independent reads run in
 * parallel; a failure in any one degrades that piece to "no data" (checker
 * then fails closed) without blocking the other two or the rest of selection.
 */
export async function loadWalletDataForSelection(
  params: SelectPromoParams,
  promos: Promo[],
  skip: string[],
  deps: SelectPromoDeps,
  logPrefix: 'select-promo' | 'select-promo-list',
): Promise<{ purchases: PurchaseEntry[]; walletBalanceKopecks?: number; walletMovementKopecks?: number }> {
  const empty = { purchases: [], walletBalanceKopecks: undefined, walletMovementKopecks: undefined };
  if (!params.userId) return empty;

  const needsPurchases = !skip.includes('purchases') && promos.some(hasPurchaseRule);
  const needsBalance = !skip.includes('balance') && promos.some(hasBalanceRule);
  if (!needsPurchases && !needsBalance) return empty;

  const purchaseLookbackDays = needsPurchases
    ? Math.max(...promos.filter(hasPurchaseRule).map((p) => p.targeting.purchases!.lookbackDays ?? 30))
    : 0;
  const movementLookbackDays = needsBalance
    ? promos
        .filter((p) => hasBalanceRule(p) && p.targeting.balance!.movementLookbackDays !== undefined)
        .reduce<number | undefined>((max, p) => {
          const d = p.targeting.balance!.movementLookbackDays!;
          return max === undefined ? d : Math.max(max, d);
        }, undefined)
    : undefined;
  const movementSinceMs = movementLookbackDays !== undefined
    ? Date.now() - movementLookbackDays * 24 * 60 * 60 * 1000
    : undefined;
  const needsCurrentBalance = needsBalance && promos.some(
    (p) => hasBalanceRule(p) && (p.targeting.balance!.currentAbove !== undefined || p.targeting.balance!.currentBelow !== undefined),
  );
  const needsMovement = needsBalance && promos.some(
    (p) => hasBalanceRule(p) && (p.targeting.balance!.movementAbove !== undefined || p.targeting.balance!.movementBelow !== undefined),
  );

  const [purchases, balances, movement] = await Promise.all([
    needsPurchases
      ? deps.purchaseLedgerService.getPurchases(params.userId, Date.now() - purchaseLookbackDays * 24 * 60 * 60 * 1000).catch((err) => {
          deps.logger?.error({ error: err instanceof Error ? err.message : 'unknown error' }, `${logPrefix}: purchase history unavailable`);
          return [] as PurchaseEntry[];
        })
      : Promise.resolve([] as PurchaseEntry[]),
    needsCurrentBalance
      ? deps.balanceService.getBalances([params.userId]).catch((err) => {
          deps.logger?.error({ error: err instanceof Error ? err.message : 'unknown error' }, `${logPrefix}: wallet balance unavailable`);
          return new Map<string, number>();
        })
      : Promise.resolve(new Map<string, number>()),
    needsMovement
      ? deps.purchaseLedgerService.getMovement(params.userId, movementSinceMs).catch((err) => {
          deps.logger?.error({ error: err instanceof Error ? err.message : 'unknown error' }, `${logPrefix}: wallet movement unavailable`);
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);

  return {
    purchases,
    walletBalanceKopecks: balances.get(params.userId),
    walletMovementKopecks: movement,
  };
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
  const searchHistory = await loadSearchHistoryForSelection(params, promos, skip, deps, 'select-promo');
  const wallet = await loadWalletDataForSelection(params, promos, skip, deps, 'select-promo');

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
        searchHistory,
        purchases: wallet.purchases,
        walletBalanceKopecks: wallet.walletBalanceKopecks,
        walletMovementKopecks: wallet.walletMovementKopecks,
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
