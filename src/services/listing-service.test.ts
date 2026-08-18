import { afterEach, describe, expect, it, vi } from 'vitest';
import { createListingService, computeStats, parseLifecycleRow, STALLED_MIN_DAYS, STALLED_MAX_VIEWS } from './listing-service';

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

// ---- lifecycle aggregates (RPC promo_listing_stats, wave B) ----

const activeRow = { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' };

const fullRpcRow = {
  active_count: 2,
  active_categories: ['avto', 'zapchasti'],
  last_sold_at: '2026-08-10T10:00:00+00:00',
  has_stalled_active: true,
  total_count: 5,
  first_created_at: '2025-01-01T00:00:00+00:00',
};

/** Роутит мок по форме вызова: GET таблицы → rows, POST RPC → rpcResult. */
function mockRoutedFetch(rows: unknown[], rpcResult: { status: number; body: unknown } | 'hang') {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/rest/v1/rpc/promo_listing_stats')) {
      if (rpcResult === 'hang') return new Promise<Response>(() => {});
      return {
        ok: rpcResult.status >= 200 && rpcResult.status < 300,
        status: rpcResult.status,
        json: async () => rpcResult.body,
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => rows } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('createListingService — lifecycle RPC', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('POSTs promo_listing_stats with the userId and the stalled thresholds', async () => {
    const fetchMock = mockRoutedFetch([activeRow], { status: 200, body: [fullRpcRow] });
    await createListingService(cfg).getListingStats('u1');
    const rpcCall = fetchMock.mock.calls.find(([u]) => (u as string).includes('/rpc/'));
    expect(rpcCall).toBeDefined();
    const [, init] = rpcCall as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      p_user_id: 'u1',
      p_stalled_min_days: STALLED_MIN_DAYS,
      p_stalled_max_views: STALLED_MAX_VIEWS,
    });
  });

  it('merges the RPC lifecycle aggregates into the row-derived stats', async () => {
    mockRoutedFetch([activeRow], { status: 200, body: [fullRpcRow] });
    const stats = await createListingService(cfg).getListingStats('u1');
    // Row-derived поля — из row-запроса (единый источник для Seller/Listings).
    expect(stats.activeListings).toBe(1);
    expect(stats.activeCategories).toEqual(['avto']);
    // Lifecycle-поля — из RPC.
    expect(stats.lastSoldAt).toBe('2026-08-10T10:00:00+00:00');
    expect(stats.hasStalledActive).toBe(true);
    expect(stats.totalListings).toBe(5);
    expect(stats.firstCreatedAt).toBe('2025-01-01T00:00:00+00:00');
  });

  it('FAIL-SOFT: an RPC error (миграция ещё не применена → 404) leaves lifecycle fields undefined', async () => {
    mockRoutedFetch([activeRow], { status: 404, body: { message: 'function not found' } });
    const stats = await createListingService(cfg).getListingStats('u1');
    expect(stats.activeListings).toBe(1); // остальные гейты живут
    expect(stats.lastSoldAt).toBeUndefined();
    expect(stats.hasStalledActive).toBeUndefined();
    expect(stats.totalListings).toBeUndefined();
    expect(stats.firstCreatedAt).toBeUndefined();
  });

  it('FAIL-SOFT: a hanging RPC is cut by its own 300 ms sub-timeout, row stats still return', async () => {
    vi.useFakeTimers();
    mockRoutedFetch([activeRow], 'hang');
    const pending = createListingService(cfg).getListingStats('u1');
    await vi.advanceTimersByTimeAsync(301);
    const stats = await pending;
    expect(stats.activeListings).toBe(1);
    expect(stats.lastSoldAt).toBeUndefined();
  });

  it('still throws when the ROW query fails (existing contract untouched)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/rpc/')) {
        return { ok: true, status: 200, json: async () => [fullRpcRow] } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(createListingService(cfg).getListingStats('u1')).rejects.toThrow(/HTTP 500/);
  });
});

describe('parseLifecycleRow', () => {
  it('maps a full row and keeps nulls (нет продаж/объявлений) distinct from undefined', () => {
    expect(parseLifecycleRow({ ...fullRpcRow, last_sold_at: null, first_created_at: null })).toEqual({
      lastSoldAt: null,
      hasStalledActive: true,
      totalListings: 5,
      firstCreatedAt: null,
    });
  });

  it('turns malformed fields and non-object rows into undefined (fail closed downstream)', () => {
    expect(parseLifecycleRow(undefined)).toEqual({});
    expect(parseLifecycleRow('garbage')).toEqual({});
    expect(parseLifecycleRow({ last_sold_at: 'not-a-date', has_stalled_active: 'yes', total_count: 1.5, first_created_at: 42 })).toEqual({
      lastSoldAt: undefined,
      hasStalledActive: undefined,
      totalListings: undefined,
      firstCreatedAt: undefined,
    });
  });
});
