import { describe, it, expect } from 'vitest';
import { createRateLimitStore } from './rate-limit-store';

describe('createRateLimitStore', () => {
  it('lets the first hit through with count=1', () => {
    const store = createRateLimitStore({ limit: 3, windowMs: 1000, now: () => 0 });
    expect(store.hit('a')).toEqual({ ok: true, count: 1 });
  });

  it('accepts up to `limit` hits in a window and rejects the next', () => {
    let t = 0;
    const store = createRateLimitStore({ limit: 3, windowMs: 1000, now: () => t });
    expect(store.hit('a').ok).toBe(true); t += 100;
    expect(store.hit('a').ok).toBe(true); t += 100;
    expect(store.hit('a').ok).toBe(true); t += 100;
    const blocked = store.hit('a');
    expect(blocked.ok).toBe(false);
    expect(blocked.count).toBe(3);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('does NOT count rejected attempts (count stays at limit)', () => {
    let t = 0;
    const store = createRateLimitStore({ limit: 2, windowMs: 1000, now: () => t });
    store.hit('a'); t += 100;
    store.hit('a'); t += 100;
    expect(store.hit('a').ok).toBe(false);
    expect(store.hit('a').ok).toBe(false); // still 2, not 4
    // Advance past the window — first slot frees up.
    t += 1000;
    expect(store.hit('a').ok).toBe(true);
  });

  it('reports retryAfterMs as time until the oldest hit ages out', () => {
    let t = 0;
    const store = createRateLimitStore({ limit: 1, windowMs: 1000, now: () => t });
    store.hit('a'); // recorded at t=0
    t = 300;
    const blocked = store.hit('a');
    expect(blocked.ok).toBe(false);
    // oldest=0, window=1000, now=300 → retry in 700ms.
    expect(blocked.retryAfterMs).toBe(700);
  });

  it('rolls the window forward — old hits expire and capacity recovers', () => {
    let t = 0;
    const store = createRateLimitStore({ limit: 2, windowMs: 1000, now: () => t });
    store.hit('a'); t += 100;
    store.hit('a'); // at limit
    t += 1000;     // first hit (at 0) now > windowMs old; second (at 100) still within at t=1100
    expect(store.hit('a').ok).toBe(true);
  });

  it('keeps keys independent', () => {
    const store = createRateLimitStore({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(store.hit('a').ok).toBe(true);
    expect(store.hit('b').ok).toBe(true);
    expect(store.hit('a').ok).toBe(false);
    expect(store.hit('b').ok).toBe(false);
  });

  it('30/hour scenario — 31st request in the same hour is rejected', () => {
    let t = 0;
    const store = createRateLimitStore({ limit: 30, windowMs: 60 * 60 * 1000, now: () => t });
    for (let i = 0; i < 30; i++) {
      expect(store.hit('adv1').ok).toBe(true);
      t += 1000; // 1 per second
    }
    expect(store.hit('adv1')).toMatchObject({ ok: false });
  });

  it('throws on invalid limit / windowMs', () => {
    expect(() => createRateLimitStore({ limit: 0, windowMs: 100 })).toThrow();
    expect(() => createRateLimitStore({ limit: 1, windowMs: 0 })).toThrow();
  });
});
