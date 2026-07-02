import { describe, it, expect } from 'vitest';
import { handleFeedFill, type FeedFillDeps } from './feed-fill';
import type { CampaignCandidate } from '../../services/campaign-service';

function cand(id: number, advertiserId: string, cpmKopecks: number, bannerFormat = 'block'): CampaignCandidate {
  return {
    id, advertiserId, cpmKopecks,
    creative: { format: 'banner', title: `ad-${id}` },
    spentKopecks: 0, totalBudgetKopecks: null, targetPages: null, bannerFormat,
  };
}

function makeDeps(
  candidates: CampaignCandidate[],
  balances: Record<string, number>,
  hourCounts: Record<string, number> = {},
  dayCounts: Record<string, number> = {},
): FeedFillDeps {
  return {
    campaignService: {
      getActiveBannerCampaigns: async () => candidates,
      getCampaignsForSlot: async () => [],
    },
    balanceService: {
      getBalances: async (ids: string[]) => new Map(ids.map((id) => [id, balances[id] ?? 0])),
    },
    feedFrequencyService: {
      getViewCounts: async () => ({ hour: hourCounts, day: dayCounts }),
    },
  };
}

describe('handleFeedFill', () => {
  it('returns an ordered, count-length fill; round-robin alternates, higher cpm leads', async () => {
    const res = await handleFeedFill(
      { count: 10, format: 'block' },
      makeDeps([cand(1, 'A', 9000), cand(2, 'A', 1000)], { A: 100_000 }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.data.length).toBe(10);
    expect(res.data.every((ad) => ad.id === 'campaign:1' || ad.id === 'campaign:2')).toBe(true);
    // Round-robin: one promo per round → two campaigns split 5/5; CPM dominance
    // is expressed by order — the auction winner takes the first slot of each round.
    expect(res.data.filter((ad) => ad.id === 'campaign:1').length).toBe(5);
    expect(res.data[0].id).toBe('campaign:1');
  });

  it('a lone campaign fills every position (no blanks)', async () => {
    const res = await handleFeedFill({ count: 5, format: 'block' }, makeDeps([cand(1, 'A', 5000)], { A: 100_000 }));
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.data.map((a) => a.id)).toEqual(Array(5).fill('campaign:1'));
  });

  it('excludes malformed creatives before allocating', async () => {
    const broken = { ...cand(1, 'A', 9000), creative: { format: 'banner' } }; // no title → campaignToAd null
    const res = await handleFeedFill(
      { count: 4, format: 'block' },
      makeDeps([broken, cand(2, 'A', 1000)], { A: 100_000 }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.data.every((a) => a.id === 'campaign:2')).toBe(true);
  });

  it('returns an error envelope when the campaign service fails', async () => {
    const deps = makeDeps([], {});
    deps.campaignService = {
      getActiveBannerCampaigns: async () => { throw new Error('down'); },
      getCampaignsForSlot: async () => [],
    };
    const res = await handleFeedFill({ count: 5 }, deps);
    expect(res.status).toBe('error');
  });

  it('applies the frequency cap from the impression store', async () => {
    const res = await handleFeedFill(
      { count: 6, format: 'block', userId: 'u1', freqCap: 5 },
      makeDeps([cand(1, 'A', 9000), cand(2, 'B', 1000)], { A: 100_000, B: 100_000 }, { 'campaign:1': 5 }),
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.data.every((a) => a.id === 'campaign:2')).toBe(true); // id 1 capped out
  });

  it('fails soft to an empty fill when the balance service is down', async () => {
    const deps = makeDeps([cand(1, 'A', 9000)], { A: 100_000 });
    deps.balanceService = { getBalances: async () => { throw new Error('down'); } };
    const res = await handleFeedFill({ count: 5, format: 'block' }, deps);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.data).toEqual([]); // no balances → all insolvent → nothing eligible
  });
});
