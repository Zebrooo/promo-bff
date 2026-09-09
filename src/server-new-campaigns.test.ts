import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register as promRegister } from 'prom-client';
import { buildServer } from './server';
import { createInMemorySeenCampaignsStore, createNewCampaignWatcher } from './services/new-campaign-watcher';
import type { CampaignReviewRow } from './services/campaign-review-service';

beforeEach(() => { promRegister.clear(); });
afterEach(() => { promRegister.clear(); });

const AUTH = { authorization: 'Bearer test-token' };

function reviewRow(id: number): CampaignReviewRow {
  return {
    id, advertiserId: `adv-${id}`, status: 'active', createdAt: '2026-09-01T00:00:00Z', updatedAt: null,
    name: `Кампания ${id}`, format: 'banner', slot: null, bannerFormat: null,
    cpmKopecks: 9000, totalBudgetKopecks: null, dailyBudgetKopecks: null, spentKopecks: 0,
    targetPages: null, startsAt: null, endsAt: null, creative: { format: 'banner', title: 'B' },
  };
}

function harness(rows: CampaignReviewRow[]) {
  const watcher = createNewCampaignWatcher({
    review: {
      configured: true,
      listCampaignIds: async () => rows.map((r) => ({ id: r.id, status: r.status })),
      listCampaigns: async (q) => rows.filter((r) => !q.ids || q.ids.includes(r.id)),
    },
    store: createInMemorySeenCampaignsStore(),
    notifier: { channels: ['webPush'], notify: async () => ({ attempted: 1, delivered: 1, failed: 0 }) },
  });
  const app = buildServer({ logger: false, deps: { newCampaignWatcher: watcher } });
  return { app, watcher, rows };
}

describe('POST /new-campaigns/recent', () => {
  it('401 without credentials, 503 when unconfigured', async () => {
    const { app } = harness([]);
    expect((await app.inject({ method: 'POST', url: '/new-campaigns/recent', payload: {} })).statusCode).toBe(401);
    await app.close();

    const unconfigured = buildServer({ logger: false, deps: { newCampaignWatcher: {
      configured: false, poll: async () => ({ notified: [] }), recent: async () => ({ campaigns: [], channels: [] }), start() {}, stop() {},
    } } });
    const res = await unconfigured.inject({ method: 'POST', url: '/new-campaigns/recent', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'campaigns_not_configured' });
    await unconfigured.close();
  });

  it('returns the campaigns notified after bootstrap and the configured channels', async () => {
    const { app, watcher, rows } = harness([reviewRow(1)]);
    await watcher.poll();
    rows.push(reviewRow(2));
    await watcher.poll();
    const res = await app.inject({ method: 'POST', url: '/new-campaigns/recent', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ channels: ['webPush'], campaigns: [{ id: 2, notifiedAt: expect.any(String) }] });
    await app.close();
  });
});
