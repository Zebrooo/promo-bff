import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBillingService } from './billing-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response));
}

describe('createBillingService', () => {
  it('maps is_pro:true to plus', async () => {
    mockFetch(200, [{ is_pro: true }]);
    expect(await createBillingService(cfg).getSubscription('u1')).toEqual({ level: 'plus' });
  });

  it('maps is_pro:false to none', async () => {
    mockFetch(200, [{ is_pro: false }]);
    expect(await createBillingService(cfg).getSubscription('u1')).toEqual({ level: 'none' });
  });

  it('returns none for a missing row', async () => {
    mockFetch(200, []);
    expect(await createBillingService(cfg).getSubscription('anon')).toEqual({ level: 'none' });
  });

  it('returns none when unconfigured (no query)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await createBillingService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getSubscription('u1')).toEqual({ level: 'none' });
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a query failure', async () => {
    mockFetch(503, {});
    await expect(createBillingService(cfg).getSubscription('u1')).rejects.toThrow(/HTTP 503/);
  });
});
