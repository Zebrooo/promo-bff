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

export interface FeedFillOptions {
  /** Size-format the feed wants (block for the grid card, horizontal for the list
   *  strip). Only candidates whose bannerFormat matches are eligible; omit = any. */
  format?: string;
  /** Per-viewer view counts in the rolling HOUR ("campaign:<id>" -> times seen),
   *  paired with freqCap. */
  seenCounts?: Record<string, number>;
  /** Per-viewer view counts in the rolling DAY ("campaign:<id>" -> times seen),
   *  paired with freqCapDay (optional backstop). */
  seenCountsDay?: Record<string, number>;
  /** Rolling-hour cap: a campaign may be shown at most freqCap times/hour to this
   *  viewer. The cap BITES — a campaign at its cap is hard-excluded; we do NOT fall
   *  back to over-exposed creatives (an empty in-feed slot just yields to the next
   *  listing). Omit = no cap (a lone campaign then fills the whole feed). */
  freqCap?: number;
  /** Optional rolling-day backstop, combined with freqCap (most-restrictive wins). */
  freqCapDay?: number;
  /** With >1 advertiser eligible, no single advertiser may take more than this
   *  fraction of `count` positions (anti-monopoly). Default 0.6. A lone advertiser
   *  is exempt — it fills the whole feed rather than leave blanks. */
  maxAdvertiserShare?: number;
}

/**
 * Weighted fill for an in-feed cascade. Returns up to `count` positions IN ORDER
 * (repeats ALLOWED) where higher-cpm campaigns appear proportionally more often.
 *
 * Deliberate inverse of allocateAuction's one-campaign+one-advertiser batch rule:
 * that rule empties feed positions when advertisers are few (the "ads don't repeat"
 * symptom), whereas a cascade must keep filling. Here the available inventory
 * repeats — favouring higher bids — so positions never go blank in a thin market.
 *
 * Mechanics: smooth weighted round-robin (Nginx SWRR) keyed on cpm — a higher-cpm
 * campaign is picked more often AND naturally spread out (SWRR interleaves rather
 * than clusters). Per-pick constraints:
 *   - eligibility: solvency + budget + page-target (reused checks) + format
 *   - frequency: drop campaigns this user already saw >= freqCap times, unless
 *     that empties the pool
 *   - anti-monopoly: with >1 advertiser, none exceeds maxAdvertiserShare of count
 * Over-exposure to one viewer is bounded by freqCap, NOT by forbidding repeats —
 * forbidding back-to-back would defeat the cpm weighting when inventory is thin.
 * Pure (no I/O); the route handler fetches candidates/balances/impressions and
 * maps the winners through campaignToAd. Per-fill budget pacing is left to the
 * per-impression charge + the budget check on the next request.
 */
export function allocateFeedFill(
  candidates: CampaignCandidate[],
  count: number,
  ctx: AuctionCheckContext,
  opts: FeedFillOptions = {},
  checks: AuctionEligibilityCheck[] = DEFAULT_CHECKS,
): CampaignCandidate[] {
  if (count <= 0) return [];
  let eligible = candidates.filter(
    (c) => checks.every((chk) => chk.isEligible(c, ctx)) && formatMatches(opts.format, c.bannerFormat),
  );
  if (eligible.length === 0) return [];

  // Compound frequency cap → per-campaign APPEARANCE BUDGET: how many more times
  // this campaign may be shown to this viewer right now (min over the hour cap and
  // the optional day backstop). budget 0 = HARD-excluded — the cap is meant to
  // bite, so we deliberately do NOT fall back to over-exposed creatives; an empty
  // in-feed slot simply yields to the next listing.
  const budgetOf = (c: CampaignCandidate): number => {
    if (opts.freqCap === undefined) return Number.POSITIVE_INFINITY;
    let b = opts.freqCap - (opts.seenCounts?.[`campaign:${c.id}`] ?? 0);
    if (opts.freqCapDay !== undefined) {
      b = Math.min(b, opts.freqCapDay - (opts.seenCountsDay?.[`campaign:${c.id}`] ?? 0));
    }
    return Math.max(0, b);
  };
  if (opts.freqCap !== undefined) {
    eligible = eligible.filter((c) => budgetOf(c) > 0);
    if (eligible.length === 0) return [];
  }

  const distinctAdvertisers = new Set(eligible.map((c) => c.advertiserId)).size;
  const share = opts.maxAdvertiserShare ?? 0.6;
  // Lone advertiser fills the whole feed; otherwise cap each advertiser's share.
  const advCap = distinctAdvertisers > 1 ? Math.max(1, Math.ceil(count * share)) : count;

  // ROUND-ROBIN: место за кругом — каждой кампании по одному, повтор ТОЛЬКО после
  // полного круга (когда все уже показались). Порядок круга: наименее показанные
  // этому юзеру вперёд (раунды продвигаются по просмотрам — «после того как каждая
  // получит просмотр, разыгрываем заново»), при равенстве — выше CPM (порядок
  // выигрыша), затем меньший id. Так одна РК не занимает первые N мест подряд —
  // кампании чередуются; повтор — лишь когда круг пройден. Частотный кап (budgetOf)
  // и доля рекламодателя (advCap) остаются бэкстопами.
  const seenOf = (c: CampaignCandidate): number => opts.seenCounts?.[`campaign:${c.id}`] ?? 0;
  const order = [...eligible].sort(
    (a, b) =>
      (seenOf(a) - seenOf(b)) ||
      (Math.max(1, b.cpmKopecks) - Math.max(1, a.cpmKopecks)) ||
      (a.id - b.id),
  );

  const advUsed = new Map<string, number>();
  const usedByCampaign = new Map<number, number>();
  const out: CampaignCandidate[] = [];
  // Крутим круги, пока не наберём count или пока никто не может встать (исчерпаны
  // частотные бюджеты / доли рекламодателей) — тогда место в ленте просто пустует.
  let placedThisRound = true;
  while (out.length < count && placedThisRound) {
    placedThisRound = false;
    for (const c of order) {
      if (out.length >= count) break;
      if ((usedByCampaign.get(c.id) ?? 0) >= budgetOf(c)) continue;
      if ((advUsed.get(c.advertiserId) ?? 0) >= advCap) continue;
      out.push(c);
      usedByCampaign.set(c.id, (usedByCampaign.get(c.id) ?? 0) + 1);
      advUsed.set(c.advertiserId, (advUsed.get(c.advertiserId) ?? 0) + 1);
      placedThisRound = true;
    }
  }
  return out;
}
