import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChargeService, parseCampaignId } from './charge-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('parseCampaignId', () => {
  it('extracts the numeric id from a campaign: promo id', () => {
    expect(parseCampaignId('campaign:7')).toBe(7);
    expect(parseCampaignId('campaign:0')).toBe(0);
  });
  it('returns null for non-campaign or malformed ids', () => {
    expect(parseCampaignId('summer-sale')).toBeNull();
    expect(parseCampaignId('campaign:')).toBeNull();
    expect(parseCampaignId('campaign:x')).toBeNull();
    expect(parseCampaignId('campaign:7x')).toBeNull();
    expect(parseCampaignId('')).toBeNull();
  });
});

describe('createChargeService.recordCampaignImpression', () => {
  it('POSTs to the record_campaign_impression RPC with campaign id + user', async () => {
    const fn = mockFetch(204);
    await createChargeService(cfg).recordCampaignImpression(7, 'u1');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/rest/v1/rpc/record_campaign_impression');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ p_campaign_id: 7, p_user_id: 'u1' });
  });

  it('is a no-op when unconfigured (no query)', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    await createChargeService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).recordCampaignImpression(7, 'u1');
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws on a failed charge', async () => {
    mockFetch(500);
    await expect(createChargeService(cfg).recordCampaignImpression(7, 'u1')).rejects.toThrow(/HTTP 500/);
  });

  it('aborts the fetch signal when the timeout fires (prevents double-charge on slow RPC)', async () => {
    // This proves Bug 1 is fixed: the fetch is called with an AbortSignal, and that
    // signal becomes aborted when the withTimeout deadline fires. Without the fix,
    // a slow-but-successful Supabase RPC would complete after the 502 response is
    // sent, causing the storefront to retry → two charges for one impression.
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      // Simulate a slow Supabase response that arrives AFTER the BFF timeout.
      await new Promise<never>(() => {}); // never resolves
    }));
    const shortTimeout = { ...cfg, timeoutMs: 20 };
    await expect(
      createChargeService(shortTimeout).recordCampaignImpression(7, 'u1'),
    ).rejects.toBeInstanceOf(Error); // TimeoutError
    // The key assertion: the fetch was given a signal and it was aborted.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});
