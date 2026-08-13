import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPurchaseLedgerService } from './purchase-ledger-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('createPurchaseLedgerService.getPurchases', () => {
  it('looks up the account then reads charge/listing postings with pack in meta', async () => {
    const fn = mockFetchSequence([
      { status: 200, body: [{ id: 42 }] },
      {
        status: 200,
        body: [
          { amount_kopecks: -49000, created_at: '2026-08-01T00:00:00Z', ledger_transactions: { type: 'charge', subject_kind: 'listing', meta: { pack: 'premium' } } },
          { amount_kopecks: -14900, created_at: '2026-08-05T00:00:00Z', ledger_transactions: { type: 'charge', subject_kind: 'listing', meta: { pack: 'bump' } } },
        ],
      },
    ]);
    const out = await createPurchaseLedgerService(cfg).getPurchases('user-1');
    expect(out).toEqual([
      { pack: 'premium', amountKopecks: 49000, createdAt: '2026-08-01T00:00:00Z' },
      { pack: 'bump', amountKopecks: 14900, createdAt: '2026-08-05T00:00:00Z' },
    ]);
    const accountUrl = (fn.mock.calls[0] as unknown as [string])[0];
    expect(accountUrl).toContain('/rest/v1/ledger_accounts');
    expect(accountUrl).toContain('owner_user_id=eq.user-1');
    expect(accountUrl).toContain('kind=eq.liability');
    const postingsUrl = (fn.mock.calls[1] as unknown as [string])[0];
    expect(postingsUrl).toContain('/rest/v1/ledger_postings');
    expect(postingsUrl).toContain('account_id=eq.42');
    expect(postingsUrl).toContain('ledger_transactions.type=eq.charge');
    expect(postingsUrl).toContain('ledger_transactions.subject_kind=eq.listing');
  });

  it('applies the sinceMs cutoff when given', async () => {
    const fn = mockFetchSequence([{ status: 200, body: [{ id: 1 }] }, { status: 200, body: [] }]);
    await createPurchaseLedgerService(cfg).getPurchases('user-1', Date.parse('2026-08-01T00:00:00Z'));
    const postingsUrl = (fn.mock.calls[1] as unknown as [string])[0];
    expect(postingsUrl).toContain('created_at=gte.2026-08-01T00%3A00%3A00.000Z');
  });

  it('drops rows with an unknown pack value and non-listing/non-charge rows', async () => {
    mockFetchSequence([
      { status: 200, body: [{ id: 1 }] },
      {
        status: 200,
        body: [
          { amount_kopecks: -1, created_at: '2026-08-01T00:00:00Z', ledger_transactions: { type: 'charge', subject_kind: 'listing', meta: { pack: 'unknown' } } },
        ],
      },
    ]);
    const out = await createPurchaseLedgerService(cfg).getPurchases('user-1');
    expect(out).toEqual([]);
  });

  it('returns an empty array when the user has no wallet account', async () => {
    const fn = mockFetchSequence([{ status: 200, body: [] }]);
    const out = await createPurchaseLedgerService(cfg).getPurchases('user-1');
    expect(out).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1); // не делает второй запрос без account id
  });

  it('returns an empty array when unconfigured (no query)', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const out = await createPurchaseLedgerService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getPurchases('user-1');
    expect(out).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createPurchaseLedgerService.getMovement', () => {
  it('sums all postings for the account (no type/subject filter)', async () => {
    const fn = mockFetchSequence([
      { status: 200, body: [{ id: 42 }] },
      { status: 200, body: [{ amount_kopecks: 100000 }, { amount_kopecks: -49000 }] },
    ]);
    const out = await createPurchaseLedgerService(cfg).getMovement('user-1');
    expect(out).toBe(51000);
    const postingsUrl = (fn.mock.calls[1] as unknown as [string])[0];
    expect(postingsUrl).toContain('/rest/v1/ledger_postings');
    expect(postingsUrl).toContain('account_id=eq.42');
    expect(postingsUrl).not.toContain('ledger_transactions');
  });

  it('returns 0 when the user has no wallet account', async () => {
    mockFetchSequence([{ status: 200, body: [] }]);
    expect(await createPurchaseLedgerService(cfg).getMovement('user-1')).toBe(0);
  });
});
