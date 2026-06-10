/**
 * Batch auction handler (B2C SP5): fetch all active banner campaigns, drop
 * malformed creatives, gate by solvency + budget, allocate winners onto the
 * requested positions by weight (one campaign per position), and return a
 * position->Advertisement|null map. Campaign-service failure is an error
 * envelope; balance-service failure is fail-soft (all insolvent -> all null).
 */
import type { CampaignService, CampaignCandidate } from '../../services/campaign-service';
import type { BalanceService } from '../../services/balance-service';
import { allocateAuction } from '../../auction/run-auction';
import { campaignToAd } from '../../auction/campaign-to-ad';
import type { AuctionParams, AuctionResult, AuctionBatchData } from './types';
import type { Advertisement } from '../select-promo/types';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AuctionDeps {
  campaignService: CampaignService;
  balanceService: BalanceService;
  logger?: Logger;
}

export async function handleAuction(params: AuctionParams, deps: AuctionDeps): Promise<AuctionResult> {
  const { campaignService, balanceService, logger } = deps;

  let candidates: CampaignCandidate[];
  try {
    candidates = await campaignService.getActiveBannerCampaigns();
  } catch (err) {
    logger?.error({ err }, 'auction: campaign service unavailable');
    return { status: 'error', reason: 'campaign_service_unavailable' };
  }

  // Render each creative once; drop malformed ones before ranking so a broken
  // high bid can't take a slot from a valid lower bid.
  const ads = new Map<number, Advertisement>();
  const renderable = candidates.filter((c) => {
    const ad = campaignToAd(c);
    if (ad === null) {
      logger?.error({ campaignId: c.id }, 'auction: malformed creative, excluded');
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
    logger?.error({ err }, 'auction: balance service unavailable; treating all as insolvent');
    balances = new Map();
  }

  const winners = allocateAuction(renderable, params.slots, { balances, page: params.page });

  const data: AuctionBatchData = {};
  for (const { slot } of params.slots) {
    const c = winners.get(slot);
    data[slot] = c ? ads.get(c.id)! : null;
  }
  return { status: 'ok', data };
}
