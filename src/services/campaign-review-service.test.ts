import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCampaignReviewService, mapCampaignRow } from './campaign-review-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('mapCampaignRow', () => {
  it('maps a full row, coercing numeric strings', () => {
    const row = mapCampaignRow({
      id: '12', advertiser_id: 'adv', status: 'active', created_at: '2026-09-01T00:00:00Z', updated_at: null,
      name: 'Шины', format: 'banner', slot: null, banner_format: 'horizontal',
      cpm_kopecks: '1400', total_budget_kopecks: '100000', daily_budget_kopecks: null, spent_kopecks: 0,
      target_pages: ['home', 3], starts_at: '2026-09-01', creative: { format: 'banner', title: 'T' },
    });
    expect(row).toEqual({
      id: 12, advertiserId: 'adv', status: 'active', createdAt: '2026-09-01T00:00:00Z', updatedAt: null,
      name: 'Шины', format: 'banner', slot: null, bannerFormat: 'horizontal',
      cpmKopecks: 1400, totalBudgetKopecks: 100000, dailyBudgetKopecks: null, spentKopecks: 0,
      targetPages: ['home'], startsAt: '2026-09-01', endsAt: null, creative: { format: 'banner', title: 'T' },
    });
  });

  it('falls back to the creative title when the row has no name and tolerates garbage', () => {
    const row = mapCampaignRow({ id: 1, advertiser_id: 'a', status: 'active', cpm_kopecks: 'nope', creative: { title: 'Заголовок' } });
    expect(row.name).toBe('Заголовок');
    expect(row.cpmKopecks).toBe(0);
    expect(row.totalBudgetKopecks).toBeNull();
    expect(row.targetPages).toBeNull();
  });
});

describe('createCampaignReviewService', () => {
  it('is unconfigured without Supabase creds', async () => {
    const svc = createCampaignReviewService({ url: '', serviceRoleKey: '', timeoutMs: 1 });
    expect(svc.configured).toBe(false);
    expect(await svc.listCampaigns({})).toEqual([]);
    expect(await svc.listCampaignIds({})).toEqual([]);
  });

  it('listCampaignIds asks only for id,status and coerces ids', async () => {
    const fn = mockFetch(200, [{ id: '9', status: 'active' }, { id: 8, status: null }]);
    expect(await createCampaignReviewService(cfg).listCampaignIds({ statuses: ['active'], limit: 5000 })).toEqual([
      { id: 9, status: 'active' }, { id: 8, status: '' },
    ]);
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('select=id,status');
    expect(url).toContain('status=in.(active)');
    expect(url).toContain('limit=5000');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('lists with status + id filters via select=*', async () => {
    const fn = mockFetch(200, [{ id: 5, advertiser_id: 'a', status: 'active', cpm_kopecks: 100 }]);
    const out = await createCampaignReviewService(cfg).listCampaigns({ statuses: ['active', 'pending'], ids: [5, 6], limit: 10 });
    expect(out.map((r) => r.id)).toEqual([5]);
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/rest/v1/ad_campaigns?');
    expect(url).toContain('select=*');
    expect(url).toContain('status=in.(active,pending)');
    expect(url).toContain('id=in.(5,6)');
    expect(url).toContain('limit=10');
    expect(url).toContain('order=id.desc');
  });

  it('skips the query for an explicit empty id list', async () => {
    const fn = mockFetch(200, []);
    expect(await createCampaignReviewService(cfg).listCampaigns({ ids: [] })).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws on a read failure', async () => {
    mockFetch(500, {});
    await expect(createCampaignReviewService(cfg).listCampaigns({})).rejects.toThrow(/HTTP 500/);
  });
});
