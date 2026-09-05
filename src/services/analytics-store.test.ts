import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalyticsStore, type PromoTimelineRow } from './analytics-store';

const cfg = { url: 'https://db.example', serviceRoleKey: 'secret', timeoutMs: 2500 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAnalyticsStore', () => {
  it('returns the RPC result and clears the deadline after a successful fetch', async () => {
    vi.useFakeTimers();
    const rows: PromoTimelineRow[] = [
      { day: '2026-09-05', views: 12, views_visible: 9, cta_clicks: 2 },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => rows,
    }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(createAnalyticsStore(cfg).getPromoTimeline('parts-rfq', 30)).resolves.toEqual(rows);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.example/rest/v1/rpc/promo_analytics_per_promo');
    expect(JSON.parse(init.body as string)).toEqual({ _promo_id: 'parts-rfq', _days: 30 });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(cfg.timeoutMs);
    expect(init.signal?.aborted).toBe(false);
  });

  it('aborts the in-flight RPC when its deadline expires', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    }));

    const pending = createAnalyticsStore(cfg).getPromoTimeline('parts-rfq', 30);
    const rejection = expect(pending).rejects.toThrow(
      'analyticsStore.getPromoTimeline timed out after 2500ms',
    );
    await vi.advanceTimersByTimeAsync(cfg.timeoutMs);
    await rejection;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });
});
