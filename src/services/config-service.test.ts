import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GetObjectCommand, S3Client, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { createConfigService } from './config-service';
import { promosKey, queueKey, resetS3ClientForTests } from './s3-client';
import { makePromo } from '../test-utils';

/**
 * In-memory S3: GetObjectCommand is served from `objects` (key → JSON text);
 * a missing key rejects with NoSuchKey, exactly like the real bucket. No live
 * S3 endpoint or credentials are needed.
 */
const s3Mock = mockClient(S3Client);
let objects: Map<string, string>;

const put = (key: string, text: string) => {
  objects.set(key, text);
};
const putPool = (promos: unknown) => put(promosKey(), JSON.stringify(promos));
const putQueue = (name: string, obj: unknown) => put(queueKey(name), JSON.stringify(obj));

beforeEach(() => {
  objects = new Map();
  s3Mock.reset();
  s3Mock.on(GetObjectCommand).callsFake((input: { Key: string }) => {
    const text = objects.get(input.Key);
    if (text === undefined) {
      const err = new Error(`NoSuchKey: ${input.Key}`);
      err.name = 'NoSuchKey';
      throw err;
    }
    const body = { transformToString: async () => text };
    return { Body: body as unknown as GetObjectCommandOutput['Body'] };
  });
});

afterAll(() => {
  s3Mock.restore();
  resetS3ClientForTests();
});

describe('configService.getQueue', () => {
  it('returns queued promos in queue order with persist flag', async () => {
    putPool([makePromo({ id: 'a' }), makePromo({ id: 'b' }), makePromo({ id: 'c' })]);
    putQueue('home', { persist: true, ids: ['b', 'a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['b', 'a']);
    expect(result.persist).toBe(true);
  });

  it('returns persist:false when flag is absent from queue object', async () => {
    putPool([makePromo({ id: 'a' })]);
    putQueue('home', { ids: ['a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a']);
    expect(result.persist).toBe(false);
  });

  it('excludes pool promos that are not in the queue', async () => {
    putPool([makePromo({ id: 'a' }), makePromo({ id: 'b' })]);
    putQueue('home', { persist: false, ids: ['a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a']);
  });

  it('skips queue ids that have no matching pool promo (dangling)', async () => {
    putPool([makePromo({ id: 'a' })]);
    putQueue('home', { persist: false, ids: ['ghost', 'a'] });
    const result = await createConfigService().getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a']);
  });

  it('returns empty promos and persist:false when the queue object does not exist', async () => {
    const result = await createConfigService().getQueue('home');
    expect(result).toEqual({ promos: [], persist: false });
  });

  it('throws on malformed pool JSON', async () => {
    put(promosKey(), '{not json');
    putQueue('home', { persist: false, ids: ['a'] });
    await expect(createConfigService().getQueue('home')).rejects.toThrow();
  });
});
