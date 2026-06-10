/**
 * Pure auction core (B2C sub-project 3). No I/O. Filters candidates by every
 * eligibility check, then picks the highest cpm (tie-break: lower id = older
 * campaign). First-price: the winner's clearing price is its own cpm_kopecks,
 * read off the returned candidate by the caller.
 *
 * AuctionEligibilityCheck is the auction's own "checks-as-checkers" abstraction,
 * intentionally separate from the B2B promo-selector Checker framework. SP4 adds
 * a budget/pacing check to the default list with no change to runAuction.
 */
import type { CampaignCandidate } from '../services/campaign-service';

export interface AuctionCheckContext {
  /** advertiserId -> balance_kopecks (missing = treated as 0). */
  balances: Map<string, number>;
  /** Page key the auction is filling; used by pageTargetCheck. */
  page?: string;
  // SP4 added budgetCheck; SP5 adds batch allocation; SP6 adds page+format targeting.
}

export interface AuctionEligibilityCheck {
  readonly name: string;
  /** True = the candidate may win. */
  isEligible(c: CampaignCandidate, ctx: AuctionCheckContext): boolean;
}

/** Advertiser wallet balance must be strictly positive. */
export const solvencyCheck: AuctionEligibilityCheck = {
  name: 'solvency',
  isEligible: (c, ctx) => (ctx.balances.get(c.advertiserId) ?? 0) > 0,
};

/** Campaign must be under its total budget (null budget = unlimited). */
export const budgetCheck: AuctionEligibilityCheck = {
  name: 'budget',
  isEligible: (c) => c.totalBudgetKopecks === null || c.spentKopecks < c.totalBudgetKopecks,
};

/** Campaign must target the requested page (null/empty target = all pages). */
export const pageTargetCheck: AuctionEligibilityCheck = {
  name: 'page-target',
  isEligible: (c, ctx) =>
    !c.targetPages ||
    c.targetPages.length === 0 ||
    (ctx.page !== undefined && c.targetPages.includes(ctx.page)),
};

const DEFAULT_CHECKS: AuctionEligibilityCheck[] = [solvencyCheck, budgetCheck, pageTargetCheck];

export interface AuctionPosition {
  /** Storefront position id (e.g. "home-top-1"). */
  slot: string;
  /** Rank weight; lower = filled first (best place). */
  weight: number;
  /** Size-format family this position accepts; only candidates whose bannerFormat
   *  matches may fill it. Omitted = legacy any-format. */
  format?: string;
}

/** A position accepts a candidate when formats match. A position with no format
 *  (legacy callers) accepts any candidate. */
function formatMatches(slotFormat: string | undefined, bannerFormat: string | null): boolean {
  return slotFormat === undefined || bannerFormat === slotFormat;
}

/**
 * Weighted, format-aware allocation: rank eligible candidates by cpm desc (tie id
 * asc), then walk positions best-weight first and give each the highest-cpm unused
 * candidate whose format matches the position. This yields per-format rank-and-zip
 * (a horizontal creative can only win a horizontal slot) while keeping global
 * weight ordering. Each candidate is used at most once; unfilled positions are
 * absent from the map. First-price: a placed candidate is charged its own cpm per
 * impression (SP4), so position never changes the price.
 */
export function allocateAuction(
  candidates: CampaignCandidate[],
  positions: AuctionPosition[],
  ctx: AuctionCheckContext,
  checks: AuctionEligibilityCheck[] = DEFAULT_CHECKS,
): Map<string, CampaignCandidate> {
  const eligible = candidates
    .filter((c) => checks.every((chk) => chk.isEligible(c, ctx)))
    .sort((a, b) => (b.cpmKopecks - a.cpmKopecks) || (a.id - b.id));
  const ordered = [...positions].sort((a, b) => (a.weight - b.weight) || (a.slot < b.slot ? -1 : 1));
  const out = new Map<string, CampaignCandidate>();
  const usedCampaigns = new Set<number>();
  // No-repeat-advertiser: один advertiser выигрывает максимум один слот в батче.
  // Защищает от ситуации «один advertiser с highest cpm забирает все depth-tier слоты»
  // на feed-cascade (см. spec 2026-06-02-ad-inventory-expansion-design.md, секция D).
  const usedAdvertisers = new Set<string>();
  for (const pos of ordered) {
    const winner = eligible.find((c) =>
      !usedCampaigns.has(c.id) &&
      !usedAdvertisers.has(c.advertiserId) &&
      formatMatches(pos.format, c.bannerFormat),
    );
    if (winner) {
      out.set(pos.slot, winner);
      usedCampaigns.add(winner.id);
      usedAdvertisers.add(winner.advertiserId);
    }
  }
  return out;
}

/**
 * Filter by all checks, then highest cpm desc, tie-break id asc. Returns the
 * winning candidate or null when none is eligible.
 */
export function runAuction(
  candidates: CampaignCandidate[],
  ctx: AuctionCheckContext,
  checks: AuctionEligibilityCheck[] = DEFAULT_CHECKS,
): CampaignCandidate | null {
  const eligible = candidates.filter((c) => checks.every((chk) => chk.isEligible(c, ctx)));
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (b.cpmKopecks - a.cpmKopecks) || (a.id - b.id));
  return eligible[0]!;
}
