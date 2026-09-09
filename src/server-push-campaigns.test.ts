import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { register as promRegister } from 'prom-client';
import { buildServer } from './server';
import { createPushCampaignService } from './services/push-campaign-service';
import { createInMemoryPushCampaignStore } from './services/push-campaign-store';
import type { PushBroadcastClient } from './services/push-broadcast-client';

beforeEach(() => { promRegister.clear(); });
afterEach(() => { promRegister.clear(); });

const AUTH = { authorization: 'Bearer test-token' };
const draft = { title: 'Заголовок', body: 'Текст пуша', url: '/sale', targeting: { minAge: 18 }, sections: ['auto'] };

function harness(broadcast?: Partial<PushBroadcastClient>) {
  const calls: unknown[] = [];
  const service = createPushCampaignService({
    store: createInMemoryPushCampaignStore(),
    broadcast: {
      configured: true,
      async broadcast(req) { calls.push(req); return { users: 2, attempted: 2, delivered: 2, failed: 0 }; },
      ...broadcast,
    },
    newId: () => 'push-abc',
  });
  const app = buildServer({ logger: false, deps: { pushCampaignService: service } });
  return { app, calls };
}

describe('/push-campaigns', () => {
  it('401 without credentials on every route', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'GET', url: '/push-campaigns' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/push-campaigns', payload: draft })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/push-campaigns/push-abc' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/push-campaigns/push-abc' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/push-campaigns/push-abc/send' })).statusCode).toBe(401);
    await app.close();
  });

  it('create → list → get → update → send → delete round trip', async () => {
    const { app, calls } = harness();

    const created = await app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: draft });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ campaign: { id: 'push-abc', status: 'draft', title: 'Заголовок', targeting: { minAge: 18 }, sections: ['auto'] } });

    const list = await app.inject({ method: 'GET', url: '/push-campaigns', headers: AUTH });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ broadcastConfigured: true, campaigns: [{ id: 'push-abc' }] });

    const one = await app.inject({ method: 'GET', url: '/push-campaigns/push-abc', headers: AUTH });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ campaign: { id: 'push-abc' } });

    const updated = await app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: { ...draft, id: 'push-abc', title: 'Новый' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ campaign: { id: 'push-abc', title: 'Новый' } });

    const sent = await app.inject({ method: 'POST', url: '/push-campaigns/push-abc/send', headers: AUTH });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ campaign: { status: 'sent', sendResult: { users: 2 } } });
    expect(calls).toEqual([{ title: 'Новый', body: 'Текст пуша', data: { url: '/sale', campaignId: 'push-abc' } }]);

    const again = await app.inject({ method: 'POST', url: '/push-campaigns/push-abc/send', headers: AUTH });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'already_sent' });

    const editSent = await app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: { ...draft, id: 'push-abc' } });
    expect(editSent.statusCode).toBe(409);

    const removed = await app.inject({ method: 'DELETE', url: '/push-campaigns/push-abc', headers: AUTH });
    expect(removed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/push-campaigns/push-abc', headers: AUTH })).statusCode).toBe(404);
    await app.close();
  });

  it('400 invalid_push_campaign with field issues; 400 on a malformed id; 404 on unknown ids', async () => {
    const { app } = harness();
    const bad = await app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: { title: '', body: 'x', url: 'javascript:alert(1)', targeting: {} } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_push_campaign', issues: expect.arrayContaining([expect.objectContaining({ path: 'title' }), expect.objectContaining({ path: 'url' })]) });

    expect((await app.inject({ method: 'GET', url: '/push-campaigns/bad%2Fid', headers: AUTH })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/push-campaigns/nope', headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/push-campaigns/nope', headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/push-campaigns/nope/send', headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: { ...draft, id: 'nope' } })).statusCode).toBe(404);
    await app.close();
  });

  it('503 push_not_configured when the storefront is not configured; 502 when it fails', async () => {
    const off = harness({ configured: false });
    await off.app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: draft });
    const res = await off.app.inject({ method: 'POST', url: '/push-campaigns/push-abc/send', headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'push_not_configured' });
    expect((await off.app.inject({ method: 'GET', url: '/push-campaigns', headers: AUTH })).json()).toMatchObject({ broadcastConfigured: false });
    await off.app.close();

    const failing = harness({ async broadcast() { throw new Error('boom'); } });
    await failing.app.inject({ method: 'POST', url: '/push-campaigns', headers: AUTH, payload: draft });
    const res2 = await failing.app.inject({ method: 'POST', url: '/push-campaigns/push-abc/send', headers: AUTH });
    expect(res2.statusCode).toBe(502);
    expect(res2.json()).toEqual({ error: 'push_broadcast_failed', reason: 'boom' });
    expect((await failing.app.inject({ method: 'GET', url: '/push-campaigns/push-abc', headers: AUTH })).json()).toMatchObject({ campaign: { status: 'draft', lastSendError: 'boom' } });
    await failing.app.close();
  });
});
