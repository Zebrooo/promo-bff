/**
 * Config service — reads the promo pool + a named queue from S3 and joins them into the
 * ordered list of active promos (queue order; first match wins downstream).
 *
 * Reads are cached in-process with a short TTL (see CATALOGUE_CACHE_TTL_MS). The
 * pool + queues live in S3 and change only when the cabinet publishes, so without
 * a cache every /models hit paid two fresh S3 GETs — the dominant hot-path
 * latency. The TTL collapses that to ~one GET-pair per queue per window under
 * load, while a cabinet edit still takes effect within the TTL. Missing objects
 * read as empty. The JSON is defensively zod-validated, so corrupt data throws
 * (→ handled as an "error" envelope) and is never cached.
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Promo } from '../promo-selector/types';
import { config } from '../config';
import { withTimeout } from '../util/with-timeout';
import { promosKey, queueKey, getS3Client, isNoSuchKey } from './s3-client';
import { parsePoolLeniently, queueObjectSchema } from './catalogue-schema';

/** Minimal logger shape (Fastify's logger satisfies it; tests may pass nothing). */
export interface ConfigLogger {
  warn(obj: unknown, msg?: string): void;
}

async function readObject(key: string): Promise<string | null> {
  try {
    const res = await getS3Client().send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    if (!res.Body) return null;
    return await res.Body.transformToString();
  } catch (err) {
    if (isNoSuchKey(err)) return null;
    throw err;
  }
}

async function fetchPool(logger?: ConfigLogger): Promise<Promo[]> {
  const poolText = await readObject(promosKey());
  if (poolText === null) return [];
  // Per-item validation: a single corrupt promo is dropped (and logged), it
  // must not dark every slot on the site. Non-array pool JSON still throws.
  const { promos, rejected } = parsePoolLeniently(JSON.parse(poolText));
  for (const r of rejected) {
    logger?.warn({ promoId: r.promoId, issues: r.issues }, 'config: invalid promo dropped from pool');
  }
  return promos;
}

interface QueueObject {
  persist: boolean;
  ids: string[];
}

async function fetchQueueObject(queueName: string, logger?: ConfigLogger): Promise<QueueObject> {
  const queueText = await readObject(queueKey(queueName));
  if (queueText === null) {
    // Distinguish "the object was never written / was deleted" from a
    // legitimately EMPTY queue (ids: []) — in the 2026-05-31 incident the two
    // were indistinguishable and the dark slot went unnoticed. The response to
    // the client stays the same (empty queue); only the log differs.
    logger?.warn({ queue: queueName }, 'queue object missing in S3');
    return { persist: false, ids: [] };
  }
  return queueObjectSchema.parse(JSON.parse(queueText));
}

export interface ConfigService {
  /** Ordered active promos for a named queue + the queue's persist flag. */
  getQueue(queueName: string): Promise<{ promos: Promo[]; persist: boolean }>;
  /** Promo by id straight from the pool, ignoring queues — used by
   *  GET /promo-lead-target, which needs a server-only field of a promo the
   *  site has already shown. Null when the pool has no such id. */
  getPromoById(promoId: string): Promise<Promo | null>;
}

/**
 * Catalogue cache TTL (ms). Tunable via env; 0 disables caching (every call
 * reads fresh, the pre-cache behaviour). Default 15s: under load nearly every
 * /models hit is served from memory, and a cabinet publish lands within 15s.
 */
const CATALOGUE_CACHE_TTL_MS = Number(process.env.CATALOGUE_CACHE_TTL_MS ?? 15_000);

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export function createConfigService(logger?: ConfigLogger): ConfigService {
  const ms = config.serviceTimeouts.configServiceMs;
  // Per-instance cache. buildServer() constructs exactly one ConfigService for
  // the server's lifetime, so in prod this is effectively process-wide; in tests
  // each createConfigService() gets its own empty cache, keeping cases isolated.
  // The pool (the heavy object) is cached ONCE under 'pool' and shared by every
  // queue; each queue entry ('queue:<name>') holds only the tiny queue object.
  // With N per-catalog queues that is 1+N S3 GETs per TTL window instead of 2N.
  // The cached values are treated read-only downstream (select-promo copies
  // fields off each promo, never mutates), so sharing references is safe.
  const cache = new Map<string, CacheEntry<unknown>>();

  const cachedLoad = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (CATALOGUE_CACHE_TTL_MS <= 0) return load();
    const nowMs = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowMs) return hit.value as T;
    const value = await load();
    // Only successful loads are cached; a throw propagates and is never stored.
    cache.set(key, { value, expiresAt: nowMs + CATALOGUE_CACHE_TTL_MS });
    return value;
  };

  return {
    getPromoById: async (promoId) => {
      // Тот же кэш пула, что и у getQueue: отдельных чтений S3 не добавляется.
      const pool = await withTimeout(
        cachedLoad('pool', () => fetchPool(logger)),
        ms,
        'configService.getPromoById',
      );
      return pool.find((p) => p.id === promoId) ?? null;
    },
    getQueue: async (queueName) => {
      const [pool, queueObj] = await withTimeout(
        Promise.all([
          cachedLoad('pool', () => fetchPool(logger)),
          cachedLoad(`queue:${queueName}`, () => fetchQueueObject(queueName, logger)),
        ]),
        ms,
        'configService.getQueue',
      );
      const byId = new Map(pool.map((p) => [p.id, p]));
      const promos = queueObj.ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined);
      return { promos, persist: queueObj.persist };
    },
  };
}
