import { describe, expect, it } from 'vitest';
import { InterestChecker, hasInterestRule } from './Interest';
import { makeCheckContext, makePromo } from '../../../test-utils';
import type { BehaviorSignal } from '../Checker';

const checker = new InterestChecker();
const now = new Date('2026-08-17T12:00:00.000Z');

const signal = (interests: BehaviorSignal['interests']): BehaviorSignal => ({
  interests,
  phoneViews7d: 0,
});

function context(
  interest: { categories?: string[]; lookbackDays?: number } | undefined,
  behavior?: BehaviorSignal,
) {
  return makeCheckContext({
    promo: makePromo({ targeting: interest ? { behavior: { interest } } : {} }),
    now,
    behavior,
  });
}

describe('InterestChecker', () => {
  it('skips when no interest categories are configured', () => {
    expect(checker.shouldSkip(context(undefined))).toBe('no interest targeting');
    expect(checker.shouldSkip(context({ categories: [] }))).toBe('no interest targeting');
    expect(checker.shouldSkip(context({ categories: ['  '] }))).toBe('no interest targeting');
    expect(hasInterestRule(makePromo())).toBe(false);
  });

  it('passes when a targeted category was viewed inside the window (OR inside the list)', () => {
    expect(checker.check(context(
      { categories: ['shiny', 'diski'] },
      signal([{ category: 'shiny', lastViewedAt: '2026-08-16T10:00:00.000Z' }]),
    ))).toBe(true);
  });

  it('fails when the category view is older than lookbackDays (default 7)', () => {
    const stale = signal([{ category: 'shiny', lastViewedAt: '2026-08-01T10:00:00.000Z' }]);
    expect(checker.check(context({ categories: ['shiny'] }, stale))).toBe(false);
    expect(checker.check(context({ categories: ['shiny'], lookbackDays: 14 }, stale))).toBe(false);
    expect(checker.check(context(
      { categories: ['shiny'], lookbackDays: 14 },
      signal([{ category: 'shiny', lastViewedAt: '2026-08-05T10:00:00.000Z' }]),
    ))).toBe(true);
  });

  it('fails closed when the signal was not loaded', () => {
    expect(checker.check(context({ categories: ['shiny'] }, undefined))).toBe(false);
  });

  it('does not skip a hand-written rule with an empty-string category and fails it closed', () => {
    const ctx = context({ categories: ['shiny', ''] },
      signal([{ category: 'shiny', lastViewedAt: '2026-08-16T10:00:00.000Z' }]));
    expect(checker.shouldSkip(ctx)).toBe(false);
    expect(checker.check(ctx)).toBe(false);
  });

  it('compares slugs case-insensitively after trim', () => {
    expect(checker.check(context(
      { categories: [' SHINY '] },
      signal([{ category: 'shiny', lastViewedAt: '2026-08-16T10:00:00.000Z' }]),
    ))).toBe(true);
  });

  it('fails closed on a hand-written out-of-range lookbackDays', () => {
    const fresh = signal([{ category: 'shiny', lastViewedAt: '2026-08-16T10:00:00.000Z' }]);
    expect(checker.check(context({ categories: ['shiny'], lookbackDays: 0 }, fresh))).toBe(false);
    expect(checker.check(context({ categories: ['shiny'], lookbackDays: 15 }, fresh))).toBe(false);
  });

  it('ignores interest rows dated in the future (clock skew is not a match)', () => {
    expect(checker.check(context(
      { categories: ['shiny'] },
      signal([{ category: 'shiny', lastViewedAt: '2026-08-18T10:00:00.000Z' }]),
    ))).toBe(false);
  });
});
