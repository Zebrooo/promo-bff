import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImpressionStore, parseImpressionDevice } from './impression-store';

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
          { promo_id: 'a', count: 3, last_shown_at: '2024-06-01T10:00:00.000Z', last_device: 'touch' },
          { promo_id: 'b', count: 1, last_shown_at: null, last_device: null },
        ]),
        { status: 200 },
      ),
    );
    const store = createImpressionStore(cfg);
    const data = await store.getImpressions('user 1');

    expect(data.counts).toEqual({ a: 3, b: 1 });
    expect(data.lastShownAt).toEqual({ a: '2024-06-01T10:00:00.000Z' });
    expect(data.lastDevice).toEqual({ a: 'touch' });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://sb.example.com/rest/v1/promo_impressions?user_id=eq.user%201&select=*',
    );
  });

  it('read path tolerates a pre-migration table with no last_device column at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ promo_id: 'a', count: 1, last_shown_at: '2024-06-01T10:00:00.000Z' }]), {
        status: 200,
      }),
    );
    const store = createImpressionStore(cfg);
    await expect(store.getImpressions('u1')).resolves.toEqual({
      counts: { a: 1 },
      lastShownAt: { a: '2024-06-01T10:00:00.000Z' },
      lastDevice: {},
    });
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

  it('передаёт устройство показа третьим параметром RPC, а без него — не шлёт p_device вовсе', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const store = createImpressionStore(cfg);
    await store.recordImpression('u1', 'p1', 'app');
    await store.recordImpression('u1', 'p1');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ p_user_id: 'u1', p_promo_id: 'p1', p_device: 'app' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ p_user_id: 'u1', p_promo_id: 'p1' });
  });

  it('parseImpressionDevice принимает только три класса', () => {
    expect(parseImpressionDevice('desktop')).toBe('desktop');
    expect(parseImpressionDevice('touch')).toBe('touch');
    expect(parseImpressionDevice('app')).toBe('app');
    expect(parseImpressionDevice('mobile')).toBeUndefined();
    expect(parseImpressionDevice(42)).toBeUndefined();
  });

  it('throws on a non-ok read so the caller surfaces an error envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const store = createImpressionStore(cfg);
    await expect(store.getImpressions('u1')).rejects.toThrow(/HTTP 500/);
  });
});
