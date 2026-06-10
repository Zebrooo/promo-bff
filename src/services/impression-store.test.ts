import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImpressionStore } from './impression-store';

const cfg = { url: 'https://sb.example.com', serviceRoleKey: 'srk', timeoutMs: 1000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createImpressionStore (no-op fallback)', () => {
  it('returns empty maps and swallows writes when unconfigured', async () => {
    const store = createImpressionStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.getImpressions('u1')).resolves.toEqual({ counts: {}, lastShownAt: {} });
    await expect(store.recordImpression('u1', 'p1')).resolves.toBeUndefined();
  });
});

describe('createImpressionStore (Supabase)', () => {
  it('reads counts and last-shown timestamps, keyed by promoId', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { promo_id: 'a', count: 3, last_shown_at: '2024-06-01T10:00:00.000Z' },
          { promo_id: 'b', count: 1, last_shown_at: null },
        ]),
        { status: 200 },
      ),
    );
    const store = createImpressionStore(cfg);
    const data = await store.getImpressions('user 1');

    expect(data.counts).toEqual({ a: 3, b: 1 });
    expect(data.lastShownAt).toEqual({ a: '2024-06-01T10:00:00.000Z' });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://sb.example.com/rest/v1/promo_impressions?user_id=eq.user%201&select=promo_id,count,last_shown_at',
    );
  });

  it('records via the atomic RPC with the p_ argument names', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const store = createImpressionStore(cfg);
    await store.recordImpression('u1', 'p1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sb.example.com/rest/v1/rpc/record_promo_impression');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ p_user_id: 'u1', p_promo_id: 'p1' });
  });

  it('throws on a non-ok read so the caller surfaces an error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const store = createImpressionStore(cfg);
    await expect(store.getImpressions('u1')).rejects.toThrow(/HTTP 500/);
  });
});
