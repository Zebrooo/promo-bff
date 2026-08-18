import { describe, expect, it } from 'vitest';
import { EngagementChecker } from './Engagement';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new EngagementChecker();

function context(minSessionViews: number | undefined, sessionViews?: number) {
  return makeCheckContext({
    promo: makePromo({
      targeting: minSessionViews === undefined ? {} : { behavior: { minSessionViews } },
    }),
    sessionViews,
  });
}

describe('EngagementChecker', () => {
  it('skips when the promo has no minSessionViews', () => {
    expect(checker.shouldSkip(context(undefined))).toBe('no engagement targeting');
  });

  it('passes on the boundary sessionViews === minSessionViews', () => {
    expect(checker.check(context(5, 5))).toBe(true);
    expect(checker.check(context(5, 4))).toBe(false);
  });

  it('fails closed when sessionViews is unknown', () => {
    expect(checker.check(context(1, undefined))).toBe(false);
  });

  it('fails closed on a hand-written minSessionViews: 0 (invalid rule, not a pass-for-all)', () => {
    const ctx = context(0, 10);
    expect(checker.shouldSkip(ctx)).toBe(false);
    expect(checker.check(ctx)).toBe(false);
  });
});
