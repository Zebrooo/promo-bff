import { describe, expect, it } from 'vitest';
import { HotBuyerChecker, hasHotBuyerRule } from './HotBuyer';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new HotBuyerChecker();

function context(hotBuyer: { minPhoneViews?: number } | undefined, phoneViews7d?: number) {
  return makeCheckContext({
    promo: makePromo({ targeting: hotBuyer ? { behavior: { hotBuyer } } : {} }),
    ...(phoneViews7d === undefined ? {} : { behavior: { interests: [], phoneViews7d } }),
  });
}

describe('HotBuyerChecker', () => {
  it('skips when the promo has no hotBuyer rule', () => {
    expect(checker.shouldSkip(context(undefined))).toBe('no hot-buyer targeting');
    expect(hasHotBuyerRule(makePromo())).toBe(false);
  });

  it('passes on the boundary phoneViews7d === minPhoneViews', () => {
    expect(checker.check(context({ minPhoneViews: 3 }, 3))).toBe(true);
    expect(checker.check(context({ minPhoneViews: 3 }, 2))).toBe(false);
  });

  it('defaults minPhoneViews to 2', () => {
    expect(checker.check(context({}, 2))).toBe(true);
    expect(checker.check(context({}, 1))).toBe(false);
  });

  it('fails closed without a signal', () => {
    expect(checker.check(context({ minPhoneViews: 1 }, undefined))).toBe(false);
  });

  it('fails closed on a hand-written minPhoneViews: 0 (invalid rule, not a pass-for-all)', () => {
    const ctx = context({ minPhoneViews: 0 }, 5);
    expect(checker.shouldSkip(ctx)).toBe(false);
    expect(checker.check(ctx)).toBe(false);
  });
});
