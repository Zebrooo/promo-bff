import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelectionTraceService, TRACE_FLUSH_INTERVAL_MS } from './selection-trace';
import type { SelectionTrace } from '../promo-selector';

const cfg = { url: 'https://sb-aa.example.com', serviceRoleKey: 'aa-srk', timeoutMs: 1000 };

interface SentRow {
  ts: string;
  user_id: string;
  queue: string;
  device: string | null;
  section: string | null;
  category: string | null;
  formats: string[];
  exclude_ids: string[];
  env: { os?: string; runtime?: string; brand?: string } | null;
  selected_promo_id: string | null;
  outcome: string;
  candidates: SelectionTrace['candidates'];
}

function makeTrace(selected: string | null = 'p1'): SelectionTrace {
  return {
    candidates: [
      {
        promoId: 'p1',
        checks: [
          { checker: 'date', outcome: 'pass', reason: '' },
          { checker: 'cooldown', outcome: 'fail', reason: 'now - lastShownAt >= cooldownHours' },
        ],
      },
    ],
    selectedPromoId: selected,
  };
}

function sentRows(fetchMock: { mock: { calls: unknown[][] } }, call = 0): SentRow[] {
  const [, init] = fetchMock.mock.calls[call] as [unknown, RequestInit];
  return JSON.parse(String(init.body)) as SentRow[];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-03T08:30:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('selection-trace service', () => {
  it('is a no-op when AA Supabase is unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg: { url: '', serviceRoleKey: '', timeoutMs: 1000 } });
    svc.record({ userId: 'u1', queue: 'cabinet-onboarding', trace: makeTrace() });
    await svc.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records one row per request with identity, context and the full trace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg });

    svc.record({
      userId: 'c90d8321',
      queue: 'cabinet-onboarding',
      device: 'touch',
      section: 'lk',
      category: undefined,
      formats: ['custom', 'tooltip'],
      excludeIds: ['cab-onb-1-where'],
      env: { os: 'ios', runtime: 'telegram', brand: 'iphone' },
      trace: makeTrace('cabinet-onboarding-intro'),
    });
    await svc.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(urlArg).toBe(`${cfg.url}/rest/v1/promo_selection_traces`);
    expect((init.headers as Record<string, string>).apikey).toBe('aa-srk');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=minimal');

    const rows = sentRows(fetchMock);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: '2026-07-03T08:30:00.000Z',
      user_id: 'c90d8321',
      queue: 'cabinet-onboarding',
      device: 'touch',
      section: 'lk',
      category: null,
      formats: ['custom', 'tooltip'],
      exclude_ids: ['cab-onb-1-where'],
      env: { os: 'ios', runtime: 'telegram', brand: 'iphone' },
      selected_promo_id: 'cabinet-onboarding-intro',
      outcome: 'selected',
    });
    expect(rows[0].candidates).toEqual(makeTrace().candidates);
  });

  it('marks outcome no_promo and null winner when nothing passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg });

    svc.record({ userId: 'u1', queue: 'home-popup', trace: makeTrace(null) });
    await svc.flush();

    const rows = sentRows(fetchMock);
    expect(rows[0].selected_promo_id).toBeNull();
    expect(rows[0].outcome).toBe('no_promo');
    expect(rows[0].device).toBeNull();
    expect(rows[0].formats).toEqual([]);
    expect(rows[0].exclude_ids).toEqual([]);
    expect(rows[0].env).toBeNull();
  });

  it('batches many records into a single insert', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg });

    svc.record({ userId: 'u1', queue: 'q', trace: makeTrace('p1') });
    svc.record({ userId: 'u2', queue: 'q', trace: makeTrace(null) });
    svc.record({ userId: 'u3', queue: 'q', trace: makeTrace('p1') });
    await svc.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentRows(fetchMock)).toHaveLength(3);
  });

  it('flushes nothing when the buffer is empty', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg });
    await svc.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-buffers a failed batch and retries on the next flush', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const svc = createSelectionTraceService({ cfg, logger: { warn } });

    svc.record({ userId: 'u1', queue: 'q', trace: makeTrace('p1') });
    await svc.flush(); // fails → row kept
    expect(warn).toHaveBeenCalled();

    await svc.flush(); // retries the same row successfully
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentRows(fetchMock, 1)).toHaveLength(1);

    await svc.flush(); // nothing left
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps the buffer under a sustained outage (drops oldest, keeps freshest)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('down'));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.fn();
    const svc = createSelectionTraceService({ cfg, maxBuffer: 3, logger: { warn } });

    // 5 rows, cap 3: recording u2 trips an out-of-band flush (fetch rejects), then
    // u3/u4 buffer. Draining the failed attempt re-buffers [u0,u1,u2] ahead of
    // [u3,u4] → 5 rows → sliced to the freshest 3 = [u2,u3,u4].
    for (let i = 0; i < 5; i++) svc.record({ userId: `u${i}`, queue: 'q', trace: makeTrace('p1') });
    await svc.flush(); // awaits the failing in-flight attempt; batch re-buffered + capped
    expect(warn).toHaveBeenCalled(); // overflow dropped the oldest with a warn

    // Recover: a fresh flush drains exactly the retained (capped) rows.
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    await svc.flush();

    const rows = sentRows(fetchMock, 1); // call 0 = the rejected attempt; call 1 = the recovery
    const users = rows.map((r) => r.user_id);
    expect(users).toHaveLength(3); // never more than maxBuffer
    expect(users).toEqual(['u2', 'u3', 'u4']); // freshest survive, u0/u1 dropped
  });

  it('start() then stop() flushes what is left', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg, flushIntervalMs: TRACE_FLUSH_INTERVAL_MS });
    svc.start();
    svc.record({ userId: 'u1', queue: 'q', trace: makeTrace('p1') });
    await svc.stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentRows(fetchMock)).toHaveLength(1);
  });

  it('periodic timer flushes buffered rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = createSelectionTraceService({ cfg, flushIntervalMs: 1000 });
    svc.start();
    svc.record({ userId: 'u1', queue: 'q', trace: makeTrace('p1') });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await svc.stop();
  });
});
