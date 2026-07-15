import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReferralConfigService, type ReferralConfigPayload } from './referral-config-service';

const cfg = { url: 'https://sb-aa.example.com', serviceRoleKey: 'aa-srk', timeoutMs: 1000 };

const samplePayload: ReferralConfigPayload = {
  active: true,
  inviterCreditKopecks: 50000,
  sellerBonusKopecks: 20000,
  dailyInviteCap: 5,
  holdHours: 72,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createReferralConfigService (no-op fallback)', () => {
  it('swallows writes when unconfigured', async () => {
    const service = createReferralConfigService({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(service.sync(samplePayload)).resolves.toBeUndefined();
  });
});

describe('createReferralConfigService (Supabase)', () => {
  it('upserts referral_config id=1 with snake_case columns and merge-duplicates', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    const service = createReferralConfigService(cfg);
    await service.sync(samplePayload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sb-aa.example.com/rest/v1/referral_config?on_conflict=id');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.apikey).toBe('aa-srk');
    expect(headers.Authorization).toBe('Bearer aa-srk');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.Prefer).toBe('resolution=merge-duplicates,return=minimal');

    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      id: 1,
      active: true,
      inviter_credit_kopecks: 50000,
      seller_bonus_kopecks: 20000,
      daily_invite_cap: 5,
      hold_hours: 72,
    });
    expect(typeof body.updated_at).toBe('string');
  });

  it('is idempotent — replaying the same payload issues the same upsert', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    const service = createReferralConfigService(cfg);
    await service.sync(samplePayload);
    await service.sync(samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init1] = fetchMock.mock.calls[0];
    const [, init2] = fetchMock.mock.calls[1];
    const b1 = JSON.parse(String(init1?.body));
    const b2 = JSON.parse(String(init2?.body));
    expect({ ...b1, updated_at: undefined }).toEqual({ ...b2, updated_at: undefined });
  });

  it('throws on a non-ok write so the caller can treat it as best-effort failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const service = createReferralConfigService(cfg);
    await expect(service.sync(samplePayload)).rejects.toThrow(/HTTP 500/);
  });

  it('throws when Supabase REST returns 401 (bad service-role key)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('jwt', { status: 401 }));
    const service = createReferralConfigService(cfg);
    await expect(service.sync(samplePayload)).rejects.toThrow(/HTTP 401/);
  });
});
