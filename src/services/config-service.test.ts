import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createConfigService } from './config-service';
import { promosKey, queueKey, getS3Client, resetS3ClientForTests } from './s3-client';
import { config } from '../config';
import { makePromo } from '../test-utils';

const put = (key: string, text: string) =>
  getS3Client().send(
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: key, Body: text, ContentType: 'application/json' }),
  );
const putPool = (promos: unknown) => put(promosKey(), JSON.stringify(promos));
const putQueue = (name: string, obj: unknown) => put(queueKey(name), JSON.stringify(obj));

beforeEach(() => {
  config.s3.keyPrefix = `test/abhpromo-config/${randomUUID()}/`;
  resetS3ClientForTests();
});

afterEach(async () => {
  const c = getS3Client();
  await c.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: promosKey() })).catch(() => {});
  await c.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: queueKey('home') })).catch(() => {});
  await c.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: queueKey('main') })).catch(() => {});
  config.s3.keyPrefix = '';
});

describe('configService.getQueue', () => {
  it('returns queued promos in queue order with persist flag', async () => {
    await putPool([makePromo({ id: 'a' }), makePromo({ id: 'b' }), makePromo({ id: 'c' })]);
    await putQueue('home', { persist: true, ids: ['b', 'a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['b', 'a']);
    expect(result.persist).toBe(true);
  });

  it('returns persist:false when flag is absent from queue object', async () => {
    await putPool([makePromo({ id: 'a' })]);
    await putQueue('home', { ids: ['a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a']);
    expect(result.persist).toBe(false);
  });

  it('excludes pool promos that are not in the queue', async () => {
    await putPool([makePromo({ id: 'a' }), makePromo({ id: 'b' })]);
    await putQueue('home', { persist: false, ids: ['a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a']);
  });

  it('skips queue ids that have no matching pool promo (dangling)', async () => {
    await putPool([makePromo({ id: 'a' })]);
    await putQueue('home', { persist: false, ids: ['ghost', 'a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a']);
  });

  it('returns empty promos and persist:false when the queue object does not exist', async () => {
    const result = await createConfigService().getQueue('home');
    expect(result).toEqual({ promos: [], persist: false });
  });

  it('throws on malformed pool JSON', async () => {
    await put(promosKey(), '{not json');
    await putQueue('home', { persist: false, ids: ['a'] });
    await expect(createConfigService().getQueue('home')).rejects.toThrow();
  });
});
