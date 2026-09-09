import { describe, expect, it, vi } from 'vitest';
import { buildNewCampaignNotification, createInMemorySeenCampaignsStore, createNewCampaignWatcher, formatRub } from './new-campaign-watcher';
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

function fakeReview(rows: CampaignReviewRow[]): CampaignReviewService {
  return {
    configured: true,
    listCampaigns: vi.fn(async (q: { ids?: number[]; statuses?: string[] }) =>
      rows.filter((r) => (!q.ids || q.ids.includes(r.id)) && (!q.statuses || q.statuses.includes(r.status)))),
  };
}

function fakeNotifier(delivered = 1): AdminNotifier & { notify: ReturnType<typeof vi.fn> } {
  return { channels: ['telegram'], notify: vi.fn(async () => ({ attempted: 1, delivered, failed: 1 - delivered })) };
}

let clock = 0;
const now = () => new Date(1_760_000_000_000 + clock++ * 1000);

describe('createNewCampaignWatcher.poll', () => {
  it('bootstraps: the first poll marks every existing campaign seen and notifies nobody', async () => {
    const store = createInMemorySeenCampaignsStore();
    const notifier = fakeNotifier();
    const w = createNewCampaignWatcher({ review: fakeReview([row({ id: 1 }), row({ id: 2 })]), store, notifier, now });
    expect(await w.poll()).toEqual({ notified: [] });
    expect(store.state?.bootstrappedAt).not.toBeNull();
    expect(store.state!.campaigns).toEqual({ '1': { seenAt: expect.any(String), bootstrap: true }, '2': { seenAt: expect.any(String), bootstrap: true } });
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('after bootstrap a new campaign triggers exactly one notification', async () => {
    const rows = [row({ id: 1 })];
    const store = createInMemorySeenCampaignsStore();
    const notifier = fakeNotifier();
    const w = createNewCampaignWatcher({ review: fakeReview(rows), store, notifier, now, cabinetUrl: 'https://cab.example' });
    await w.poll();
    rows.push(row({ id: 2, name: 'Новая' }), row({ id: 3, status: 'draft' }));
    expect(await w.poll()).toEqual({ notified: [2] });
    expect(store.state?.campaigns['2']).toMatchObject({ seenAt: expect.any(String), notifiedAt: expect.any(String) });
    expect(store.state?.campaigns['3']).toBeUndefined(); // черновики не в счёт
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const n = notifier.notify.mock.calls[0]![0];
    expect(n.title).toBe('Новая рекламная кампания №2');
    expect(n.body).toBe(`«Новая» · CPM ${formatRub(1400)} · бюджет ${formatRub(100000)}`);
    expect(n.url).toBe('https://cab.example/cabinet/campaigns');
    expect(n.tag).toBe('campaign-2');
    expect(await w.poll()).toEqual({ notified: [] });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('a failed delivery is not retried every poll (campaign stays seen, notifiedAt empty)', async () => {
    const rows = [row({ id: 1 })];
    const store = createInMemorySeenCampaignsStore();
    const notifier = fakeNotifier(0);
    const w = createNewCampaignWatcher({ review: fakeReview(rows), store, notifier, now });
    await w.poll();
    rows.push(row({ id: 2 }));
    expect(await w.poll()).toEqual({ notified: [] });
    expect(store.state?.campaigns['2']).toEqual({ seenAt: expect.any(String) });
    await w.poll();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the review service is unconfigured', async () => {
    const store = createInMemorySeenCampaignsStore();
    const w = createNewCampaignWatcher({ review: { configured: false, listCampaigns: async () => [] }, store, notifier: fakeNotifier(), now });
    expect(w.configured).toBe(false);
    expect(await w.poll()).toEqual({ notified: [] });
    expect(store.state).toBeNull();
  });

  it('serialises concurrent polls so one campaign is never notified twice', async () => {
    const rows = [row({ id: 1 })];
    const store = createInMemorySeenCampaignsStore();
    const notifier = fakeNotifier();
    const w = createNewCampaignWatcher({ review: fakeReview(rows), store, notifier, now });
    await w.poll();
    rows.push(row({ id: 2 }));
    await Promise.all([w.poll(), w.poll(), w.poll()]);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });
});

describe('createNewCampaignWatcher.recent', () => {
  it('lists campaigns seen after bootstrap, newest first, with delivery timestamps', async () => {
    const rows = [row({ id: 1 })];
    const store = createInMemorySeenCampaignsStore();
    const w = createNewCampaignWatcher({ review: fakeReview(rows), store, notifier: fakeNotifier(), now });
    await w.poll();
    rows.push(row({ id: 2 }), row({ id: 3 }));
    await w.poll();
    const listing = await w.recent();
    expect(listing.channels).toEqual(['telegram']);
    expect(listing.campaigns.map((c) => c.id)).toEqual([3, 2]);
    expect(listing.campaigns[0]!.notifiedAt).toEqual(expect.any(String));
  });
});

describe('helpers', () => {
  it('formats roubles and builds a notification without a cabinet link', () => {
    expect(formatRub(1400)).toBe('14 ₽');
    const n = buildNewCampaignNotification(row({ totalBudgetKopecks: null, dailyBudgetKopecks: 50000, name: null }), undefined);
    expect(n.body).toBe('Без названия · CPM 14 ₽ · 500 ₽/день');
    expect(n.url).toBeUndefined();
  });
});
