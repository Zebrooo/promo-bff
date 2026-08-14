import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBalanceService } from './balance-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('createBalanceService.getBalances', () => {
  it('queries kind=liability + owner_user_id=in.() and maps to a Map', async () => {
    const fn = mockFetch(200, [
      { owner_user_id: 'adv-1', balance_kopecks: 5000 },
      { owner_user_id: 'adv-2', balance_kopecks: 0 },
    ]);
    const out = await createBalanceService(cfg).getBalances(['adv-1', 'adv-2']);
    expect(out.get('adv-1')).toBe(5000);
    expect(out.get('adv-2')).toBe(0);
    const url = (fn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/rest/v1/ledger_accounts');
    expect(url).toContain('kind=eq.liability');
    expect(url).toContain('owner_user_id=in.(adv-1,adv-2)');
    expect(url).toContain('select=owner_user_id,balance_kopecks');
  });

  it('omits advertisers with no account row from the map', async () => {
    mockFetch(200, [{ owner_user_id: 'adv-1', balance_kopecks: 100 }]);
    const out = await createBalanceService(cfg).getBalances(['adv-1', 'adv-2']);
    expect(out.get('adv-1')).toBe(100);
    expect(out.has('adv-2')).toBe(false);
  });

  it('returns an empty map for empty input without querying', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const out = await createBalanceService(cfg).getBalances([]);
    expect(out.size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns an empty map when unconfigured (no query)', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const out = await createBalanceService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getBalances(['adv-1']);
    expect(out.size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws on a query failure', async () => {
    mockFetch(500, {});
    await expect(createBalanceService(cfg).getBalances(['adv-1'])).rejects.toThrow(/HTTP 500/);
  });

  it('coerces string-valued balance_kopecks from PostgREST to numbers (Bug 3)', async () => {
    // PostgREST serialises bigint/numeric columns as JSON strings to avoid JS
    // precision loss. Without Number() coercion the map holds string values and
    // all downstream arithmetic (solvency check, budget comparisons) is broken.
    mockFetch(200, [
      { owner_user_id: 'adv-1', balance_kopecks: '5000' },  // string from PostgREST
      { owner_user_id: 'adv-2', balance_kopecks: '0' },
    ]);
    const out = await createBalanceService(cfg).getBalances(['adv-1', 'adv-2']);
    expect(typeof out.get('adv-1')).toBe('number');
    expect(out.get('adv-1')).toBe(5000);
    expect(typeof out.get('adv-2')).toBe('number');
    expect(out.get('adv-2')).toBe(0);
  });

  // Mirrors purchase-ledger-service.ts's TIMEOUT_MS cap: this read runs inside
  // loadWalletDataForSelection's Promise.all alongside the ledger reads, which
  // are already capped at 300ms against the storefront's selection deadline. A
  // hanging fetch must not be allowed to ride the general cfg.timeoutMs (2500ms
  // default) — it has to time out at the same 300ms budget.
  it('caps the timeout at 300ms even when cfg.timeoutMs is much higher', async () => {
    const hang = () => new Promise<Response>(() => {}); // never resolves
    vi.stubGlobal('fetch', vi.fn(hang));
    await expect(
      createBalanceService({ url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 }).getBalances(['adv-1']),
    ).rejects.toThrow(/timed out after 300ms/);
  });

  it('still honours a tighter cfg.timeoutMs when it is below 300ms (Math.min, not a floor)', async () => {
    const hang = () => new Promise<Response>(() => {}); // never resolves
    vi.stubGlobal('fetch', vi.fn(hang));
    await expect(
      createBalanceService({ url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 50 }).getBalances(['adv-1']),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});
