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
});
