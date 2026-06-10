/**
 * Tiny in-memory TTL cache for AI enhance results. Generic over the value
 * shape so we don't bake in the enhance-promo payload. Cleans up expired
 * entries lazily on read — good enough at our scale (a few RPS, 10-min TTLs).
 *
 * Also exports `canonicalCacheKey()`, a stable sha256 over a canonical-form
 * payload (object keys sorted) so two structurally identical drafts produce
 * the same key regardless of property order in the JSON.
 */
import { createHash } from 'node:crypto';

export interface AiCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs?: number): void;
  size(): number;
  /** Test helper. */
  clear(): void;
}

export interface CreateAiCacheOpts {
  /** Default ttl when set() isn't given an explicit one. */
  defaultTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface Entry<T> { value: T; expiresAt: number }

export function createAiCache<T>(opts: CreateAiCacheOpts = {}): AiCache<T> {
  const defaultTtlMs = opts.defaultTtlMs ?? 10 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const store = new Map<string, Entry<T>>();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      store.set(key, { value, expiresAt: now() + (ttlMs ?? defaultTtlMs) });
    },
    size() { return store.size; },
    clear() { store.clear(); },
  };
}

/** Canonical JSON: object keys are sorted at every nesting level so two
 *  semantically equal payloads produce the same string. */
function canonicalStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

/** sha256(canonical JSON) — stable across property orderings. Hex output. */
export function canonicalCacheKey(parts: unknown): string {
  return createHash('sha256').update(canonicalStringify(parts)).digest('hex');
}
