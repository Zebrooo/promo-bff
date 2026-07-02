import type { ConfigService } from '../../services/config-service';
import type { UserService } from '../../services/user-service';
import type { BillingService } from '../../services/billing-service';
import type { ImpressionStore } from '../../services/impression-store';
import type { ListingService } from '../../services/listing-service';
import type { Promo } from '../../promo-selector/types';
import { selectPromo } from '../../promo-selector';
import type { ModelResult, SelectPromoParams } from './types';

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
  /** Injectable clock for deterministic tests; defaults to real time. */
  now?: () => Date;
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
  try {
    promo = await selectPromo(
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
      { skip, deps: { userService, billingService, impressionStore, listingService }, logger },
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
  const { name, startsAt, endsAt, targeting, maxImpressionsPerUser, cooldownHours, audience, sections, categories, sellerStatus, ...ad } = promo;
  return { status: 'ok', data: ad };
}
