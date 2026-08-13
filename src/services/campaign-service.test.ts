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
      { id: 7, advertiser_id: 'adv-1', cpm_kopecks: 5000, creative: { format: 'popup', title: 'Hi' }, spent_kopecks: 1200, total_budget_kopecks: 30000, daily_budget_kopecks: null, spent_today_kopecks: 0, spent_today_date: null, target_pages: null, banner_format: null },
    ]);
    const out = await createCampaignService(cfg).getCampaignsForSlot('home-popup');
    expect(out).toEqual([{ id: 7, advertiserId: 'adv-1', cpmKopecks: 5000, creative: { format: 'popup', title: 'Hi' }, spentKopecks: 1200, totalBudgetKopecks: 30000, dailyBudgetKopecks: null, spentTodayKopecks: 0, spentTodayDate: null, targetPages: null, bannerFormat: null }]);
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/rest/v1/ad_campaigns');
    expect(url).toContain('status=eq.active');
    expect(url).toContain('slot=eq.home-popup');
    expect(url).toContain('select=id,advertiser_id,cpm_kopecks,creative,spent_kopecks,total_budget_kopecks,daily_budget_kopecks,spent_today_kopecks,spent_today_date,target_pages,banner_format');
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
      { id: 7, advertiser_id: 'adv-1', cpm_kopecks: 5000, creative: { format: 'banner', title: 'B' }, spent_kopecks: 0, total_budget_kopecks: 30000, daily_budget_kopecks: null, spent_today_kopecks: 0, spent_today_date: null, target_pages: ['home'], banner_format: 'horizontal' },
    ]);
    const out = await createCampaignService(cfg).getActiveBannerCampaigns();
    expect(out).toEqual([{ id: 7, advertiserId: 'adv-1', cpmKopecks: 5000, creative: { format: 'banner', title: 'B' }, spentKopecks: 0, totalBudgetKopecks: 30000, dailyBudgetKopecks: null, spentTodayKopecks: 0, spentTodayDate: null, targetPages: ['home'], bannerFormat: 'horizontal' }]);
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/rest/v1/ad_campaigns');
    expect(url).toContain('status=eq.active');
    expect(url).toContain('format=eq.banner');
    expect(url).toContain('select=id,advertiser_id,cpm_kopecks,creative,spent_kopecks,total_budget_kopecks,daily_budget_kopecks,spent_today_kopecks,spent_today_date,target_pages,banner_format');
  });

  it('getActiveBannerCampaigns is a no-op ([]) when unconfigured', async () => {
    const out = await createCampaignService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getActiveBannerCampaigns();
    expect(out).toEqual([]);
  });

  it('selects and maps the daily-budget counter used by auction eligibility', async () => {
    const fn = mockFetch(200, [
      {
        id: 9,
        advertiser_id: 'adv-daily',
        cpm_kopecks: '5000',
        creative: { format: 'banner', title: 'B' },
        spent_kopecks: '1200',
        total_budget_kopecks: null,
        daily_budget_kopecks: '30000',
        spent_today_kopecks: '30000',
        spent_today_date: '2026-08-13',
        target_pages: ['home'],
        banner_format: 'horizontal',
      },
    ]);

    const [campaign] = await createCampaignService(cfg).getActiveBannerCampaigns();

    expect(campaign).toMatchObject({
      dailyBudgetKopecks: 30_000,
      spentTodayKopecks: 30_000,
      spentTodayDate: '2026-08-13',
    });
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('daily_budget_kopecks');
    expect(url).toContain('spent_today_kopecks');
    expect(url).toContain('spent_today_date');
  });
});

describe('createCampaignService — kopeck string coercion (Bug 3)', () => {
  // PostgREST serialises bigint/numeric columns as JSON strings to avoid JS
  // precision loss. Without Number() coercion mapRow holds string values and all
  // downstream arithmetic (budget checks, CPM comparisons in runAuction) is broken.
  afterEach(() => vi.restoreAllMocks());
  function mockFetch(status: number, body: unknown) {
    const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

  it('coerces string cpm_kopecks/spent_kopecks/total_budget_kopecks to numbers', async () => {
    mockFetch(200, [
      {
        id: 7,
        advertiser_id: 'adv-1',
        cpm_kopecks: '9000',           // string from PostgREST numeric column
        creative: { format: 'popup', title: 'Hi' },
        spent_kopecks: '1200',         // string
        total_budget_kopecks: '30000', // string
        target_pages: null,
        banner_format: null,
      },
    ]);
    const [c] = await createCampaignService(cfg).getCampaignsForSlot('home-popup');
    expect(typeof c!.cpmKopecks).toBe('number');
    expect(c!.cpmKopecks).toBe(9000);
    expect(typeof c!.spentKopecks).toBe('number');
    expect(c!.spentKopecks).toBe(1200);
    expect(typeof c!.totalBudgetKopecks).toBe('number');
    expect(c!.totalBudgetKopecks).toBe(30000);
  });

  it('null total_budget_kopecks stays null (unlimited budget)', async () => {
    mockFetch(200, [
      { id: 8, advertiser_id: 'adv-2', cpm_kopecks: '3000', creative: {}, spent_kopecks: '0', total_budget_kopecks: null, target_pages: null, banner_format: null },
    ]);
    const [c] = await createCampaignService(cfg).getCampaignsForSlot('home-popup');
    expect(c!.totalBudgetKopecks).toBeNull();
    expect(typeof c!.cpmKopecks).toBe('number');
  });
});
