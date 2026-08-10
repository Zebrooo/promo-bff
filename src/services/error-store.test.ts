import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorStore, type ErrorPayload } from './error-store';
import { fingerprint } from './fingerprint';

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
    const payload = { ...sample, context: { kind: 'fetch', attempt: 2 } };
    await store.recordError(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sb-aa.example.com/rest/v1/error_events');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Prefer).toBe('return=minimal');
    const sent = JSON.parse(String(init?.body));
    expect(sent.service).toBe('promo-bff');
    expect(sent.error_type).toBe('TypeError');
    expect(sent.status_code).toBe(500);
    expect(sent.fingerprint).toBe(fingerprint(payload.message, payload.stack, payload.errorType, {
      service: payload.service,
      route: payload.route,
      method: payload.method,
      statusCode: payload.statusCode,
      kind: payload.context.kind,
    }));
    expect(sent.context).toEqual({ kind: 'fetch', attempt: 2 });
    expect(sent.environment).toBe('production');
  });

  it('uses request metadata when computing the fingerprint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);

    await store.recordError({ ...sample, route: '/api/foo/123', context: { kind: 'fetch' } });
    await store.recordError({
      ...sample,
      route: '/api/bar/123',
      method: 'GET',
      statusCode: 404,
      context: { kind: 'resource' },
    });

    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('persists canonical metadata and fingerprints the same normalized values', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    const payload: ErrorPayload = {
      ...sample,
      method: ' post ',
      statusCode: 201,
      context: { kind: ' fetch ', url: '/api/items/123?token=private', attempt: 2 },
    };

    await store.recordError(payload);

    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.method).toBe('POST');
    expect(sent.status_code).toBe(201);
    expect(sent.context).toEqual({ kind: 'fetch', url: '/api/items/123?token=private', attempt: 2 });
    expect(sent.fingerprint).toBe(fingerprint(payload.message, payload.stack, payload.errorType, {
      service: payload.service,
      route: payload.route,
      endpoint: '/api/items/123?token=private',
      method: 'POST',
      statusCode: 201,
      kind: 'fetch',
    }));
  });

  it('persists invalid HTTP metadata safely and buckets a PII kind without retaining it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    const payload: ErrorPayload = {
      ...sample,
      method: 'RANDOM',
      statusCode: 700,
      context: { kind: 'alice@example.com', url: '/api/private', attempt: 3 },
    };

    await store.recordError(payload);

    const rawBody = String(fetchMock.mock.calls[0][1]?.body);
    const sent = JSON.parse(rawBody);
    expect(sent.method).toBeNull();
    expect(sent.status_code).toBeNull();
    expect(sent.context).toEqual({ kind: 'other', url: '/api/private', attempt: 3 });
    expect(rawBody).not.toContain('alice@example.com');
    expect(sent.fingerprint).toBe(fingerprint(payload.message, payload.stack, payload.errorType, {
      service: payload.service,
      route: payload.route,
      endpoint: '/api/private',
      method: null,
      statusCode: null,
      kind: 'other',
    }));
  });

  it('omits non-string context.kind and other non-string HTTP metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    const payload = {
      ...sample,
      method: { injected: 'POST' },
      statusCode: '500',
      context: { kind: { email: 'alice@example.com' }, attempt: 4 },
    } as unknown as ErrorPayload;

    await store.recordError(payload);

    const rawBody = String(fetchMock.mock.calls[0][1]?.body);
    const sent = JSON.parse(rawBody);
    expect(sent.method).toBeNull();
    expect(sent.status_code).toBeNull();
    expect(sent.context).toEqual({ attempt: 4 });
    expect(rawBody).not.toContain('alice@example.com');
    expect(sent.fingerprint).toBe(fingerprint(payload.message, payload.stack, payload.errorType, {
      service: payload.service,
      route: payload.route,
      method: null,
      statusCode: null,
      kind: null,
    }));
  });

  it('uses the service-specific trusted route templates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);

    await store.recordError({ ...sample, service: 'abkhaz-auto', route: '/alice-private' });
    await store.recordError({ ...sample, service: 'abkhaz-auto', route: '/bob-private' });

    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('uses context.url as the fetch endpoint without splitting endpoint ids or queries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    const pageError = { ...sample, route: '/u/alice', method: null, statusCode: null };

    await store.recordError({
      ...pageError,
      context: { kind: 'fetch', url: 'https://api.example.com/api/items/123?user=alice#private' },
    });
    await store.recordError({ ...pageError, context: { kind: 'fetch', url: '/api/items/456?user=bob#different' } });
    await store.recordError({ ...pageError, context: { kind: 'fetch', url: '/api/a?user=alice' } });
    await store.recordError({ ...pageError, context: { kind: 'fetch', url: '/api/b#private' } });

    const sent = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(sent[0].fingerprint).toBe(sent[1].fingerprint);
    expect(sent[2].fingerprint).not.toBe(sent[3].fingerprint);
  });

  it('normalizes fetch kind before using context.url as the endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    const pageError = { ...sample, route: '/u/alice', method: null, statusCode: null };

    await store.recordError({ ...pageError, context: { kind: ' fetch ', url: '/api/a' } });
    await store.recordError({ ...pageError, context: { kind: ' fetch ', url: '/api/b' } });

    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('does not include resource URLs in the fingerprint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createErrorStore(cfg);
    const pageError = { ...sample, route: '/u/alice', method: null, statusCode: null };

    await store.recordError({ ...pageError, context: { kind: 'resource', url: 'https://cdn.example.com/alice.jpg' } });
    await store.recordError({ ...pageError, context: { kind: 'resource', url: 'https://cdn.example.com/bob.jpg' } });

    const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('throws on a non-ok write so the caller surfaces 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const store = createErrorStore(cfg);
    await expect(store.recordError(sample)).rejects.toThrow(/HTTP 500/);
  });
});
