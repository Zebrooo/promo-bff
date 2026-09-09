import { describe, expect, it, vi } from 'vitest';
import { createPushCampaignService, toBroadcastRequest } from './push-campaign-service';
import { createInMemoryPushCampaignStore, parsePushCampaignsFile } from './push-campaign-store';
import { PushBroadcastError, type PushBroadcastClient } from './push-broadcast-client';
import type { PushCampaign, PushCampaignInput } from './push-campaign-schema';

const input = (over: Partial<PushCampaignInput> = {}): PushCampaignInput => ({
  title: 'Скидки на шины',
  body: 'До конца недели −20% на всё',
  url: '/sale/tyres',
  targeting: {},
  ...over,
});

function broadcastStub(over: Partial<PushBroadcastClient> = {}): PushBroadcastClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    configured: true,
    calls,
    async broadcast(req) {
      calls.push(req);
      return { users: 10, attempted: 12, delivered: 11, failed: 1 };
    },
    ...over,
  };
}

type BroadcastStub = ReturnType<typeof broadcastStub>;

function harness(opts: { broadcast?: BroadcastStub; initial?: PushCampaign[] } = {}) {
  const store = createInMemoryPushCampaignStore(opts.initial ?? []);
  const broadcast: BroadcastStub = opts.broadcast ?? broadcastStub();
  let tick = 0;
  const service = createPushCampaignService({
    store,
    broadcast,
    now: () => new Date(Date.UTC(2026, 8, 9, 12, 0, tick++)),
    newId: () => `push-${String(store.campaigns.length + 1).padStart(3, '0')}`,
  });
  return { store, broadcast, service };
}

describe('push-campaign-service: drafts', () => {
  it('creates a draft with a generated id and lists newest first', async () => {
    const { service } = harness();
    const a = await service.save(input({ title: 'A' }));
    const b = await service.save(input({ title: 'B' }));
    expect(a).toMatchObject({ ok: true, created: true, campaign: { id: 'push-001', status: 'draft', title: 'A' } });
    expect(b).toMatchObject({ ok: true, created: true, campaign: { id: 'push-002' } });
    expect((await service.list()).map((c) => c.title)).toEqual(['B', 'A']);
  });

  it('updates an existing draft in place, replacing targeting axes that were removed', async () => {
    const { service } = harness();
    const created = await service.save(input({ sections: ['auto'], targeting: { minAge: 18 } }));
    if (!created.ok) throw new Error('unexpected');
    const updated = await service.save(input({ id: created.campaign.id, title: 'Новый заголовок', targeting: {} }));
    expect(updated).toMatchObject({ ok: true, created: false, campaign: { id: created.campaign.id, title: 'Новый заголовок', createdAt: created.campaign.createdAt } });
    const stored = await service.get(created.campaign.id);
    expect(stored?.sections).toBeUndefined();
    expect(stored?.targeting).toEqual({});
    expect((stored?.updatedAt ?? '') > created.campaign.updatedAt).toBe(true);
    expect(await service.list()).toHaveLength(1);
  });

  it('404 on unknown id, delete is idempotent-ish (not_found the second time)', async () => {
    const { service } = harness();
    expect(await service.save(input({ id: 'push-missing' }))).toEqual({ ok: false, error: 'not_found' });
    const created = await service.save(input());
    if (!created.ok) throw new Error('unexpected');
    expect(await service.remove(created.campaign.id)).toEqual({ ok: true });
    expect(await service.remove(created.campaign.id)).toEqual({ ok: false, error: 'not_found' });
    expect(await service.get(created.campaign.id)).toBeNull();
  });
});

describe('push-campaign-service: send', () => {
  it('broadcasts title/body/url/icon to the storefront and marks the campaign sent', async () => {
    const { service, broadcast, store } = harness();
    const created = await service.save(input({ icon: 'https://cdn.example.com/i.png' }));
    if (!created.ok) throw new Error('unexpected');
    const sent = await service.send(created.campaign.id);
    expect(sent).toMatchObject({
      ok: true,
      campaign: { status: 'sent', sentAt: expect.any(String), sendResult: { users: 10, attempted: 12, delivered: 11, failed: 1 } },
    });
    expect(broadcast.calls).toEqual([{
      title: 'Скидки на шины', body: 'До конца недели −20% на всё',
      data: { url: '/sale/tyres', campaignId: created.campaign.id },
      icon: 'https://cdn.example.com/i.png',
    }]);
    // userIds не передаём: первый этап = все пользователи с токенами.
    expect((broadcast.calls[0] as { userIds?: unknown }).userIds).toBeUndefined();
    expect(store.campaigns[0]).toMatchObject({ status: 'sent' });
  });

  it('refuses to send or edit a sent campaign (already_sent)', async () => {
    const { service } = harness();
    const created = await service.save(input());
    if (!created.ok) throw new Error('unexpected');
    await service.send(created.campaign.id);
    expect(await service.send(created.campaign.id)).toEqual({ ok: false, error: 'already_sent' });
    expect(await service.save(input({ id: created.campaign.id, title: 'x' }))).toEqual({ ok: false, error: 'already_sent' });
  });

  it('a concurrent double-send results in exactly one broadcast', async () => {
    const { service, broadcast } = harness();
    const created = await service.save(input());
    if (!created.ok) throw new Error('unexpected');
    const [a, b] = await Promise.all([service.send(created.campaign.id), service.send(created.campaign.id)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(broadcast.calls).toHaveLength(1);
  });

  it('reverts to draft with lastSendError when the storefront rejects the broadcast', async () => {
    const failing = broadcastStub({
      async broadcast() { throw new PushBroadcastError('abkhaz-auto broadcast returned 500: fcm_down', 500); },
    });
    const { service } = harness({ broadcast: failing });
    const created = await service.save(input());
    if (!created.ok) throw new Error('unexpected');
    const res = await service.send(created.campaign.id);
    expect(res).toMatchObject({ ok: false, error: 'push_broadcast_failed', reason: expect.stringContaining('fcm_down') });
    const stored = await service.get(created.campaign.id);
    expect(stored).toMatchObject({ status: 'draft', lastSendError: expect.stringContaining('fcm_down') });
    expect(stored?.sentAt).toBeUndefined();
    // Повторная попытка после починки проходит и чистит lastSendError.
    failing.broadcast = async () => ({ users: 1, attempted: 1, delivered: 1, failed: 0 });
    const retry = await service.send(created.campaign.id);
    expect(retry.ok).toBe(true);
    expect((await service.get(created.campaign.id))?.lastSendError).toBeUndefined();
  });

  it('push_not_configured when the storefront client is not configured; unknown id → not_found', async () => {
    const { service } = harness({ broadcast: broadcastStub({ configured: false }) });
    expect(service.broadcastConfigured).toBe(false);
    const created = await service.save(input());
    if (!created.ok) throw new Error('unexpected');
    expect(await service.send(created.campaign.id)).toEqual({ ok: false, error: 'push_not_configured' });
    expect((await service.get(created.campaign.id))?.status).toBe('draft');
    expect(await service.send('push-nope')).toEqual({ ok: false, error: 'not_found' });
  });

  it('toBroadcastRequest omits icon when absent and keeps data string-only', () => {
    const c: PushCampaign = { ...input(), id: 'push-1', status: 'draft', createdAt: 'x', updatedAt: 'x' };
    expect(toBroadcastRequest(c)).toEqual({ title: c.title, body: c.body, data: { url: '/sale/tyres', campaignId: 'push-1' } });
  });
});

describe('push-campaign-store: parsing', () => {
  it('skips invalid records and tolerates an unexpected file shape', () => {
    const warn = vi.fn();
    const good: PushCampaign = { ...input(), id: 'push-ok', status: 'draft', createdAt: 'a', updatedAt: 'b' };
    const out = parsePushCampaignsFile({ version: 1, campaigns: [good, { id: 'broken' }, null] }, { warn });
    expect(out.map((c) => c.id)).toEqual(['push-ok']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(parsePushCampaignsFile({ nope: true }, { warn })).toEqual([]);
    expect(parsePushCampaignsFile([], { warn })).toEqual([]);
  });
});
