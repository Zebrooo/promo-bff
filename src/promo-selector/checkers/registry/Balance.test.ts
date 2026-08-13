import { describe, expect, it } from 'vitest';
import { BalanceChecker } from './Balance';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new BalanceChecker();

function context(
  balance: NonNullable<ReturnType<typeof makePromo>['targeting']['balance']>,
  overrides: { walletBalanceKopecks?: number; walletMovementByWindow?: Map<number | undefined, number>; isAuthorized?: boolean } = {},
) {
  return makeCheckContext({
    promo: makePromo({ targeting: { balance } }),
    isAuthorized: overrides.isAuthorized ?? true,
    walletBalanceKopecks: overrides.walletBalanceKopecks,
    walletMovementByWindow: overrides.walletMovementByWindow,
  });
}

/** Builds a walletMovementByWindow map with a single entry, keyed by the rule's own window. */
function movementMap(movementLookbackDays: number | undefined, valueKopecks: number): Map<number | undefined, number> {
  return new Map([[movementLookbackDays, valueKopecks]]);
}

describe('BalanceChecker', () => {
  it('skips when no rule is configured', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no balance targeting');
  });

  it('skips for an empty object (regression: empty-object-not-treated-as-rule)', () => {
    // {} previously counted as "a rule is configured" because hasBalanceRule only checked
    // `!== undefined`; an empty (or all-undefined-fields) object must mean "no rule".
    expect(checker.shouldSkip(context({}))).toBe('no balance targeting');
  });

  it('skips when only movementLookbackDays is set (modifier, not a criterion)', () => {
    expect(checker.shouldSkip(context({ movementLookbackDays: 14 }))).toBe('no balance targeting');
  });

  it('fails closed for an unauthorized viewer', () => {
    expect(checker.check(context({ currentAbove: 0 }, { walletBalanceKopecks: 100000, isAuthorized: false }))).toBe(false);
  });

  it('enforces currentAbove/currentBelow against walletBalanceKopecks', () => {
    expect(checker.check(context({ currentAbove: 50000 }, { walletBalanceKopecks: 100000 }))).toBe(true);
    expect(checker.check(context({ currentAbove: 150000 }, { walletBalanceKopecks: 100000 }))).toBe(false);
    expect(checker.check(context({ currentBelow: 50000 }, { walletBalanceKopecks: 30000 }))).toBe(true);
    expect(checker.check(context({ currentBelow: 50000 }, { walletBalanceKopecks: 100000 }))).toBe(false);
  });

  it('treats a missing walletBalanceKopecks as 0', () => {
    expect(checker.check(context({ currentAbove: 1 }))).toBe(false);
    expect(checker.check(context({ currentBelow: 1 }))).toBe(true);
  });

  it('treats a missing walletMovementByWindow entry as 0', () => {
    expect(checker.check(context({ movementAbove: 1 }))).toBe(false);
    expect(checker.check(context({ movementBelow: 1 }))).toBe(true);
  });

  it('enforces movementAbove/movementBelow against the window keyed by the rule\'s own movementLookbackDays', () => {
    expect(checker.check(context({ movementAbove: 50000 }, { walletMovementByWindow: movementMap(undefined, 100000) }))).toBe(true);
    expect(checker.check(context({ movementAbove: 150000 }, { walletMovementByWindow: movementMap(undefined, 100000) }))).toBe(false);
    expect(checker.check(context({ movementBelow: -10000 }, { walletMovementByWindow: movementMap(undefined, -50000) }))).toBe(true);
    expect(
      checker.check(context({ movementAbove: 50000, movementLookbackDays: 30 }, { walletMovementByWindow: movementMap(30, 100000) })),
    ).toBe(true);
  });

  it('combines current and movement conditions with AND', () => {
    const rule = { currentAbove: 10000, movementBelow: 0 };
    expect(checker.check(context(rule, { walletBalanceKopecks: 20000, walletMovementByWindow: movementMap(undefined, -5000) }))).toBe(true);
    expect(checker.check(context(rule, { walletBalanceKopecks: 5000, walletMovementByWindow: movementMap(undefined, -5000) }))).toBe(false);
    expect(checker.check(context(rule, { walletBalanceKopecks: 20000, walletMovementByWindow: movementMap(undefined, 5000) }))).toBe(false);
  });

  it('reads each rule\'s own movement window independently — a 7-day rule and a 30-day rule in the same context see their own number, not each other\'s (regression: previously a single queue-wide max-window value was shared by all balance rules)', () => {
    const byWindow = new Map<number | undefined, number>([
      [7, 5000],
      [30, 90000],
    ]);
    // 7-day rule: movement is 5000 → passes movementAbove: 1000, fails movementAbove: 10000.
    expect(checker.check(context({ movementAbove: 1000, movementLookbackDays: 7 }, { walletMovementByWindow: byWindow }))).toBe(true);
    expect(checker.check(context({ movementAbove: 10000, movementLookbackDays: 7 }, { walletMovementByWindow: byWindow }))).toBe(false);
    // 30-day rule: movement is 90000 → passes movementAbove: 10000, fails movementAbove: 100000.
    expect(checker.check(context({ movementAbove: 10000, movementLookbackDays: 30 }, { walletMovementByWindow: byWindow }))).toBe(true);
    expect(checker.check(context({ movementAbove: 100000, movementLookbackDays: 30 }, { walletMovementByWindow: byWindow }))).toBe(false);
  });
});
