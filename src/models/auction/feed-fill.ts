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
 * frequency cap reads per-viewer feed-view counts only when params.freqCap is
 * set, and fail-soft (service error → per-fill cap only, never a blocked feed).
 */
import type { CampaignService, CampaignCandidate } from '../../services/campaign-service';
import type { BalanceService } from '../../services/balance-service';
import type { FeedFrequencyService } from '../../services/feed-frequency-service';
import { allocateFeedFill } from '../../auction/run-auction';
import { campaignToAd } from '../../auction/campaign-to-ad';
import type { FeedFillParams, FeedFillResult } from './types';
import type { Advertisement } from '../select-promo/types';
import type { Logger } from './handle';

/** Rolling-day cap = this multiple of the rolling-hour cap (a backstop against a
 *  power-user seeing one campaign all day; the hour stays the primary limit). */
const DAILY_CAP_MULTIPLIER = 4;

export interface FeedFillDeps {
  campaignService: CampaignService;
  balanceService: BalanceService;
  feedFrequencyService: FeedFrequencyService;
  logger?: Logger;
}

export async function handleFeedFill(
  params: FeedFillParams,
  deps: FeedFillDeps,
): Promise<FeedFillResult> {
  const { campaignService, balanceService, feedFrequencyService, logger } = deps;

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

  // Frequency cap reads per-viewer feed-view counts (banner_view_events) — only
  // when requested, and fail-soft: on a service error we keep params.freqCap (so a
  // campaign still can't repeat more than freqCap times within THIS fill) but lose
  // cross-request memory — never a blocked feed. Hour is the primary cap; day is a
  // backstop (freqCap * DAILY_CAP_MULTIPLIER).
  let seenCounts: Record<string, number> | undefined;
  let seenCountsDay: Record<string, number> | undefined;
  let freqCapDay: number | undefined;
  if (params.freqCap !== undefined && params.userId) {
    freqCapDay = params.freqCap * DAILY_CAP_MULTIPLIER;
    try {
      const counts = await feedFrequencyService.getViewCounts(params.userId);
      seenCounts = counts.hour;
      seenCountsDay = counts.day;
    } catch (err) {
      logger?.error({ err }, 'feed-fill: frequency service unavailable; capping per-fill only');
    }
  }

  const fill = allocateFeedFill(
    renderable,
    params.count,
    { balances, page: params.page },
    { format: params.format, seenCounts, seenCountsDay, freqCap: params.freqCap, freqCapDay },
  );
  return { status: 'ok', data: fill.map((c) => ads.get(c.id)!) };
}
