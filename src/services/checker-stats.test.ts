import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckerStatsService, FLUSH_INTERVAL_MS, RESULT_CHECKER } from './checker-stats';
import type { SelectionTrace } from '../promo-selector';

const cfg = { url: 'https://sb-aa.example.com', serviceRoleKey: 'aa-srk', timeoutMs: 1000 };

interface SentRow {
  bucket_start: string;
  queue: string;
  promo_id: string;
  checker: string;
  outcome: string;
  reason: string;
  count: number;
}

function makeTrace(selected: string | null = 'p1'): SelectionTrace {
  return {
    candidates: [
      {
        promoId: 'p1',
        checks: [
          { checker: 'date', outcome: 'pass', reason: '' },
          { checker: 'limit', outcome: 'skip', reason: 'no cap configured' },
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
  vi.setSystemTime(new Date('2026-07-02T10:30:45.123Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createCheckerStatsService (no-op fallback)', () => {
  it('records and flushes nothing when unconfigured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const svc = createCheckerStatsService({ cfg: { url: '', serviceRoleKey: '', timeoutMs: 1000 } });
    svc.recordSelection('main', makeTrace());
    await svc.flush();
    svc.start();
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 2);
    await svc.stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createCheckerStatsService (aggregation)', () => {
  it('merges identical keys into one row with a summed count, minute-floored bucket', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const svc = createCheckerStatsService({ cfg });
    svc.recordSelection('main', makeTrace());
    svc.recordSelection('main', makeTrace());
    await svc.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    expect(String(url)).toBe('https://sb-aa.example.com/rest/v1/promo_checker_stats');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=minimal');

    const rows = sentRows(fetchMock);
    expect(rows).toHaveLength(3); // pass + skip + $result, each merged across the 2 traces
    for (const row of rows) expect(row.bucket_start).toBe('2026-07-02T10:30:00.000Z');
    expect(rows).toContainEqual({
      bucket_start: '2026-07-02T10:30:00.000Z', queue: 'main', promo_id: 'p1',
      checker: 'date', outcome: 'pass', reason: '', count: 2,
    });
    expect(rows).toContainEqual({
      bucket_start: '2026-07-02T10:30:00.000Z', queue: 'main', promo_id: 'p1',
      checker: 'limit', outcome: 'skip', reason: 'no cap configured', count: 2,
    });
    expect(rows).toContainEqual({
      bucket_start: '2026-07-02T10:30:00.000Z', queue: 'main', promo_id: 'p1',
      checker: RESULT_CHECKER, outcome: 'selected', reason: '', count: 2,
    });
  });

  it('records a no_promo result row with promo_id "-"', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const svc = createCheckerStatsService({ cfg });
    svc.recordSelection('home', { candidates: [], selectedPromoId: null });
    await svc.flush();

    expect(sentRows(fetchMock)).toEqual([
      {
        bucket_start: '2026-07-02T10:30:00.000Z', queue: 'home', promo_id: '-',
        checker: RESULT_CHECKER, outcome: 'no_promo', reason: '', count: 1,
      },
    ]);
  });

  it('keeps separate keys for different queues/outcomes/reasons apart', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const svc = createCheckerStatsService({ cfg });
    svc.recordSelection('main', makeTrace());
    svc.recordSelection('home', makeTrace(null));
    await svc.flush();

    const rows = sentRows(fetchMock);
    expect(rows.filter((r) => r.queue === 'main')).toHaveLength(3);
    expect(rows.filter((r) => r.queue === 'home')).toHaveLength(3);
    expect(rows.find((r) => r.queue === 'home' && r.checker === RESULT_CHECKER)).toMatchObject({
      promo_id: '-', outcome: 'no_promo',
    });
  });

  it('does not POST when there is nothing to flush', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const svc = createCheckerStatsService({ cfg });
    await svc.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createCheckerStatsService (interval flush)', () => {
  it('start() flushes every FLUSH_INTERVAL_MS; stop() clears the timer and drains', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const svc = createCheckerStatsService({ cfg });
    svc.start();

    svc.recordSelection('main', makeTrace());
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nothing new recorded → the next tick is a no-op POST-wise.
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // stop() drains pending counters without waiting for the interval…
    svc.recordSelection('main', makeTrace());
    await svc.stop();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // …and the timer is really gone afterwards.
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('createCheckerStatsService (retry on failure)', () => {
  it('keeps the counters after a failed insert and retries them on the next flush', async () => {
    const warns: { obj: unknown; msg?: string }[] = [];
    const logger = { warn: (obj: unknown, msg?: string) => warns.push({ obj, msg }) };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 201 }));

    const svc = createCheckerStatsService({ cfg, logger });
    svc.recordSelection('main', makeTrace());
    await svc.flush(); // fails → warn + merge back
    expect(warns).toHaveLength(1);
    expect(warns[0]?.msg).toMatch(/flush failed/);

    // New increments recorded between the failed and the successful flush merge in.
    svc.recordSelection('main', makeTrace());
    await svc.flush(); // succeeds

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const rows = sentRows(fetchMock, 1);
    expect(rows.find((r) => r.checker === 'date')).toMatchObject({ outcome: 'pass', count: 2 });
    expect(rows.find((r) => r.checker === RESULT_CHECKER)).toMatchObject({ outcome: 'selected', count: 2 });
  });

  it('keeps the counters when fetch rejects (network error)', async () => {
    const warns: unknown[] = [];
    const logger = { warn: (obj: unknown) => warns.push(obj) };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(new Response(null, { status: 201 }));

    const svc = createCheckerStatsService({ cfg, logger });
    svc.recordSelection('main', makeTrace());
    await expect(svc.flush()).resolves.toBeUndefined(); // never throws into the caller
    expect(warns).toHaveLength(1);

    await svc.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentRows(fetchMock, 1).find((r) => r.checker === 'date')).toMatchObject({ count: 1 });
  });
});
