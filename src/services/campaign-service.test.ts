import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaignService } from './campaign-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('createCampaignService.getCampaignsForSlot', () => {
  it('queries status=active + slot and maps rows to candidates', async () => {
    const fn = mockFetch(200, [
      { id: 7, advertiser_id: 'adv-1', cpm_kopecks: 5000, creative: { format: 'popup', title: 'Hi' }, spent_kopecks: 1200, total_budget_kopecks: 30000, target_pages: null, banner_format: null },
    ]);
    const out = await createCampaignService(cfg).getCampaignsForSlot('home-popup');
    expect(out).toEqual([{ id: 7, advertiserId: 'adv-1', cpmKopecks: 5000, creative: { format: 'popup', title: 'Hi' }, spentKopecks: 1200, totalBudgetKopecks: 30000, targetPages: null, bannerFormat: null }]);
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/rest/v1/ad_campaigns');
    expect(url).toContain('status=eq.active');
    expect(url).toContain('slot=eq.home-popup');
    expect(url).toContain('select=id,advertiser_id,cpm_kopecks,creative,spent_kopecks,total_budget_kopecks,target_pages,banner_format');
  });

  it('maps a null total budget to null', async () => {
    mockFetch(200, [
      { id: 8, advertiser_id: 'adv-2', cpm_kopecks: 3000, creative: { format: 'popup', title: 'X' }, spent_kopecks: 0, total_budget_kopecks: null },
    ]);
    const out = await createCampaignService(cfg).getCampaignsForSlot('home-popup');
    expect(out[0]!.totalBudgetKopecks).toBeNull();
    expect(out[0]!.spentKopecks).toBe(0);
  });

  it('returns [] for zero rows', async () => {
    mockFetch(200, []);
    expect(await createCampaignService(cfg).getCampaignsForSlot('home-popup')).toEqual([]);
  });

  it('returns [] when unconfigured (no query)', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect(await createCampaignService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getCampaignsForSlot('home-popup')).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws on a query failure', async () => {
    mockFetch(500, {});
    await expect(createCampaignService(cfg).getCampaignsForSlot('home-popup')).rejects.toThrow(/HTTP 500/);
  });
});

describe('createCampaignService.getActiveBannerCampaigns', () => {
  it('getActiveBannerCampaigns queries status=active + format=banner', async () => {
    const fn = mockFetch(200, [
      { id: 7, advertiser_id: 'adv-1', cpm_kopecks: 5000, creative: { format: 'banner', title: 'B' }, spent_kopecks: 0, total_budget_kopecks: 30000, target_pages: ['home'], banner_format: 'horizontal' },
    ]);
    const out = await createCampaignService(cfg).getActiveBannerCampaigns();
    expect(out).toEqual([{ id: 7, advertiserId: 'adv-1', cpmKopecks: 5000, creative: { format: 'banner', title: 'B' }, spentKopecks: 0, totalBudgetKopecks: 30000, targetPages: ['home'], bannerFormat: 'horizontal' }]);
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/rest/v1/ad_campaigns');
    expect(url).toContain('status=eq.active');
    expect(url).toContain('format=eq.banner');
    expect(url).toContain('select=id,advertiser_id,cpm_kopecks,creative,spent_kopecks,total_budget_kopecks,target_pages,banner_format');
  });

  it('getActiveBannerCampaigns is a no-op ([]) when unconfigured', async () => {
    const out = await createCampaignService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getActiveBannerCampaigns();
    expect(out).toEqual([]);
  });
});
