import { afterEach, describe, expect, it, vi } from 'vitest';
import { createListingService, computeStats } from './listing-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };
const NOW_MS = Date.parse('2026-08-13T12:00:00.000Z');

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, rows: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => rows,
  }) as unknown as Response));
}

describe('computeStats', () => {
  it('returns empty stats for no rows', () => {
    expect(computeStats([], NOW_MS)).toEqual({
      activeListings: 0,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
    });
  });

  it('collects everCategories from all statuses, activeCategories only from active', () => {
    const rows = [
      { category_slug: 'avto', status: 'active', promotion: 'vip', promotion_until: '2026-09-01T00:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z' },
      { category_slug: 'realty', status: 'archived', promotion: 'none', promotion_until: null, created_at: '2026-07-01T00:00:00.000Z' },
    ];
    const stats = computeStats(rows, NOW_MS);
    expect([...stats.everCategories].sort()).toEqual(['avto', 'realty']);
    expect(stats.activeCategories).toEqual(['avto']);
  });

  it('dedupes categories across multiple listings in the same category', () => {
    const rows = [
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' },
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-02T00:00:00.000Z' },
    ];
    expect(computeStats(rows, NOW_MS).activeCategories).toEqual(['avto']);
  });

  it('hasUnpromotedActive: true when an active listing has promotion=none', () => {
    const rows = [{ category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(true);
  });

  it('hasUnpromotedActive: true when promotion_until is in the past, even if promotion is set', () => {
    const rows = [{ category_slug: 'avto', status: 'active', promotion: 'vip', promotion_until: '2026-01-01T00:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(true);
  });

  it('hasUnpromotedActive: false when the only active listing has a live promotion', () => {
    const rows = [{ category_slug: 'avto', status: 'active', promotion: 'vip', promotion_until: '2026-09-01T00:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(false);
  });

  it('hasUnpromotedActive: false when the unpromoted listing is not active', () => {
    const rows = [{ category_slug: 'avto', status: 'archived', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(false);
  });

  it('daysSinceLastListing: computed from the most recent created_at across ALL statuses', () => {
    const rows = [
      { category_slug: 'avto', status: 'archived', promotion: 'none', promotion_until: null, created_at: '2026-08-06T12:00:00.000Z' },
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-07-01T12:00:00.000Z' },
    ];
    expect(computeStats(rows, NOW_MS).daysSinceLastListing).toBe(7);
  });
});

describe('createListingService', () => {
  it('computes activeListings from the returned rows, not a Content-Range header', async () => {
    mockFetch(200, [
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' },
      { category_slug: 'avto', status: 'sold', promotion: 'none', promotion_until: null, created_at: '2026-07-01T00:00:00.000Z' },
    ]);
    const stats = await createListingService(cfg).getListingStats('seller');
    expect(stats.activeListings).toBe(1);
  });

  it('returns empty stats when unconfigured (no query)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const stats = await createListingService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getListingStats('u1');
    expect(stats).toEqual({
      activeListings: 0,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a query failure', async () => {
    mockFetch(500);
    await expect(createListingService(cfg).getListingStats('u1')).rejects.toThrow(/HTTP 500/);
  });
});
