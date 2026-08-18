import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBehaviorSignalService } from './behavior-signal-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'secret', timeoutMs: 2000 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const rpcBody = {
  interests: [{ category: 'shiny', lastViewedAt: '2026-08-16T10:00:00+00:00' }],
  phoneViews7d: 3,
};

describe('createBehaviorSignalService', () => {
  it('POSTs the RPC with service-role auth and maps the aggregates', async () => {
    const fetchMock = mockFetch(200, rpcBody);
    await expect(createBehaviorSignalService(cfg).getSignal('s:abc', 'u-1')).resolves.toEqual({
      interests: [{ category: 'shiny', lastViewedAt: '2026-08-16T10:00:00+00:00' }],
      phoneViews7d: 3,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.example/rest/v1/rpc/promo_viewer_behavior');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      apikey: 'secret',
      Authorization: 'Bearer secret',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ p_viewer_key: 's:abc', p_user_id: 'u-1' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends p_user_id: null for anonymous viewers (не пустая строка)', async () => {
    const fetchMock = mockFetch(200, rpcBody);
    await createBehaviorSignalService(cfg).getSignal('s:abc');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ p_viewer_key: 's:abc', p_user_id: null });
  });

  it('is a no-op returning an empty signal when AA Supabase is unconfigured', async () => {
    const fetchMock = mockFetch(200, rpcBody);
    const service = createBehaviorSignalService({ url: '', serviceRoleKey: '', timeoutMs: 2000 });
    await expect(service.getSignal('s:abc')).resolves.toEqual({ interests: [], phoneViews7d: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on HTTP error and on a malformed body (interests не массив)', async () => {
    mockFetch(503, {});
    await expect(createBehaviorSignalService(cfg).getSignal('s:abc')).rejects.toThrow(/HTTP 503/);
    mockFetch(200, { interests: 'nope', phoneViews7d: 1 });
    await expect(createBehaviorSignalService(cfg).getSignal('s:abc')).rejects.toThrow(/invalid response/);
  });

  it('drops malformed interest rows instead of exposing them to checkers', async () => {
    mockFetch(200, {
      interests: [
        null,
        { category: '', lastViewedAt: '2026-08-16T10:00:00+00:00' },
        { category: 'shiny', lastViewedAt: 'not-a-date' },
        { category: 'diski', lastViewedAt: '2026-08-15T10:00:00+00:00' },
      ],
      phoneViews7d: 0,
    });
    await expect(createBehaviorSignalService(cfg).getSignal('s:abc')).resolves.toEqual({
      interests: [{ category: 'diski', lastViewedAt: '2026-08-15T10:00:00+00:00' }],
      phoneViews7d: 0,
    });
  });

  it('caps the optional lookup at 300 ms (внутри бюджета сайта 800 мс)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const pending = createBehaviorSignalService(cfg).getSignal('s:abc');
    const rejection = expect(pending).rejects.toThrow('timed out after 300ms');
    await vi.advanceTimersByTimeAsync(300);
    await rejection;
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it('serves the second call within 60 s from cache and refetches after expiry', async () => {
    let nowMs = 1_000_000;
    const fetchMock = mockFetch(200, rpcBody);
    const service = createBehaviorSignalService(cfg, () => nowMs);

    await service.getSignal('s:abc', 'u-1');
    await service.getSignal('s:abc', 'u-1'); // три роута одной страницы
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await service.getSignal('s:other'); // другой зритель — свой fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowMs += 60_001;
    await service.getSignal('s:abc', 'u-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a failed fetch is not cached: the next call retries', async () => {
    let nowMs = 1_000_000;
    const service = createBehaviorSignalService(cfg, () => nowMs);
    mockFetch(503, {});
    await expect(service.getSignal('s:abc')).rejects.toThrow(/HTTP 503/);
    const fetchMock = mockFetch(200, rpcBody);
    await expect(service.getSignal('s:abc')).resolves.toEqual(rpcBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
