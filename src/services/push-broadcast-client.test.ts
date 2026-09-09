import { describe, expect, it, vi } from 'vitest';
import { generateKeyPair, verifyServiceTicket } from '@zebrooo/service-ticket';
import { createPushBroadcastClient, PushBroadcastError } from './push-broadcast-client';
import type { AaPushConfig } from '../config';

const keys = generateKeyPair();

const cfg = (over: Partial<AaPushConfig> = {}): AaPushConfig => ({
  baseUrl: 'https://aa.example',
  broadcastPath: '/api/v1/push/broadcast',
  ticketPrivateKey: keys.privateKey,
  ticketSrc: 'promo-bff',
  ticketDst: 'abkhaz-auto',
  timeoutMs: 1000,
  ...over,
});

function fetchStub(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('push-broadcast-client', () => {
  it('is unconfigured without AA_BASE_URL or the private key', () => {
    expect(createPushBroadcastClient(cfg({ baseUrl: '' })).configured).toBe(false);
    expect(createPushBroadcastClient(cfg({ ticketPrivateKey: '' })).configured).toBe(false);
    expect(createPushBroadcastClient(cfg()).configured).toBe(true);
  });

  it('POSTs the payload to the storefront with a service ticket src=promo-bff dst=abkhaz-auto', async () => {
    const { impl, calls } = fetchStub(200, { ok: true, users: 3, attempted: 4, delivered: 4, failed: 0 });
    const client = createPushBroadcastClient(cfg(), { fetchImpl: impl });
    const res = await client.broadcast({ title: 'T', body: 'B', data: { url: '/x' } });
    expect(res).toEqual({ users: 3, attempted: 4, delivered: 4, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://aa.example/api/v1/push/broadcast');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ title: 'T', body: 'B', data: { url: '/x' } });
    const headers = calls[0].init.headers as Record<string, string>;
    const payload = verifyServiceTicket(headers['x-service-ticket'], { publicKey: keys.publicKey, expectedDst: 'abkhaz-auto', allowedSrc: ['promo-bff'] });
    expect(payload).toMatchObject({ src: 'promo-bff', dst: 'abkhaz-auto' });
  });

  it('throws PushBroadcastError on non-2xx (with the storefront error code) and on a malformed body', async () => {
    const bad = createPushBroadcastClient(cfg(), { fetchImpl: fetchStub(503, { error: 'fcm_not_configured' }).impl });
    await expect(bad.broadcast({ title: 'T', body: 'B' })).rejects.toMatchObject({
      name: 'PushBroadcastError', status: 503, message: expect.stringContaining('fcm_not_configured'),
    });
    const weird = createPushBroadcastClient(cfg(), { fetchImpl: fetchStub(200, { ok: true }).impl });
    await expect(weird.broadcast({ title: 'T', body: 'B' })).rejects.toBeInstanceOf(PushBroadcastError);
  });

  it('rejects with a timeout when the storefront hangs', async () => {
    const hang = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const client = createPushBroadcastClient(cfg({ timeoutMs: 20 }), { fetchImpl: hang });
    await expect(client.broadcast({ title: 'T', body: 'B' })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
