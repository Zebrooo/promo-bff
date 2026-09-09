import { describe, expect, it, vi } from 'vitest';
import { buildNewCampaignNotification, createCampaignModeration, formatRub } from './campaign-moderation';
import { createInMemoryModerationStore } from './campaign-moderation-store';
import type { CampaignReviewRow, CampaignReviewService } from './campaign-review-service';
import type { AdminNotifier } from './admin-notifier';

function row(over: Partial<CampaignReviewRow> = {}): CampaignReviewRow {
  return {
    id: 1, advertiserId: 'adv-1', status: 'active', createdAt: '2026-09-01T10:00:00Z', updatedAt: null,
    name: 'Шины', format: 'banner', slot: null, bannerFormat: 'horizontal',
    cpmKopecks: 1400, totalBudgetKopecks: 100000, dailyBudgetKopecks: null, spentKopecks: 0,
    targetPages: ['home'], startsAt: null, endsAt: null, creative: { format: 'banner', title: 'Шины' },
    ...over,
  };
}

function fakeReview(rows: CampaignReviewRow[]): CampaignReviewService & { setStatus: ReturnType<typeof vi.fn> } {
  return {
    configured: true,
    listCampaigns: vi.fn(async (q: { ids?: number[]; statuses?: string[] }) =>
      rows.filter((r) => (!q.ids || q.ids.includes(r.id)) && (!q.statuses || q.statuses.includes(r.status)))),
    setStatus: vi.fn(async () => ({ ok: true as const })),
  };
}

function fakeNotifier(): AdminNotifier & { notify: ReturnType<typeof vi.fn> } {
  return { channels: ['telegram'], notify: vi.fn(async () => ({ attempted: 1, delivered: 1, failed: 0 })) };
}

const balances = (map: Record<string, number> = {}) => ({
  getBalances: async (ids: string[]) => new Map(ids.filter((id) => id in map).map((id) => [id, map[id]!])),
});

let clock = 0;
const now = () => new Date(1_760_000_000_000 + clock++ * 1000);

describe('createCampaignModeration.poll', () => {
  it('bootstraps: the first poll approves every existing campaign and notifies nobody', async () => {
    const store = createInMemoryModerationStore();
    const notifier = fakeNotifier();
    const m = createCampaignModeration({ review: fakeReview([row({ id: 1 }), row({ id: 2 })]), store, balances: balances(), notifier, now });
    expect(await m.poll()).toEqual({ newPending: [] });
    expect(store.state?.bootstrappedAt).not.toBeNull();
    expect(store.state?.campaigns['1']?.decision).toBe('approved');
    expect(store.state?.campaigns['2']?.decidedBy).toBe('bootstrap');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('after bootstrap a new campaign becomes pending and admins are notified once', async () => {
    const rows = [row({ id: 1 })];
    const store = createInMemoryModerationStore();
    const notifier = fakeNotifier();
    const review = fakeReview(rows);
    const m = createCampaignModeration({ review, store, balances: balances({ 'adv-2': 0 }), notifier, now, cabinetUrl: 'https://cab.example' });
    await m.poll();
    rows.push(row({ id: 2, advertiserId: 'adv-2', name: 'Новая' }));
    expect(await m.poll()).toEqual({ newPending: [2] });
    expect(store.state?.campaigns['2']).toMatchObject({ decision: 'pending', notifiedAt: expect.any(String) });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const n = notifier.notify.mock.calls[0]![0];
    expect(n.title).toBe('Новая рекламная кампания №2');
    expect(n.body).toContain('«Новая»');
    expect(n.body).toContain('Баланс рекламодателя 0 ₽');
    expect(n.url).toBe('https://cab.example/cabinet/campaigns');
    // Повторный опрос ничего не дублирует.
    expect(await m.poll()).toEqual({ newPending: [] });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('does not touch anything when the review service is unconfigured', async () => {
    const store = createInMemoryModerationStore();
    const m = createCampaignModeration({
      review: { configured: false, listCampaigns: async () => [], setStatus: async () => ({ ok: false, error: 'x' }) },
      store, balances: balances(), notifier: fakeNotifier(), now,
    });
    expect(m.configured).toBe(false);
    expect(await m.poll()).toEqual({ newPending: [] });
    expect(store.state).toBeNull();
    expect(await m.filterApproved([{ id: 1 }])).toEqual([{ id: 1 }]);
  });
});

describe('createCampaignModeration.filterApproved', () => {
  it('serves only approved campaigns once bootstrapped; unknown (fresh) ids are held back', async () => {
    const store = createInMemoryModerationStore({
      version: 1, bootstrappedAt: '2026-09-01T00:00:00Z',
      campaigns: { '1': { decision: 'approved', seenAt: 'x' }, '2': { decision: 'pending', seenAt: 'x' }, '3': { decision: 'rejected', seenAt: 'x' } },
    });
    const m = createCampaignModeration({ review: fakeReview([]), store, balances: balances(), notifier: fakeNotifier(), now });
    expect(await m.filterApproved([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])).toEqual([{ id: 1 }]);
  });

  it('fails open before bootstrap and when the store is unreadable with no cache', async () => {
    const m1 = createCampaignModeration({ review: fakeReview([]), store: createInMemoryModerationStore(), balances: balances(), notifier: fakeNotifier(), now });
    expect(await m1.filterApproved([{ id: 9 }])).toEqual([{ id: 9 }]);

    const broken = { read: async () => { throw new Error('s3 down'); }, write: async () => {} };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const m2 = createCampaignModeration({ review: fakeReview([]), store: broken, balances: balances(), notifier: fakeNotifier(), now, logger });
    expect(await m2.filterApproved([{ id: 9 }])).toEqual([{ id: 9 }]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('after a failed read, does not hammer the store again within the TTL and dedupes concurrent reads', async () => {
    let reads = 0;
    const store = { read: async () => { reads += 1; throw new Error('down'); }, write: async () => {} };
    const m = createCampaignModeration({ review: fakeReview([]), store, balances: balances(), notifier: fakeNotifier(), now });
    await Promise.all([m.filterApproved([{ id: 1 }]), m.filterApproved([{ id: 2 }]), m.filterApproved([{ id: 3 }])]);
    expect(reads).toBe(1);
    expect(await m.filterApproved([{ id: 4 }])).toEqual([{ id: 4 }]);
    expect(reads).toBe(1);
  });

  it('uses the last known state when a later read fails', async () => {
    let fail = false;
    const inner = createInMemoryModerationStore({ version: 1, bootstrappedAt: 'x', campaigns: { '1': { decision: 'approved', seenAt: 'x' } } });
    const store = { read: async () => { if (fail) throw new Error('down'); return inner.read(); }, write: inner.write };
    const m = createCampaignModeration({ review: fakeReview([]), store, balances: balances(), notifier: fakeNotifier(), now });
    expect(await m.filterApproved([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }]);
    fail = true;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000); // кэш протух
    expect(await m.filterApproved([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }]);
    vi.useRealTimers();
  });
});

describe('createCampaignModeration.decide + list', () => {
  it('approve records the decision, promotes a pending DB status to active and shows up in recent', async () => {
    const rows = [row({ id: 1 }), row({ id: 2, status: 'pending', advertiserId: 'adv-2' })];
    const review = fakeReview(rows);
    const store = createInMemoryModerationStore();
    const m = createCampaignModeration({ review, store, balances: balances({ 'adv-1': 50000, 'adv-2': 0 }), notifier: fakeNotifier(), now });
    await m.poll();
    rows.push(row({ id: 3, advertiserId: 'adv-3' }));
    await m.poll();

    let listing = await m.list();
    expect(listing.pending.map((c) => c.id)).toEqual([3]);
    expect(listing.pending[0]!.balanceKopecks).toBeNull();
    expect(listing.recent).toEqual([]);
    expect(listing.channels).toEqual(['telegram']);

    const res = await m.decide(2, 'approved', 'admin');
    expect(res.ok).toBe(true);
    expect(review.setStatus).toHaveBeenCalledWith(2, 'active');
    if (res.ok) {
      expect(res.campaign.status).toBe('active');
      expect(res.campaign.zeroBalance).toBe(true);
      expect(res.campaign.moderation).toMatchObject({ decision: 'approved', decidedBy: 'admin' });
    }

    const rej = await m.decide(3, 'rejected', 'admin', '  креатив без цены  ');
    expect(rej.ok).toBe(true);
    expect(review.setStatus).toHaveBeenCalledWith(3, 'paused');
    expect(store.state?.campaigns['3']).toMatchObject({ decision: 'rejected', reason: 'креатив без цены' });

    listing = await m.list();
    expect(listing.pending).toEqual([]);
    expect(listing.recent.map((c) => c.id)).toEqual([3, 2]);
    expect(await m.filterApproved([{ id: 1 }, { id: 2 }, { id: 3 }])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('approve of an already-active campaign does not write the DB; a refused PATCH is tolerated', async () => {
    const review = fakeReview([row({ id: 1 })]);
    review.setStatus.mockResolvedValue({ ok: false, error: 'HTTP 400' });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const m = createCampaignModeration({ review, store: createInMemoryModerationStore(), balances: balances(), notifier: fakeNotifier(), now, logger });
    await m.poll();
    expect((await m.decide(1, 'approved', 'a')).ok).toBe(true);
    expect(review.setStatus).not.toHaveBeenCalled();
    expect((await m.decide(1, 'rejected', 'a')).ok).toBe(true);
    expect(review.setStatus).toHaveBeenCalledWith(1, 'paused');
    expect(logger.warn).toHaveBeenCalled();
    expect(await m.filterApproved([{ id: 1 }])).toEqual([]);
  });

  it('returns not_found for an unknown campaign', async () => {
    const m = createCampaignModeration({ review: fakeReview([]), store: createInMemoryModerationStore(), balances: balances(), notifier: fakeNotifier(), now });
    expect(await m.decide(42, 'approved', 'a')).toEqual({ ok: false, error: 'not_found' });
  });

  it('re-moderates a rejected campaign the advertiser switched back to active', async () => {
    const rows = [row({ id: 1 })];
    const review = fakeReview(rows);
    // Отклонение реально перевело кампанию в paused (эмулируем витрину).
    review.setStatus.mockImplementation(async (id: number, status: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.status = status;
      return { ok: true as const };
    });
    const store = createInMemoryModerationStore();
    const notifier = fakeNotifier();
    const m = createCampaignModeration({ review, store, balances: balances(), notifier, now });
    await m.poll();
    await m.decide(1, 'rejected', 'admin', 'плохой креатив');
    expect(store.state?.campaigns['1']).toMatchObject({ decision: 'rejected', dbStatusAfterDecision: 'paused' });
    expect(rows[0]!.status).toBe('paused');
    expect(await m.poll()).toEqual({ newPending: [] }); // paused — ничего не происходит

    rows[0]!.status = 'active'; // рекламодатель включил заново
    expect(await m.poll()).toEqual({ newPending: [1] });
    expect(store.state?.campaigns['1']).toMatchObject({ decision: 'pending', resubmittedAt: expect.any(String) });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify.mock.calls[0]![0].title).toBe('Кампания №1 отправлена повторно');
    expect(await m.filterApproved([{ id: 1 }])).toEqual([]);
    // Пока pending — повторно не дёргаем.
    expect(await m.poll()).toEqual({ newPending: [] });
  });

  it('does NOT re-moderate when the reject PATCH never landed (status stayed active)', async () => {
    const rows = [row({ id: 1 })];
    const review = fakeReview(rows);
    review.setStatus.mockResolvedValue({ ok: false, error: 'HTTP 400' });
    const store = createInMemoryModerationStore();
    const notifier = fakeNotifier();
    const m = createCampaignModeration({ review, store, balances: balances(), notifier, now });
    await m.poll();
    await m.decide(1, 'rejected', 'admin');
    expect(store.state?.campaigns['1']?.dbStatusAfterDecision).toBeUndefined();
    expect(await m.poll()).toEqual({ newPending: [] });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('serialises poll and decide so the poller cannot clobber a fresh decision', async () => {
    const rows = [row({ id: 1 })];
    const store = createInMemoryModerationStore();
    const m = createCampaignModeration({ review: fakeReview(rows), store, balances: balances(), notifier: fakeNotifier(), now });
    await m.poll();
    rows.push(row({ id: 2 }));
    await Promise.all([m.poll(), m.decide(2, 'approved', 'a'), m.poll()]);
    expect(store.state?.campaigns['2']?.decision).toBe('approved');
  });
});

describe('helpers', () => {
  it('formats roubles and builds a notification without a cabinet link', () => {
    expect(formatRub(1400)).toBe('14 ₽');
    const n = buildNewCampaignNotification(row({ totalBudgetKopecks: null, dailyBudgetKopecks: 50000 }), 100, undefined);
    expect(n.body).toContain('500 ₽/день');
    expect(n.body).not.toContain('Баланс');
    expect(n.url).toBeUndefined();
    expect(n.tag).toBe('campaign-1');
  });
});
