/**
 * In-feed cascade fill handler (native in-feed ads). Fetches active banner
 * campaigns, drops malformed creatives, gates by solvency + budget + page +
 * format, then weight-fills `count` positions (repeats ALLOWED, cpm-weighted)
 * via allocateFeedFill. Returns an ORDERED Advertisement[] (with repeats) — the
 * storefront plays it out every N cards and mints a per-position impression
 * token so each show (incl. repeats) bills.
 *
 * Mirrors handleAuction's I/O shape: campaign-service failure → error envelope;
 * balance-service failure → fail-soft (all insolvent → empty fill). The
 * frequency cap reads the per-user impression store only when params.freqCap is
 * set, and fail-soft (store error → no cap, never an empty/blocked feed).
 */
import type { CampaignService, CampaignCandidate } from '../../services/campaign-service';
import type { BalanceService } from '../../services/balance-service';
import type { ImpressionStore } from '../../services/impression-store';
import { allocateFeedFill } from '../../auction/run-auction';
import { campaignToAd } from '../../auction/campaign-to-ad';
import type { FeedFillParams, FeedFillResult } from './types';
import type { Advertisement } from '../select-promo/types';
import type { Logger } from './handle';

export interface FeedFillDeps {
  campaignService: CampaignService;
  balanceService: BalanceService;
  impressionStore: ImpressionStore;
  logger?: Logger;
}

export async function handleFeedFill(
  params: FeedFillParams,
  deps: FeedFillDeps,
): Promise<FeedFillResult> {
  const { campaignService, balanceService, impressionStore, logger } = deps;

  let candidates: CampaignCandidate[];
  try {
    candidates = await campaignService.getActiveBannerCampaigns();
  } catch (err) {
    logger?.error({ err }, 'feed-fill: campaign service unavailable');
    return { status: 'error', reason: 'campaign_service_unavailable' };
  }

  // Render each creative once; drop malformed ones before allocating.
  const ads = new Map<number, Advertisement>();
  const renderable = candidates.filter((c) => {
    const ad = campaignToAd(c);
    if (ad === null) {
      logger?.error({ campaignId: c.id }, 'feed-fill: malformed creative, excluded');
      return false;
    }
    ads.set(c.id, ad);
    return true;
  });

  const advertiserIds = [...new Set(renderable.map((c) => c.advertiserId))];
  let balances: Map<string, number>;
  try {
    balances = await balanceService.getBalances(advertiserIds);
  } catch (err) {
    logger?.error({ err }, 'feed-fill: balance service unavailable; treating all as insolvent');
    balances = new Map();
  }

  // Frequency cap reads the per-user impression store — only when requested, and
  // fail-soft (store error degrades to "no cap", never an empty/blocked feed).
  let seenCounts: Record<string, number> | undefined;
  if (params.freqCap !== undefined && params.userId) {
    try {
      seenCounts = (await impressionStore.getImpressions(params.userId)).counts;
    } catch (err) {
      logger?.error({ err }, 'feed-fill: impression store unavailable; skipping frequency cap');
    }
  }

  const fill = allocateFeedFill(
    renderable,
    params.count,
    { balances, page: params.page },
    { format: params.format, seenCounts, freqCap: params.freqCap },
  );
  return { status: 'ok', data: fill.map((c) => ads.get(c.id)!) };
}
