import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventStore, type EventPayload } from './event-store';

const cfg = { url: 'https://sb-aa.example.com', serviceRoleKey: 'aa-srk', timeoutMs: 1000 };

const samplePayload: EventPayload = {
  eventName: 'listing_share',
  props: { listing_id: 42, source: 'izbrannoe' },
  pagePath: '/lk/izbrannoe',
  sessionId: 'sid-xyz',
  userId: 'user-1',
  userAgent: 'Mozilla/5.0',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEventStore (no-op fallback)', () => {
  it('swallows writes when unconfigured', async () => {
    const store = createEventStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.recordEvent(samplePayload)).resolves.toBeUndefined();
  });
});

describe('createEventStore (Supabase)', () => {
  it('POSTs to user_action_events with snake_case columns and Prefer:return=minimal', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    const store = createEventStore(cfg);
    await store.recordEvent(samplePayload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://sb-aa.example.com/rest/v1/user_action_events');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.apikey).toBe('aa-srk');
    expect(headers.Authorization).toBe('Bearer aa-srk');
    expect(headers['content-type']).toBe('application/json');
    expect(headers.Prefer).toBe('return=minimal');
    expect(JSON.parse(String(init?.body))).toEqual({
      event_name: 'listing_share',
      props: { listing_id: 42, source: 'izbrannoe' },
      page_path: '/lk/izbrannoe',
      session_id: 'sid-xyz',
      user_id: 'user-1',
      user_agent: 'Mozilla/5.0',
    });
  });

  it('passes null user_id / page_path / session_id / user_agent through for anonymous beacons', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    const store = createEventStore(cfg);
    await store.recordEvent({
      eventName: 'phone_reveal',
      props: {},
      pagePath: null,
      sessionId: null,
      userId: null,
      userAgent: null,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.user_id).toBeNull();
    expect(body.page_path).toBeNull();
    expect(body.session_id).toBeNull();
    expect(body.user_agent).toBeNull();
    expect(body.props).toEqual({});
  });

  it('throws on a non-ok write so the caller surfaces 502', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const store = createEventStore(cfg);
    await expect(store.recordEvent(samplePayload)).rejects.toThrow(/HTTP 500/);
  });

  it('throws when Supabase REST returns 401 (bad service-role key)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('jwt', { status: 401 }));
    const store = createEventStore(cfg);
    await expect(store.recordEvent(samplePayload)).rejects.toThrow(/HTTP 401/);
  });
});
