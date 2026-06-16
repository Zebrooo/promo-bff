import { describe, expect, it } from 'vitest';
import { runAuction, solvencyCheck, budgetCheck, pageTargetCheck, allocateAuction, allocateFeedFill } from './run-auction';
import type { CampaignCandidate } from '../services/campaign-service';

function cand(id: number, advertiserId: string, cpmKopecks: number): CampaignCandidate {
  return { id, advertiserId, cpmKopecks, creative: { format: 'popup', title: 't' }, spentKopecks: 0, totalBudgetKopecks: null, targetPages: null, bannerFormat: null };
}

function budgeted(id: number, advertiserId: string, cpmKopecks: number, spentKopecks: number, totalBudgetKopecks: number | null): CampaignCandidate {
  return { id, advertiserId, cpmKopecks, creative: { format: 'popup', title: 't' }, spentKopecks, totalBudgetKopecks, targetPages: null, bannerFormat: null };
}

/** Banner candidate with explicit size-format + (optional) page targeting. */
function banner(id: number, cpmKopecks: number, bannerFormat: string, targetPages: string[] | null = null): CampaignCandidate {
  return { id, advertiserId: `adv${id}`, cpmKopecks, creative: { format: 'banner', title: 't' }, spentKopecks: 0, totalBudgetKopecks: null, targetPages, bannerFormat };
}

describe('solvencyCheck', () => {
  it('passes a positive balance, fails zero / negative / missing', () => {
    const balances = new Map([['a', 1], ['b', 0], ['c', -5]]);
    expect(solvencyCheck.isEligible(cand(1, 'a', 100), { balances })).toBe(true);
    expect(solvencyCheck.isEligible(cand(2, 'b', 100), { balances })).toBe(false);
    expect(solvencyCheck.isEligible(cand(3, 'c', 100), { balances })).toBe(false);
    expect(solvencyCheck.isEligible(cand(4, 'd', 100), { balances })).toBe(false);
  });
});

describe('runAuction', () => {
  it('returns the highest-cpm solvent candidate', () => {
    const balances = new Map([['a', 10], ['b', 10]]);
    const winner = runAuction([cand(1, 'a', 3000), cand(2, 'b', 9000)], { balances });
    expect(winner?.id).toBe(2);
  });

  it('excludes insolvent advertisers even with a higher bid', () => {
    const balances = new Map([['a', 0], ['b', 10]]);
    const winner = runAuction([cand(1, 'a', 9000), cand(2, 'b', 3000)], { balances });
    expect(winner?.id).toBe(2);
  });

  it('breaks cpm ties by lower id (older campaign)', () => {
    const balances = new Map([['a', 10], ['b', 10]]);
    const winner = runAuction([cand(5, 'a', 5000), cand(2, 'b', 5000)], { balances });
    expect(winner?.id).toBe(2);
  });

  it('returns null when no candidate is eligible', () => {
    const balances = new Map([['a', 0]]);
    expect(runAuction([cand(1, 'a', 5000)], { balances })).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(runAuction([], { balances: new Map() })).toBeNull();
  });

  it('excludes a campaign whose spend has reached its total budget', () => {
    const balances = new Map([['a', 10], ['b', 10]]);
    // a bids higher but is exhausted (spent == budget); b is under budget and wins.
    const winner = runAuction(
      [budgeted(1, 'a', 9000, 30000, 30000), budgeted(2, 'b', 3000, 0, 50000)],
      { balances },
    );
    expect(winner?.id).toBe(2);
  });

  it('treats a null total budget as unlimited', () => {
    const balances = new Map([['a', 10]]);
    const winner = runAuction([budgeted(1, 'a', 5000, 999999, null)], { balances });
    expect(winner?.id).toBe(1);
  });

  it('still requires solvency alongside budget', () => {
    const balances = new Map([['a', 0]]); // insolvent, even though under budget
    expect(runAuction([budgeted(1, 'a', 5000, 0, 50000)], { balances })).toBeNull();
  });
});

describe('allocateAuction', () => {
  const pos = (slot: string, weight: number) => ({ slot, weight });

  it('assigns highest cpm to the lowest-weight position, one campaign per position', () => {
    const balances = new Map([['a', 10], ['b', 10], ['c', 10]]);
    const out = allocateAuction(
      [budgeted(1, 'a', 3000, 0, null), budgeted(2, 'b', 9000, 0, null), budgeted(3, 'c', 6000, 0, null)],
      [pos('top', 1), pos('mid', 2), pos('low', 3)],
      { balances },
    );
    expect(out.get('top')?.id).toBe(2); // cpm 9000
    expect(out.get('mid')?.id).toBe(3); // cpm 6000
    expect(out.get('low')?.id).toBe(1); // cpm 3000
  });

  it('leaves positions empty when bidders run out', () => {
    const balances = new Map([['a', 10]]);
    const out = allocateAuction([budgeted(1, 'a', 5000, 0, null)], [pos('top', 1), pos('mid', 2)], { balances });
    expect(out.get('top')?.id).toBe(1);
    expect(out.has('mid')).toBe(false);
  });

  it('drops the lowest bidders when positions run out', () => {
    const balances = new Map([['a', 10], ['b', 10]]);
    const out = allocateAuction([budgeted(1, 'a', 3000, 0, null), budgeted(2, 'b', 9000, 0, null)], [pos('only', 1)], { balances });
    expect(out.get('only')?.id).toBe(2);
    expect(out.size).toBe(1);
  });

  it('excludes insolvent and over-budget campaigns', () => {
    const balances = new Map([['a', 0], ['b', 10]]);
    const out = allocateAuction(
      [budgeted(1, 'a', 9000, 0, null), budgeted(2, 'b', 3000, 30000, 30000)],
      [pos('top', 1)], { balances },
    );
    expect(out.size).toBe(0); // a insolvent, b over budget
  });

  it('sorts positions by weight regardless of input order', () => {
    const balances = new Map([['a', 10], ['b', 10]]);
    const out = allocateAuction(
      [budgeted(1, 'a', 9000, 0, null), budgeted(2, 'b', 3000, 0, null)],
      [pos('low', 5), pos('top', 1)],  // unsorted
      { balances },
    );
    expect(out.get('top')?.id).toBe(1); // highest bid → weight 1
    expect(out.get('low')?.id).toBe(2);
  });

  it('no-repeat: один advertiser с 3 кампаниями + 3 слота → только 1 победитель', () => {
    // Все 3 кампании от одного advertiser. После выигрыша первого слота — advertiser
    // блокируется, остальные слоты остаются пустыми.
    const balances = new Map([['adv-A', 100_000]]);
    const out = allocateAuction(
      [
        budgeted(1, 'adv-A', 9000, 0, null),
        budgeted(2, 'adv-A', 6000, 0, null),
        budgeted(3, 'adv-A', 3000, 0, null),
      ],
      [pos('top', 1), pos('mid', 5), pos('low', 10)],
      { balances },
    );
    expect(out.get('top')?.id).toBe(1);  // highest cpm = id 1
    expect(out.has('mid')).toBe(false);  // advertiser исключён
    expect(out.has('low')).toBe(false);
    expect(out.size).toBe(1);
  });

  it('no-repeat: 3 разных advertisers + 3 слота → каждому свой', () => {
    const balances = new Map([['adv-A', 100_000], ['adv-B', 100_000], ['adv-C', 100_000]]);
    const out = allocateAuction(
      [
        budgeted(1, 'adv-A', 9000, 0, null),  // highest → top
        budgeted(2, 'adv-B', 6000, 0, null),  // mid → mid
        budgeted(3, 'adv-C', 3000, 0, null),  // lowest → low
      ],
      [pos('top', 1), pos('mid', 5), pos('low', 10)],
      { balances },
    );
    expect(out.get('top')?.advertiserId).toBe('adv-A');
    expect(out.get('mid')?.advertiserId).toBe('adv-B');
    expect(out.get('low')?.advertiserId).toBe('adv-C');
    expect(out.size).toBe(3);
  });

  it('no-repeat: 2 advertisers (A с 2 кампаниями, B с 1) + 3 слота → A выигрывает 1, B выигрывает 1, 3-й null', () => {
    const balances = new Map([['adv-A', 100_000], ['adv-B', 100_000]]);
    const out = allocateAuction(
      [
        budgeted(1, 'adv-A', 9000, 0, null),  // wins top
        budgeted(2, 'adv-B', 6000, 0, null),  // wins mid (A blocked)
        budgeted(3, 'adv-A', 3000, 0, null),  // A still blocked → skipped
      ],
      [pos('top', 1), pos('mid', 5), pos('low', 10)],
      { balances },
    );
    expect(out.get('top')?.id).toBe(1);
    expect(out.get('mid')?.id).toBe(2);
    expect(out.has('low')).toBe(false);
    expect(out.size).toBe(2);
  });
});

describe('budgetCheck', () => {
  it('passes under budget and null budget, fails at/over budget', () => {
    const ctx = { balances: new Map<string, number>() };
    expect(budgetCheck.isEligible({ id: 1, advertiserId: 'a', cpmKopecks: 1, creative: {}, spentKopecks: 10, totalBudgetKopecks: 20, targetPages: null, bannerFormat: null }, ctx)).toBe(true);
    expect(budgetCheck.isEligible({ id: 2, advertiserId: 'a', cpmKopecks: 1, creative: {}, spentKopecks: 20, totalBudgetKopecks: 20, targetPages: null, bannerFormat: null }, ctx)).toBe(false);
    expect(budgetCheck.isEligible({ id: 3, advertiserId: 'a', cpmKopecks: 1, creative: {}, spentKopecks: 99, totalBudgetKopecks: null, targetPages: null, bannerFormat: null }, ctx)).toBe(true);
  });
});

describe('pageTargetCheck', () => {
  const ctx = (page?: string) => ({ balances: new Map<string, number>(), page });

  it('null / empty target_pages = all pages', () => {
    expect(pageTargetCheck.isEligible(banner(1, 100, 'vertical', null), ctx('home'))).toBe(true);
    expect(pageTargetCheck.isEligible(banner(2, 100, 'vertical', []), ctx('catalog-transport'))).toBe(true);
    expect(pageTargetCheck.isEligible(banner(3, 100, 'vertical', null), ctx(undefined))).toBe(true);
  });

  it('non-empty target_pages must include the requested page', () => {
    expect(pageTargetCheck.isEligible(banner(1, 100, 'vertical', ['home']), ctx('home'))).toBe(true);
    expect(pageTargetCheck.isEligible(banner(2, 100, 'vertical', ['home']), ctx('listing'))).toBe(false);
    expect(pageTargetCheck.isEligible(banner(3, 100, 'vertical', ['home', 'listing']), ctx('listing'))).toBe(true);
  });

  it('a targeted campaign is ineligible when no page is supplied', () => {
    expect(pageTargetCheck.isEligible(banner(1, 100, 'vertical', ['home']), ctx(undefined))).toBe(false);
  });
});

describe('allocateAuction — format matching', () => {
  const balances = new Map([['adv1', 10], ['adv2', 10], ['adv3', 10]]);
  const pos = (slot: string, weight: number, format?: string) => ({ slot, weight, format });

  it('a horizontal creative never fills a vertical slot', () => {
    const out = allocateAuction(
      [banner(1, 9000, 'horizontal'), banner(2, 3000, 'vertical')],
      [pos('rail', 1, 'vertical')],
      { balances },
    );
    expect(out.get('rail')?.id).toBe(2); // the lower bid, but the only vertical
  });

  it('ranks per format and zips within each format group', () => {
    const out = allocateAuction(
      [
        banner(1, 9000, 'horizontal'), banner(2, 5000, 'horizontal'),
        banner(3, 8000, 'vertical'),  banner(4, 4000, 'vertical'),
      ],
      [pos('top', 1, 'horizontal'), pos('rail-a', 1, 'vertical'), pos('rail-b', 2, 'vertical'), pos('inline', 2, 'horizontal')],
      { balances: new Map([['adv1', 10], ['adv2', 10], ['adv3', 10], ['adv4', 10]]) },
    );
    expect(out.get('top')?.id).toBe(1);    // horizontal, highest cpm
    expect(out.get('inline')?.id).toBe(2); // horizontal, next
    expect(out.get('rail-a')?.id).toBe(3); // vertical, highest cpm, best weight
    expect(out.get('rail-b')?.id).toBe(4); // vertical, next
  });

  it('leaves a slot empty when no candidate matches its format', () => {
    const out = allocateAuction(
      [banner(1, 9000, 'horizontal')],
      [pos('block-slot', 1, 'block')],
      { balances },
    );
    expect(out.has('block-slot')).toBe(false);
  });

  it('a position with no format accepts any candidate (legacy)', () => {
    const out = allocateAuction(
      [banner(1, 9000, 'vertical')],
      [pos('legacy', 1)],
      { balances },
    );
    expect(out.get('legacy')?.id).toBe(1);
  });
});

/** Banner candidate for the feed-fill tests: explicit advertiser + format + budget. */
function feed(
  id: number,
  advertiserId: string,
  cpmKopecks: number,
  bannerFormat = 'block',
  o: { spent?: number; budget?: number | null; targetPages?: string[] | null } = {},
): CampaignCandidate {
  return {
    id, advertiserId, cpmKopecks,
    creative: { format: 'banner', title: 't' },
    spentKopecks: o.spent ?? 0,
    totalBudgetKopecks: o.budget ?? null,
    targetPages: o.targetPages ?? null,
    bannerFormat,
  };
}

describe('allocateFeedFill', () => {
  const bal = (...advs: string[]) => new Map(advs.map((a) => [a, 100_000] as const));

  it('returns [] for no candidates or non-positive count', () => {
    expect(allocateFeedFill([], 5, { balances: bal() })).toEqual([]);
    expect(allocateFeedFill([feed(1, 'A', 5000)], 0, { balances: bal('A') })).toEqual([]);
  });

  it('a lone campaign repeats to fill every position (no blanks)', () => {
    const out = allocateFeedFill([feed(1, 'A', 5000)], 5, { balances: bal('A') });
    expect(out.length).toBe(5);
    expect(out.every((c) => c.id === 1)).toBe(true);
  });

  it('higher cpm appears proportionally more often', () => {
    const out = allocateFeedFill([feed(1, 'A', 9000), feed(2, 'A', 1000)], 10, { balances: bal('A') });
    expect(out.length).toBe(10);
    const hi = out.filter((c) => c.id === 1).length;
    const lo = out.filter((c) => c.id === 2).length;
    expect(hi).toBeGreaterThan(lo);
  });

  it('caps one advertiser to maxAdvertiserShare when others exist, favouring the dearer', () => {
    const out = allocateFeedFill([feed(1, 'A', 9000), feed(2, 'B', 1000)], 10, { balances: bal('A', 'B') });
    const a = out.filter((c) => c.advertiserId === 'A').length;
    const b = out.filter((c) => c.advertiserId === 'B').length;
    expect(a).toBeLessThanOrEqual(Math.ceil(10 * 0.6)); // anti-monopoly
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThanOrEqual(b); // dearer wins more
  });

  it('a lone advertiser is exempt from the share cap (fills all positions)', () => {
    const out = allocateFeedFill([feed(1, 'A', 9000), feed(2, 'A', 1000)], 10, { balances: bal('A') });
    expect(out.length).toBe(10);
  });

  it('drops a campaign the user has seen >= freqCap times (alternative exists)', () => {
    const out = allocateFeedFill(
      [feed(1, 'A', 9000), feed(2, 'B', 1000)],
      6,
      { balances: bal('A', 'B') },
      { seenCounts: { 'campaign:1': 5 }, freqCap: 5 },
    );
    expect(out.some((c) => c.id === 1)).toBe(false);
    expect(out.every((c) => c.id === 2)).toBe(true);
  });

  it('a lone campaign at/over the freq cap stops showing — the cap bites (empty)', () => {
    const out = allocateFeedFill(
      [feed(1, 'A', 9000)],
      4,
      { balances: bal('A') },
      { seenCounts: { 'campaign:1': 99 }, freqCap: 5 },
    );
    expect(out).toEqual([]); // no "repeat beats a blank" fallback — slot yields to the next listing
  });

  it('caps a campaign to its REMAINING hour budget within one fill', () => {
    // seen 3 of 5 this hour → only 2 more appearances allowed, even though count=10.
    const out = allocateFeedFill(
      [feed(1, 'A', 9000)],
      10,
      { balances: bal('A') },
      { seenCounts: { 'campaign:1': 3 }, freqCap: 5 },
    );
    expect(out.length).toBe(2);
    expect(out.every((c) => c.id === 1)).toBe(true);
  });

  it('applies the day backstop (most-restrictive of hour/day wins)', () => {
    // hour budget = 5 (unseen this hour) but day budget = 0 (seen 20 of 20 today).
    const out = allocateFeedFill(
      [feed(1, 'A', 9000)],
      10,
      { balances: bal('A') },
      { seenCounts: {}, freqCap: 5, seenCountsDay: { 'campaign:1': 20 }, freqCapDay: 20 },
    );
    expect(out).toEqual([]);
  });

  it('only fills with creatives matching the requested format', () => {
    const out = allocateFeedFill(
      [feed(1, 'A', 9000, 'horizontal'), feed(2, 'B', 1000, 'block')],
      5,
      { balances: bal('A', 'B') },
      { format: 'block' },
    );
    expect(out.length).toBe(5);
    expect(out.every((c) => c.id === 2)).toBe(true);
  });

  it('excludes insolvent and over-budget campaigns (reuses the checks)', () => {
    const out = allocateFeedFill(
      [feed(1, 'A', 9000, 'block', { spent: 30_000, budget: 30_000 }), feed(2, 'B', 1000)],
      5,
      { balances: bal('A', 'B') },
    );
    expect(out.every((c) => c.id === 2)).toBe(true);
    const insolvent = allocateFeedFill([feed(1, 'A', 9000)], 5, { balances: new Map([['A', 0]]) });
    expect(insolvent).toEqual([]);
  });
});
