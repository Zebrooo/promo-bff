import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorStore, type ErrorPayload } from './error-store';

const cfg = { url: 'https://sb-aa.example.com', serviceRoleKey: 'aa-srk', timeoutMs: 1000 };

const sample: ErrorPayload = {
  service: 'promo-bff',
  source: 'server',
  message: 'boom',
  errorType: 'TypeError',
  stack: 'Error\n    at f (/app/a.js:10:5)',
  route: '/auction',
  method: 'POST',
  statusCode: 500,
  userId: null,
  sessionId: null,
  userAgent: 'Mozilla/5.0',
};

afterEach(() => vi.restoreAllMocks());

describe('createErrorStore (no-op fallback)', () => {
  it('swallows writes when unconfigured', async () => {
    const store = createErrorStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.recordError(sample)).resolves.toBeUndefined();
  });
});

describe('createErrorStore (Supabase)', () => {
  it('POSTs to error_events with snake_case columns, computed fingerprint, Prefer:return=minimal', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    await store.recordError(sample);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sb-aa.example.com/rest/v1/error_events');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Prefer).toBe('return=minimal');
    const sent = JSON.parse(String(init?.body));
    expect(sent.service).toBe('promo-bff');
    expect(sent.error_type).toBe('TypeError');
    expect(sent.status_code).toBe(500);
    expect(sent.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(sent.context).toEqual({});
    expect(sent.environment).toBe('production');
  });

  it('throws on a non-ok write so the caller surfaces 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const store = createErrorStore(cfg);
    await expect(store.recordError(sample)).rejects.toThrow(/HTTP 500/);
  });
});
