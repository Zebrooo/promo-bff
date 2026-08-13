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

function responsiveCand(id: number, advertiserId: string, cpmKopecks: number): CampaignCandidate {
  return {
    ...cand(id, advertiserId, cpmKopecks),
    bannerFormat: 'horizontal',
    creative: {
      format: 'banner',
      title: 'responsive',
      imageUrl: 'https://i/legacy.png',
      imageVariants: {
        wide: { imageUrl: 'https://i/wide.png', width: 1200, height: 150 },
        compact: { imageUrl: 'https://i/compact.png', width: 580, height: 120 },
      },
    },
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

  it('passes sequence exposure without leaking request metadata into the response', async () => {
    const deps = makeDeps(
      [cand(1, 'a', 9000), cand(2, 'a', 3000)],
      new Map([['a', 10]]),
    );
    const res = await handleAuction({
      slots: [{ slot: 'first', weight: 1 }, { slot: 'second', weight: 2 }],
      exposure: 'sequence',
    }, deps);

    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data.first?.id).toBe('campaign:1');
      expect(res.data.second?.id).toBe('campaign:2');
      expect(res).not.toHaveProperty('exposure');
      expect(res.data).not.toHaveProperty('exposure');
      expect(res.data.first).not.toHaveProperty('advertiserId');
      expect(res.data.second).not.toHaveProperty('advertiserId');
    }
  });

  it('passes mixed sequence-group metadata to allocation', async () => {
    const deps = makeDeps(
      [cand(1, 'a', 9000), cand(2, 'a', 8000), cand(3, 'b', 7000)],
      new Map([['a', 10], ['b', 10]]),
    );
    const res = await handleAuction({
      slots: [
        { slot: 'slide-1', weight: 1, sequenceGroup: 'hero' },
        { slot: 'static', weight: 2 },
        { slot: 'slide-2', weight: 3, sequenceGroup: 'hero' },
      ],
      exposure: 'mixed',
    }, deps);

    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data['slide-1']?.id).toBe('campaign:1');
      expect(res.data.static?.id).toBe('campaign:3');
      expect(res.data['slide-2']?.id).toBe('campaign:2');
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

  it('renders the same winning campaign for the actual slot size on each request', async () => {
    const candidate = responsiveCand(1, 'a', 9000);
    const deps = makeDeps([candidate], new Map([['a', 10]]));

    const compact = await handleAuction({
      slots: [{ slot: 'top', weight: 1, format: 'horizontal', width: 580, height: 120 }],
    }, deps);
    const wide = await handleAuction({
      slots: [{ slot: 'inline', weight: 1, format: 'horizontal', width: 820, height: 96 }],
    }, deps);

    expect(compact.status).toBe('ok');
    expect(wide.status).toBe('ok');
    if (compact.status === 'ok' && wide.status === 'ok') {
      expect(compact.data.top?.imageUrl).toBe('https://i/compact.png');
      expect(wide.data.inline?.imageUrl).toBe('https://i/wide.png');
      expect(compact.data.top).not.toHaveProperty('imageVariants');
      expect(wide.data.inline).not.toHaveProperty('imageVariants');
    }
  });
});
