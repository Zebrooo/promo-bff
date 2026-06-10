import { describe, expect, it } from 'vitest';
import { LimitChecker, CooldownChecker } from './Frequency';
import { makeCheckContext, makePromo, makeSuppliers } from '../../../test-utils';

describe('LimitChecker', () => {
  const c = new LimitChecker();
  it('skips when no cap is configured', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ id: 'p' }) }))).toBeTruthy();
  });
  it('passes under the cap, fails at the cap', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', maxImpressionsPerUser: 3 }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { p: 2 } }))).toBe(true);
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { p: 3 } }))).toBe(false);
  });
});

describe('CooldownChecker', () => {
  const c = new CooldownChecker();
  const now = new Date('2024-06-01T12:00:00.000Z');
  it('skips when cooldownHours <= 0', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ cooldownHours: 0 }) }))).toBeTruthy();
  });
  it('blocks within the cooldown window', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', cooldownHours: 24 }), now });
    expect(c.check(ctx, makeSuppliers({ lastShownAt: { p: '2024-06-01T11:00:00.000Z' } }))).toBe(false);
  });
  it('allows after the cooldown elapses', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', cooldownHours: 24 }), now });
    expect(c.check(ctx, makeSuppliers({ lastShownAt: { p: '2024-05-30T12:00:00.000Z' } }))).toBe(true);
  });
  it('allows when never shown', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', cooldownHours: 24 }), now });
    expect(c.check(ctx, makeSuppliers({ lastShownAt: {} }))).toBe(true);
  });
  it('allows at exactly the cooldown boundary', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', cooldownHours: 24 }), now });
    // exactly 24h before now → elapsed === cooldown, >= passes
    expect(c.check(ctx, makeSuppliers({ lastShownAt: { p: '2024-05-31T12:00:00.000Z' } }))).toBe(true);
  });
});
