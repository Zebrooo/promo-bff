import { describe, it, expect } from 'vitest';
import { canonicalCacheKey, createAiCache } from './ai-cache';

describe('createAiCache', () => {
  it('returns undefined for missing keys', () => {
    const cache = createAiCache<string>();
    expect(cache.get('nope')).toBeUndefined();
  });

  it('returns the value while not expired', () => {
    let t = 1_000_000;
    const cache = createAiCache<string>({ defaultTtlMs: 1000, now: () => t });
    cache.set('k', 'v');
    t += 500;
    expect(cache.get('k')).toBe('v');
  });

  it('treats entries as expired exactly at expiresAt and evicts them', () => {
    let t = 1_000_000;
    const cache = createAiCache<string>({ defaultTtlMs: 1000, now: () => t });
    cache.set('k', 'v');
    t += 1000;
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size()).toBe(0); // evicted on read
  });

  it('honours a per-call ttl override', () => {
    let t = 1_000_000;
    const cache = createAiCache<string>({ defaultTtlMs: 1000, now: () => t });
    cache.set('a', 'va', 100);
    cache.set('b', 'vb'); // default 1000
    t += 200;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('vb');
  });

  it('keys are independent', () => {
    const cache = createAiCache<number>();
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });
});

describe('canonicalCacheKey', () => {
  it('produces the same hash regardless of object key order', () => {
    const a = canonicalCacheKey({ a: 1, b: { c: 2, d: 3 } });
    const b = canonicalCacheKey({ b: { d: 3, c: 2 }, a: 1 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different content', () => {
    const a = canonicalCacheKey({ title: 'hi' });
    const b = canonicalCacheKey({ title: 'bye' });
    expect(a).not.toBe(b);
  });

  it('handles arrays positionally (order matters)', () => {
    const a = canonicalCacheKey([1, 2, 3]);
    const b = canonicalCacheKey([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it('hashes primitives as JSON.stringify would', () => {
    expect(canonicalCacheKey(null)).toBe(canonicalCacheKey(null));
    expect(canonicalCacheKey('x')).not.toBe(canonicalCacheKey('y'));
  });
});
