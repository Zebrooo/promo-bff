import { describe, expect, it } from 'vitest';
import { PurchaseChecker } from './Purchases';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new PurchaseChecker();
const now = new Date('2026-08-13T12:00:00.000Z');
const entry = (pack: 'bump' | 'premium' | 'vip', amountKopecks: number, createdAt = '2026-08-10T00:00:00.000Z') => ({
  pack,
  amountKopecks,
  createdAt,
});

function context(
  purchases: NonNullable<ReturnType<typeof makePromo>['targeting']['purchases']>,
  entries = [entry('vip', 69000)],
  isAuthorized = true,
) {
  return makeCheckContext({
    promo: makePromo({ targeting: { purchases } }),
    isAuthorized,
    now,
    purchases: entries,
  });
}

describe('PurchaseChecker', () => {
  it('skips when no rule is configured', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no purchase targeting');
  });

  it('skips for an empty object (regression: empty-object-not-treated-as-rule)', () => {
    // {} previously counted as "a rule is configured" because hasPurchaseRule only checked
    // `!== undefined`; an empty (or all-undefined-fields) object must mean "no rule".
    expect(checker.shouldSkip(context({}))).toBe('no purchase targeting');
  });

  it('skips when only lookbackDays is set (modifier, not a criterion)', () => {
    expect(checker.shouldSkip(context({ lookbackDays: 60 }))).toBe('no purchase targeting');
  });

  it('does not skip when purchased is explicitly false', () => {
    expect(checker.shouldSkip(context({ purchased: false }))).toBe(false);
  });

  it('fails closed for an unauthorized viewer even with matching purchases', () => {
    expect(checker.check(context({ purchased: true }, [entry('vip', 69000)], false))).toBe(false);
  });

  it('purchased:true requires at least one qualifying purchase in the window', () => {
    expect(checker.check(context({ purchased: true }, []))).toBe(false);
    expect(checker.check(context({ purchased: true }, [entry('bump', 14900)]))).toBe(true);
  });

  it('purchased:false requires zero purchases in the window', () => {
    expect(checker.check(context({ purchased: false }, []))).toBe(true);
    expect(checker.check(context({ purchased: false }, [entry('bump', 14900)]))).toBe(false);
  });

  it('filters by packTypes before applying other conditions', () => {
    const rule = { packTypes: ['vip' as const], minCount: 1 };
    expect(checker.check(context(rule, [entry('bump', 14900)]))).toBe(false);
    expect(checker.check(context(rule, [entry('vip', 69000)]))).toBe(true);
  });

  it('enforces minCount/maxCount over the qualifying purchases', () => {
    const three = [entry('bump', 14900), entry('bump', 14900), entry('bump', 14900)];
    expect(checker.check(context({ minCount: 3 }, three))).toBe(true);
    expect(checker.check(context({ minCount: 4 }, three))).toBe(false);
    expect(checker.check(context({ maxCount: 2 }, three))).toBe(false);
  });

  it('enforces minTotalKopecks/maxTotalKopecks over the sum of qualifying purchases', () => {
    const two = [entry('vip', 69000), entry('premium', 49000)];
    expect(checker.check(context({ minTotalKopecks: 100000 }, two))).toBe(true);
    expect(checker.check(context({ minTotalKopecks: 200000 }, two))).toBe(false);
    expect(checker.check(context({ maxTotalKopecks: 100000 }, two))).toBe(false);
  });

  it('honours the configured lookback window (default 30 days)', () => {
    const old = entry('vip', 69000, '2026-07-01T00:00:00.000Z');
    expect(checker.check(context({ minCount: 1 }, [old]))).toBe(false); // > 30 дней от now
    expect(checker.check(context({ minCount: 1, lookbackDays: 60 }, [old]))).toBe(true);
  });

  it('fails closed when the purchase fetch failed (ctx.purchases undefined), not treated as zero purchases', () => {
    const ctx = context({ purchased: false }, []);
    expect(checker.check({ ...ctx, purchases: undefined })).toBe(false); // NOT true, even though purchased:false would trivially pass on an empty array
  });
});
