import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeAdvertiserSignal, createAdvertiserSignalService, mapCampaignRow, EMPTY_ADVERTISER_SIGNAL,
  AD_CAMPAIGN_SIGNAL_COLUMNS, type AdvertiserCampaignRow,
} from './advertiser-signal-service';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = { url: 'https://db.example', serviceRoleKey: 'secret', timeoutMs: 2000 };
// 12:00 UTC = 15:00 МСК того же дня.
const NOW = new Date('2026-09-09T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const row = (over: Partial<AdvertiserCampaignRow> = {}): AdvertiserCampaignRow => ({
  status: 'active',
  createdAt: daysAgo(10),
  updatedAt: daysAgo(5),
  spentKopecks: 0,
  totalBudgetKopecks: null,
  dailyBudgetKopecks: null,
  spentTodayKopecks: 0,
  spentTodayDate: null,
  ...over,
});

describe('mapCampaignRow', () => {
  it('maps a PostgREST row defensively (string numerics, junk dates)', () => {
    expect(mapCampaignRow({
      status: 'paused', created_at: '2026-09-01T00:00:00+00:00', updated_at: 'nope',
      spent_kopecks: '1500', total_budget_kopecks: '100000', daily_budget_kopecks: null,
      spent_today_kopecks: 'x', spent_today_date: '2026-09-09',
    })).toEqual({
      status: 'paused', createdAt: '2026-09-01T00:00:00+00:00', updatedAt: null,
      spentKopecks: 1500, totalBudgetKopecks: 100000, dailyBudgetKopecks: null,
      spentTodayKopecks: 0, spentTodayDate: '2026-09-09',
    });
    expect(mapCampaignRow({})).toMatchObject({ status: '', createdAt: null, spentKopecks: 0, totalBudgetKopecks: null });
  });

  it('reads exactly the columns of AD_CAMPAIGN_SIGNAL_COLUMNS (защита от дрейфа схемы AA: колонка вне явного select никогда не придёт из PostgREST, а несуществующая — даст 400, не тихий null)', () => {
    const source = readFileSync(fileURLToPath(new URL('./advertiser-signal-service.ts', import.meta.url)), 'utf8');
    const body = source.slice(source.indexOf('export function mapCampaignRow'), source.indexOf('function isLaunched'));
    const readColumns = [...new Set([...body.matchAll(/raw\.([a-z_]+)/g)].map((m) => m[1]))].sort();
    expect(readColumns).toEqual([...AD_CAMPAIGN_SIGNAL_COLUMNS].sort());
    // Колонки, подтверждённые аукционом (campaign-service.ts читает их в проде), плюс created_at/updated_at.
    const auctionSelect = readFileSync(fileURLToPath(new URL('./campaign-service.ts', import.meta.url)), 'utf8');
    for (const col of AD_CAMPAIGN_SIGNAL_COLUMNS) {
      if (col === 'created_at' || col === 'updated_at') continue;
      expect(auctionSelect, col).toContain(col);
    }
  });
});

describe('computeAdvertiserSignal', () => {
  it('returns the empty signal for an advertiser without campaigns', () => {
    expect(computeAdvertiserSignal([], [], 30, NOW)).toEqual({ ...EMPTY_ADVERTISER_SIGNAL, wizardWindowDays: 30 });
  });

  it('collects distinct statuses and the active flag', () => {
    const s = computeAdvertiserSignal([row({ status: 'pending' }), row({ status: 'pending' }), row({ status: 'paused' })], [], 0, NOW);
    expect(s.statuses.sort()).toEqual(['paused', 'pending']);
    expect(s.hasActive).toBe(false);
    expect(computeAdvertiserSignal([row({ status: 'active' })], [], 0, NOW).hasActive).toBe(true);
  });

  it('lastLaunchedAt: launched statuses or any spend; pending/draft/rejected without spend never launched', () => {
    expect(computeAdvertiserSignal([row({ status: 'pending' }), row({ status: 'draft' }), row({ status: 'rejected' })], [], 0, NOW).lastLaunchedAt).toBeNull();
    // updated_at приоритетнее created_at; максимум по запускавшимся, pending не в счёт.
    const s = computeAdvertiserSignal([
      row({ status: 'paused', updatedAt: daysAgo(40), createdAt: daysAgo(1) }),
      row({ status: 'finished', updatedAt: daysAgo(20) }),
      row({ status: 'pending', updatedAt: daysAgo(0) }),
    ], [], 0, NOW);
    expect(s.lastLaunchedAt).toBe(daysAgo(20));
    // pending со списаниями — крутилась; дата = updated_at, потом created_at.
    expect(computeAdvertiserSignal([row({ status: 'pending', spentKopecks: 100, updatedAt: null, createdAt: daysAgo(3) })], [], 0, NOW).lastLaunchedAt).toBe(daysAgo(3));
    // Запускалась, но дат нет — '' (everLaunched проходит, окно — нет).
    expect(computeAdvertiserSignal([row({ status: 'active', createdAt: null, updatedAt: null })], [], 0, NOW).lastLaunchedAt).toBe('');
  });

  it('spentKopecks sums every campaign', () => {
    expect(computeAdvertiserSignal([row({ spentKopecks: 100 }), row({ status: 'finished', spentKopecks: 250 })], [], 0, NOW).spentKopecks).toBe(350);
  });

  it('budgetExhausted: total budget reached, or daily budget reached today (МСК); other dates reset to 0', () => {
    expect(computeAdvertiserSignal([row({ spentKopecks: 1000, totalBudgetKopecks: 1000 })], [], 0, NOW).budgetExhausted).toBe(true);
    expect(computeAdvertiserSignal([row({ spentKopecks: 999, totalBudgetKopecks: 1000 })], [], 0, NOW).budgetExhausted).toBe(false);
    expect(computeAdvertiserSignal([row({ dailyBudgetKopecks: 500, spentTodayKopecks: 500, spentTodayDate: '2026-09-09' })], [], 0, NOW).budgetExhausted).toBe(true);
    expect(computeAdvertiserSignal([row({ dailyBudgetKopecks: 500, spentTodayKopecks: 500, spentTodayDate: '2026-09-08' })], [], 0, NOW).budgetExhausted).toBe(false);
    // Незапускавшаяся (pending без списаний) с нулевым бюджетом — не «исчерпан».
    expect(computeAdvertiserSignal([row({ status: 'pending', totalBudgetKopecks: 0 })], [], 0, NOW).budgetExhausted).toBe(false);
  });

  it('wizardEvents: maps form_start/form_submit_success, drops junk, newest first', () => {
    const s = computeAdvertiserSignal([], [
      { eventName: 'form_start', createdAt: daysAgo(5) },
      { eventName: 'form_submit_success', createdAt: daysAgo(2) },
      { eventName: 'form_abandon', createdAt: daysAgo(1) },
      { eventName: 'form_start', createdAt: 'garbage' },
    ], 14, NOW);
    expect(s.wizardEvents).toEqual([{ kind: 'submit', at: daysAgo(2) }, { kind: 'start', at: daysAgo(5) }]);
    expect(s.wizardWindowDays).toBe(14);
  });
});

describe('createAdvertiserSignalService', () => {
  function mockFetch(responder: (url: string) => { status: number; body: unknown }) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const { status, body } = responder(url);
      return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns an empty signal without touching fetch when Supabase is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = createAdvertiserSignalService({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(svc.getSignal('u1', { wizardLookbackDays: 30, now: NOW })).resolves.toEqual({ ...EMPTY_ADVERTISER_SIGNAL, wizardWindowDays: 30 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads ad_campaigns by advertiser_id and wizard events by form_id within the window, with service-role auth', async () => {
    const fetchMock = mockFetch((url) => url.includes('/ad_campaigns')
      ? { status: 200, body: [{ status: 'active', spent_kopecks: '300', created_at: daysAgo(2) }] }
      : { status: 200, body: [{ event_name: 'form_start', created_at: daysAgo(1) }] });
    const s = await createAdvertiserSignalService(cfg).getSignal('u1', { wizardLookbackDays: 14, now: NOW });
    expect(s).toMatchObject({ statuses: ['active'], hasActive: true, spentKopecks: 300, lastLaunchedAt: daysAgo(2), wizardWindowDays: 14 });
    expect(s.wizardEvents).toEqual([{ kind: 'start', at: daysAgo(1) }]);

    const calls = fetchMock.mock.calls.map((c) => [String(c[0]), c[1] as RequestInit] as const);
    const campaigns = calls.find(([u]) => u.includes('/rest/v1/ad_campaigns'))!;
    const events = calls.find(([u]) => u.includes('/rest/v1/user_action_events'))!;
    const cq = new URL(campaigns[0]).searchParams;
    expect(cq.get('advertiser_id')).toBe('eq.u1');
    expect(cq.get('select')).toBe(AD_CAMPAIGN_SIGNAL_COLUMNS.join(','));
    expect(cq.get('select')).not.toContain('*');
    expect(campaigns[1].headers).toEqual({ apikey: 'secret', Authorization: 'Bearer secret' });
    expect(campaigns[1].signal).toBeInstanceOf(AbortSignal);
    const eq = new URL(events[0]).searchParams;
    expect(eq.get('user_id')).toBe('eq.u1');
    expect(eq.get('event_name')).toBe('in.(form_start,form_submit_success)');
    expect(eq.get('props->>form_id')).toBe('eq.ad_campaign');
    expect(eq.get('created_at')).toBe(`gte.${daysAgo(14)}`);
    expect(eq.get('select')).toBe('event_name,created_at');
  });

  it('skips the events read entirely when no promo asks about the wizard (window 0)', async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: [] }));
    const s = await createAdvertiserSignalService(cfg).getSignal('u1', { wizardLookbackDays: 0, now: NOW });
    expect(s.wizardEvents).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/ad_campaigns');
  });

  it('throws on a non-2xx response from either read (loader turns it into fail closed)', async () => {
    mockFetch((url) => (url.includes('/ad_campaigns') ? { status: 200, body: [] } : { status: 500, body: null }));
    await expect(createAdvertiserSignalService(cfg).getSignal('u1', { wizardLookbackDays: 7, now: NOW })).rejects.toThrow(/HTTP 500/);
    mockFetch(() => ({ status: 404, body: null }));
    await expect(createAdvertiserSignalService(cfg).getSignal('u1', { wizardLookbackDays: 0, now: NOW })).rejects.toThrow(/HTTP 404/);
  });

  it('caches per (userId, window) for 60s and evicts on expiry', async () => {
    const fetchMock = mockFetch(() => ({ status: 200, body: [] }));
    let t = 1_000_000;
    const svc = createAdvertiserSignalService(cfg, () => t);
    await svc.getSignal('u1', { wizardLookbackDays: 0, now: NOW });
    await svc.getSignal('u1', { wizardLookbackDays: 0, now: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await svc.getSignal('u1', { wizardLookbackDays: 30, now: NOW }); // другое окно — другой ключ
    expect(fetchMock).toHaveBeenCalledTimes(3);
    t += 60_001;
    await svc.getSignal('u1', { wizardLookbackDays: 0, now: NOW });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
