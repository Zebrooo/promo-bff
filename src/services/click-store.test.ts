import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClickStore } from './click-store';

const cfg = { url: 'https://sb.example.com', serviceRoleKey: 'srk', timeoutMs: 1000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createClickStore (no-op fallback)', () => {
  it('returns empty counts and swallows writes when unconfigured', async () => {
    const store = createClickStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.getClicks('u1')).resolves.toEqual({ counts: {} });
    await expect(store.recordClick('u1', 'p1', 'cta')).resolves.toBeUndefined();
  });
});

describe('createClickStore (Supabase)', () => {
  it('reads counts keyed by promoId, summing kinds of the same promo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([
        { promo_id: 'a', count: 2 },    // kind cta
        { promo_id: 'a', count: 1 },    // kind conversion — схлопывается суммой
        { promo_id: 'b', count: 1 },
        { promo_id: 'c', count: null }, // битая строка — игнорируется
      ]), { status: 200 }),
    );
    const store = createClickStore(cfg);
    const data = await store.getClicks('user 1');
    expect(data.counts).toEqual({ a: 3, b: 1 });
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://sb.example.com/rest/v1/promo_clicks?user_id=eq.user%201&select=promo_id,count',
    );
  });

  it('records via the RPC with the p_ argument names', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const store = createClickStore(cfg);
    await store.recordClick('u1', 'p1', 'cta');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sb.example.com/rest/v1/rpc/record_promo_click');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ p_user_id: 'u1', p_promo_id: 'p1', p_kind: 'cta' });
  });

  it('throws on a non-ok read so the supplier can degrade to {}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const store = createClickStore(cfg);
    await expect(store.getClicks('u1')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a non-ok write', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 502 }));
    const store = createClickStore(cfg);
    await expect(store.recordClick('u1', 'p1', 'conversion')).rejects.toThrow(/HTTP 502/);
  });
});
