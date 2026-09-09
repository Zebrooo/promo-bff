import { describe, expect, it, vi } from 'vitest';
import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createAdminNotifier, createAdminNotifierFromConfig, parsePushSubscriptions } from './admin-notifier';

function vapid() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d, subject: 'mailto:a@b.c' };
}

function subscription(endpoint: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

describe('parsePushSubscriptions', () => {
  it('accepts the cabinet file shape and a bare array, dropping malformed entries', () => {
    const good = subscription('https://push.example/1');
    const parsed = parsePushSubscriptions({
      version: 1,
      subscriptions: [
        { ...good, createdAt: '2026-09-01T00:00:00Z', userAgent: 'UA' },
        { endpoint: 'http://insecure.example/2', keys: good.keys },
        { endpoint: 'https://push.example/3' },
        'garbage',
      ],
    });
    expect(parsed).toEqual([{ ...good, createdAt: '2026-09-01T00:00:00Z', userAgent: 'UA' }]);
    expect(parsePushSubscriptions([good])).toEqual([good]);
    expect(parsePushSubscriptions(null)).toEqual([]);
  });
});

describe('createAdminNotifier', () => {
  it('reports no channels when nothing is configured and delivers nothing', async () => {
    const n = createAdminNotifier({});
    expect(n.channels).toEqual([]);
    expect(await n.notify({ title: 't', body: 'b' })).toEqual({ attempted: 0, delivered: 0, failed: 0 });
  });

  it('fans out to every push subscription and every telegram chat, counting failures per recipient', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      if (String(url).endsWith('/dead')) return { ok: false, status: 410 } as Response;
      if (String(url).includes('api.telegram.org')) {
        const body = JSON.parse(init!.body as string) as { chat_id: string };
        return { ok: body.chat_id !== 'bad', status: body.chat_id === 'bad' ? 400 : 200 } as Response;
      }
      return { ok: true, status: 201 } as Response;
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const n = createAdminNotifier({
      webPush: { keys: vapid(), loadSubscriptions: async () => [subscription('https://push.example/ok'), subscription('https://push.example/dead')] },
      telegram: { botToken: 'TOKEN', chatIds: ['1', 'bad'] },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    });
    expect(n.channels).toEqual(['webPush', 'telegram']);
    const out = await n.notify({ title: 'Новая кампания', body: '<b>x</b> & y', url: 'https://cab.example/cabinet/campaigns' });
    expect(out).toEqual({ attempted: 4, delivered: 2, failed: 2 });

    const tg = calls.filter((c) => c.url.includes('api.telegram.org'));
    expect(tg).toHaveLength(2);
    expect(tg[0]!.url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
    const payload = JSON.parse(tg[0]!.init.body as string) as Record<string, unknown>;
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).toContain('<b>Новая кампания</b>');
    expect(payload.text).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
    expect(payload.text).toContain('href="https://cab.example/cabinet/campaigns"');
    expect(logger.warn).toHaveBeenCalledTimes(2);
    // Токен бота в предупреждения не попадает.
    for (const call of logger.warn.mock.calls) expect(JSON.stringify(call)).not.toContain('TOKEN');
  });

  it('survives an unreadable subscription store', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const n = createAdminNotifier({
      webPush: { keys: vapid(), loadSubscriptions: async () => { throw new Error('s3 down'); } },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      logger,
    });
    expect(await n.notify({ title: 't', body: 'b' })).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(logger.error).toHaveBeenCalled();
  });

  it('createAdminNotifierFromConfig enables a channel only with a complete config', () => {
    const none = createAdminNotifierFromConfig({
      webPush: { vapidPublicKey: 'x', vapidPrivateKey: '', subject: 's' },
      telegram: { botToken: 't', chatIds: [] },
    });
    expect(none.channels).toEqual([]);
    const both = createAdminNotifierFromConfig({
      webPush: { vapidPublicKey: 'x', vapidPrivateKey: 'y', subject: 's' },
      telegram: { botToken: 't', chatIds: ['1'] },
    });
    expect(both.channels).toEqual(['webPush', 'telegram']);
  });
});
