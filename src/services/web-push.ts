/**
 * Минимальный Web Push-отправитель на node:crypto — RFC 8291 (шифрование
 * aes128gcm), RFC 8188 (формат тела) и RFC 8292 (VAPID). Без пакета web-push:
 * нам нужен один вызов «зашифровать + подписать + POST», а тянуть зависимость
 * с её собственным деревом (asn1.js, jws, agent'ы) ради этого не хочется.
 *
 * Ключи VAPID — в формате `npx web-push generate-vapid-keys`: публичный —
 * 65-байтная несжатая точка P-256 в base64url, приватный — 32 байта в base64url.
 * Подписка — то, что браузер отдаёт из PushSubscription.toJSON():
 * { endpoint, keys: { p256dh, auth } }.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** `mailto:` или https-URL владельца (VAPID sub). */
  subject: string;
}

export interface WebPushResult {
  ok: boolean;
  status: number;
  /** 404/410 — push-сервис говорит, что подписки больше нет. */
  gone: boolean;
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

/** Одна запись aes128gcm: 16 (соль) + 4 (rs) + 1 + 65 (ключ) в заголовке, дальше
 *  шифртекст. rs = 4096 покрывает любой наш payload (JSON на пару сотен байт). */
const RECORD_SIZE = 4096;
const VAPID_TTL_SEC = 12 * 60 * 60;

export function vapidPrivateKeyObject(keys: Pick<VapidKeys, 'publicKey' | 'privateKey'>): KeyObject {
  const pub = fromB64url(keys.publicKey);
  const priv = fromB64url(keys.privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a base64url 65-byte uncompressed P-256 point');
  }
  if (priv.length !== 32) throw new Error('VAPID private key must be a base64url 32-byte scalar');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: b64url(priv),
    },
    format: 'jwk',
  });
}

/** Значение заголовка Authorization для endpoint'а подписки (RFC 8292 §3). */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const url = new URL(endpoint);
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(
    Buffer.from(JSON.stringify({ aud: `${url.protocol}//${url.host}`, exp: nowSec + VAPID_TTL_SEC, sub: keys.subject })),
  );
  const signingInput = `${header}.${payload}`;
  // ES256 в JWT — «сырая» подпись r||s (64 байта), не DER.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

export interface EncryptOptions {
  /** Тестовый seam: фиксированная соль (16 байт). */
  salt?: Buffer;
  /** Тестовый seam: приватный ключ отправителя (32 байта) вместо случайного. */
  localPrivateKey?: Buffer;
}

/** Тело push-запроса: aes128gcm (RFC 8291 + RFC 8188), одна запись. */
export function encryptPayload(sub: WebPushSubscription, plaintext: Buffer, opts: EncryptOptions = {}): Buffer {
  const clientPub = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  if (clientPub.length !== 65 || clientPub[0] !== 0x04) throw new Error('subscription p256dh must be a 65-byte uncompressed point');
  if (authSecret.length !== 16) throw new Error('subscription auth must be 16 bytes');
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error(`push payload too large (${plaintext.length} bytes)`);

  const ecdh = createECDH('prime256v1');
  if (opts.localPrivateKey) ecdh.setPrivateKey(opts.localPrivateKey);
  else ecdh.generateKeys();
  const localPub = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPub);

  // RFC 8291 §3.3–3.4: IKM = HKDF(auth, ecdh, "WebPush: info" || 0x00 || ua_pub || as_pub)
  const ikmInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), clientPub, localPub]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, ikmInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // RFC 8188 §2: последняя (единственная) запись — паддинг-разделитель 0x02.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([localPub.length]), localPub]);
  return Buffer.concat([header, ciphertext]);
}

export interface SendOptions {
  ttlSec?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  timeoutMs?: number;
  /** Тестовый seam. */
  fetchImpl?: typeof fetch;
}

/** POST на endpoint подписки. Не бросает на не-2xx — возвращает статус; бросает
 *  только на сетевой сбой/таймаут (как и остальные клиенты BFF). */
export async function sendWebPush(
  sub: WebPushSubscription,
  payload: string,
  keys: VapidKeys,
  opts: SendOptions = {},
): Promise<WebPushResult> {
  const body = encryptPayload(sub, Buffer.from(payload, 'utf8'));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(sub.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlSec ?? 24 * 60 * 60),
      Urgency: opts.urgency ?? 'high',
    },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
