import { describe, expect, it, vi } from 'vitest';
import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto';
import { encryptPayload, sendWebPush, vapidAuthorization, type VapidKeys, type WebPushSubscription } from './web-push';

/** Ключи в формате `web-push generate-vapid-keys`: raw P-256 точка + скаляр. */
function makeVapidKeys(): VapidKeys & { publicKeyObject: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    publicKey: point.toString('base64url'),
    privateKey: jwk.d,
    subject: 'mailto:admin@example.com',
    publicKeyObject: publicKey,
  };
}

/** Браузерная сторона подписки: своя ECDH-пара + auth-секрет. */
function makeSubscription(endpoint = 'https://push.example.com/send/abc'): WebPushSubscription & { privateKey: Buffer } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    privateKey: ecdh.getPrivateKey(),
  };
}

/** Расшифровка по RFC 8291/8188 «как это сделал бы браузер». */
function decrypt(sub: ReturnType<typeof makeSubscription>, body: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20]!;
  const senderPub = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(sub.privateKey);
  const shared = ecdh.computeSecret(senderPub);
  const clientPub = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), clientPub, senderPub]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(padded[padded.length - 1]).toBe(0x02);
  return padded.subarray(0, padded.length - 1);
}

describe('encryptPayload', () => {
  it('produces an aes128gcm body the subscriber can decrypt', () => {
    const sub = makeSubscription();
    const body = encryptPayload(sub, Buffer.from('{"title":"Привет"}'));
    expect(decrypt(sub, body).toString('utf8')).toBe('{"title":"Привет"}');
  });

  it('is deterministic for a fixed salt + sender key (and different otherwise)', () => {
    const sub = makeSubscription();
    const salt = randomBytes(16);
    const localPrivateKey = createECDH('prime256v1');
    localPrivateKey.generateKeys();
    const a = encryptPayload(sub, Buffer.from('x'), { salt, localPrivateKey: localPrivateKey.getPrivateKey() });
    const b = encryptPayload(sub, Buffer.from('x'), { salt, localPrivateKey: localPrivateKey.getPrivateKey() });
    const c = encryptPayload(sub, Buffer.from('x'));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('rejects a malformed subscription', () => {
    const sub = makeSubscription();
    expect(() => encryptPayload({ ...sub, keys: { ...sub.keys, auth: 'AAAA' } }, Buffer.from('x'))).toThrow(/auth/);
    expect(() => encryptPayload({ ...sub, keys: { ...sub.keys, p256dh: 'AAAA' } }, Buffer.from('x'))).toThrow(/p256dh/);
  });

  it('rejects a payload that does not fit one record', () => {
    const sub = makeSubscription();
    expect(() => encryptPayload(sub, Buffer.alloc(4090))).toThrow(/too large/);
  });
});

describe('vapidAuthorization', () => {
  it('builds a valid ES256 JWT bound to the push service origin', () => {
    const keys = makeVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/xyz', keys, 1_700_000_000);
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, jwt, k] = m!;
    expect(k).toBe(keys.publicKey);
    const [h, p, sig] = jwt!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_700_000_000 + 12 * 3600,
      sub: 'mailto:admin@example.com',
    });
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: keys.publicKeyObject, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'));
    expect(ok).toBe(true);
  });

  it('rejects keys of the wrong shape', () => {
    expect(() => vapidAuthorization('https://x.example', { publicKey: 'AAAA', privateKey: 'AAAA', subject: 'mailto:a@b' })).toThrow(/public key/);
  });
});

describe('sendWebPush', () => {
  it('POSTs the encrypted body with VAPID + aes128gcm headers and maps 410 to gone', async () => {
    const keys = makeVapidKeys();
    const sub = makeSubscription();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
      expect(headers['Content-Encoding']).toBe('aes128gcm');
      expect(headers.TTL).toBe('60');
      expect(headers.Urgency).toBe('high');
      expect(decrypt(sub, init!.body as Buffer).toString()).toBe('{"a":1}');
      return { ok: false, status: 410 } as Response;
    });
    const res = await sendWebPush(sub, '{"a":1}', keys, { fetchImpl: fetchImpl as unknown as typeof fetch, ttlSec: 60 });
    expect(fetchImpl).toHaveBeenCalledWith(sub.endpoint, expect.objectContaining({ method: 'POST' }));
    expect(res).toEqual({ ok: false, status: 410, gone: true });
  });

  it('reports ok on 201', async () => {
    const keys = makeVapidKeys();
    const sub = makeSubscription();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201 }) as Response);
    expect(await sendWebPush(sub, 'hi', keys, { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ ok: true, status: 201, gone: false });
  });
});
