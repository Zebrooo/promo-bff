import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchHistoryService } from './search-history-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'secret', timeoutMs: 2000 };
const now = () => new Date('2026-08-12T12:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe('createSearchHistoryService', () => {
  it('reads a viewer\'s last 30 days, newest first, capped at 100 rows', async () => {
    const fetchMock = mockFetch(200, [
      { query: 'Toyota Camry', section: 'avto', created_at: '2026-08-11T10:00:00.000Z' },
    ]);

    await expect(createSearchHistoryService(cfg, now).getSearchHistory('viewer 1')).resolves.toEqual([
      { query: 'Toyota Camry', section: 'avto', createdAt: '2026-08-11T10:00:00.000Z' },
    ]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestUrl = new URL(url);
    expect(requestUrl.pathname).toBe('/rest/v1/search_queries');
    expect(requestUrl.searchParams.get('select')).toBe('query,section,created_at');
    expect(requestUrl.searchParams.get('viewer_key')).toBe('eq.viewer 1');
    expect(requestUrl.searchParams.getAll('created_at')).toEqual([
      'gte.2026-07-13T12:00:00.000Z',
      'lte.2026-08-12T12:00:00.000Z',
    ]);
    expect(requestUrl.searchParams.get('order')).toBe('created_at.desc');
    expect(requestUrl.searchParams.get('limit')).toBe('100');
    expect(init.headers).toEqual({ apikey: 'secret', Authorization: 'Bearer secret' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns [] without making a request when AA Supabase is unconfigured', async () => {
    const fetchMock = mockFetch(200, []);
    const service = createSearchHistoryService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }, now);
    await expect(service.getSearchHistory('viewer')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores malformed rows without exposing them to the checker', async () => {
    mockFetch(200, [
      null,
      { query: '', section: 'avto', created_at: '2026-08-11T10:00:00.000Z' },
      { query: 'Toyota', section: 123, created_at: '2026-08-11T10:00:00.000Z' },
      { query: 'Honda', section: 'avto', created_at: 'not-a-date' },
      { query: 'Mazda', section: 'avto', created_at: '2026-08-10T10:00:00.000Z' },
    ]);
    await expect(createSearchHistoryService(cfg, now).getSearchHistory('viewer')).resolves.toEqual([
      { query: 'Mazda', section: 'avto', createdAt: '2026-08-10T10:00:00.000Z' },
    ]);
  });

  it('throws on a PostgREST query failure', async () => {
    mockFetch(503, []);
    await expect(createSearchHistoryService(cfg, now).getSearchHistory('viewer')).rejects.toThrow(/HTTP 503/);
  });

  it('caps the optional lookup at 300 ms so generic promo fallback beats the storefront deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const pending = createSearchHistoryService(cfg, now).getSearchHistory('viewer');
    const rejection = expect(pending).rejects.toThrow('timed out after 300ms');
    await vi.advanceTimersByTimeAsync(300);
    await rejection;

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(true);
  });
});
