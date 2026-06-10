import { describe, expect, it } from 'vitest';
import { handleAuction, type AuctionDeps } from './handle';
import type { CampaignCandidate } from '../../services/campaign-service';

/** Build a renderable candidate whose creative campaignToAd accepts (format=banner). */
function cand(id: number, advertiserId: string, cpmKopecks: number): CampaignCandidate {
  return {
    id,
    advertiserId,
    cpmKopecks,
    creative: { format: 'banner', title: 't', imageUrl: 'https://i', action: { href: 'https://t' } },
    spentKopecks: 0,
    totalBudgetKopecks: null,
    targetPages: null,
    bannerFormat: null,
  };
}

function makeDeps(candidates: CampaignCandidate[], balances: Map<string, number>): AuctionDeps {
  return {
    campaignService: {
      getActiveBannerCampaigns: async () => candidates,
      getCampaignsForSlot: async () => [],
    },
    balanceService: { getBalances: async () => balances },
  };
}

function makeDepsThrowingCampaigns(): AuctionDeps {
  return {
    campaignService: {
      getActiveBannerCampaigns: async () => { throw new Error('campaign service down'); },
      getCampaignsForSlot: async () => [],
    },
    balanceService: { getBalances: async () => new Map() },
  };
}

function makeDepsThrowingBalances(candidates: CampaignCandidate[]): AuctionDeps {
  return {
    campaignService: {
      getActiveBannerCampaigns: async () => candidates,
      getCampaignsForSlot: async () => [],
    },
    balanceService: {
      getBalances: async () => { throw new Error('ledger down'); },
    },
  };
}

describe('handleAuction', () => {
  it('returns a winner map keyed by position, allocated by weight', async () => {
    const deps = makeDeps(
      [cand(1, 'a', 9000), cand(2, 'b', 3000)],
      new Map([['a', 10], ['b', 10]]),
    );
    const res = await handleAuction({ slots: [{ slot: 'top', weight: 1 }, { slot: 'low', weight: 2 }] }, deps);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data['top']?.id).toBe('campaign:1'); // highest cpm → weight 1
      expect(res.data['low']?.id).toBe('campaign:2');
    }
  });

  it('fills unmatched positions with null', async () => {
    const deps = makeDeps([cand(1, 'a', 9000)], new Map([['a', 10]]));
    const res = await handleAuction({ slots: [{ slot: 'top', weight: 1 }, { slot: 'low', weight: 2 }] }, deps);
    if (res.status === 'ok') {
      expect(res.data['top']?.id).toBe('campaign:1');
      expect(res.data['low']).toBeNull();
    }
  });

  it('error envelope when the campaign service fails', async () => {
    const deps = makeDepsThrowingCampaigns();
    const res = await handleAuction({ slots: [{ slot: 'top', weight: 1 }] }, deps);
    expect(res).toEqual({ status: 'error', reason: 'campaign_service_unavailable' });
  });

  it('fail-soft (all null) when the balance service fails', async () => {
    const deps = makeDepsThrowingBalances([cand(1, 'a', 9000)]);
    const res = await handleAuction({ slots: [{ slot: 'top', weight: 1 }] }, deps);
    if (res.status === 'ok') expect(res.data['top']).toBeNull();
  });
});
