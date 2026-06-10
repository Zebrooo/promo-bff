import { afterEach, describe, expect, it, vi } from 'vitest';
import { createListingService } from './listing-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, contentRange: string | null) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-range' ? contentRange : null) },
    json: async () => [],
  }) as unknown as Response));
}

describe('createListingService', () => {
  it('returns the active-listing count from the Content-Range header', async () => {
    mockFetch(200, '0-0/7');
    expect(await createListingService(cfg).getListingStats('seller')).toEqual({ activeListings: 7 });
  });

  it('returns 0 when the user has no active listings', async () => {
    mockFetch(200, '*/0');
    expect(await createListingService(cfg).getListingStats('buyer')).toEqual({ activeListings: 0 });
  });

  it('returns 0 when unconfigured (no query)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await createListingService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getListingStats('u1')).toEqual({ activeListings: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a query failure', async () => {
    mockFetch(500, null);
    await expect(createListingService(cfg).getListingStats('u1')).rejects.toThrow(/HTTP 500/);
  });
});
