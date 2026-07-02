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

  it('warns "queue object missing in S3" for a missing queue object (≠ empty queue)', async () => {
    // Incident 2026-05-31: a missing queue-<name>.json looked exactly like an
    // empty queue in the logs. The response stays the same; the log must differ.
    putPool([makePromo({ id: 'a' })]);
    const warns: { obj: unknown; msg?: string }[] = [];
    const logger = { warn: (obj: unknown, msg?: string) => warns.push({ obj, msg }) };
    const svc = createConfigService(logger);

    const missing = await svc.getQueue('home');
    expect(missing).toEqual({ promos: [], persist: false });
    expect(warns).toEqual([{ obj: { queue: 'home' }, msg: 'queue object missing in S3' }]);

    // An EMPTY queue object (ids: []) is a legitimate state — no warn.
    warns.length = 0;
    putQueue('news', { persist: false, ids: [] });
    const empty = await svc.getQueue('news');
    expect(empty).toEqual({ promos: [], persist: false });
    expect(warns).toEqual([]);
  });

  it('throws on malformed pool JSON', async () => {
    put(promosKey(), '{not json');
    putQueue('home', { persist: false, ids: ['a'] });
    await expect(createConfigService().getQueue('home')).rejects.toThrow();
  });

  it('fetches the pool once for two different queues within the TTL (shared pool cache)', async () => {
    putPool([makePromo({ id: 'a' })]);
    putQueue('home', { persist: false, ids: ['a'] });
    putQueue('news', { persist: false, ids: ['a'] });
    const svc = createConfigService();
    expect((await svc.getQueue('home')).promos.map((p) => p.id)).toEqual(['a']);
    expect((await svc.getQueue('news')).promos.map((p) => p.id)).toEqual(['a']);
    const poolGets = s3Mock
      .commandCalls(GetObjectCommand)
      .filter((c) => c.args[0].input.Key === promosKey());
    expect(poolGets.length).toBe(1);
  });

  it('drops a single invalid pool record, keeps the valid ones, and warns', async () => {
    // One corrupt promo must not dark every slot on the site: per-item
    // validation drops (and logs) the broken record instead of failing the pool.
    putPool([makePromo({ id: 'a' }), { id: 'broken', format: 'nope' }, makePromo({ id: 'b' })]);
    putQueue('home', { persist: false, ids: ['a', 'broken', 'b'] });
    const warns: { obj: unknown; msg?: string }[] = [];
    const logger = { warn: (obj: unknown, msg?: string) => warns.push({ obj, msg }) };
    const result = await createConfigService(logger).getQueue('home');
    expect(result.promos.map((p) => p.id)).toEqual(['a', 'b']);
    expect(warns.length).toBe(1);
    expect(warns[0].obj).toMatchObject({ promoId: 'broken' });
  });
});
