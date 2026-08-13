import { describe, expect, it } from 'vitest';
import { BalanceChecker } from './Balance';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new BalanceChecker();

function context(
  balance: NonNullable<ReturnType<typeof makePromo>['targeting']['balance']>,
  overrides: { walletBalanceKopecks?: number; walletMovementKopecks?: number; isAuthorized?: boolean } = {},
) {
  return makeCheckContext({
    promo: makePromo({ targeting: { balance } }),
    isAuthorized: overrides.isAuthorized ?? true,
    walletBalanceKopecks: overrides.walletBalanceKopecks,
    walletMovementKopecks: overrides.walletMovementKopecks,
  });
}

describe('BalanceChecker', () => {
  it('skips when no rule is configured', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no balance targeting');
    expect(checker.shouldSkip(context({}))).toBe(false);
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

  it('enforces movementAbove/movementBelow against walletMovementKopecks independently of current balance', () => {
    expect(checker.check(context({ movementAbove: 50000 }, { walletMovementKopecks: 100000 }))).toBe(true);
    expect(checker.check(context({ movementAbove: 150000 }, { walletMovementKopecks: 100000 }))).toBe(false);
    expect(checker.check(context({ movementBelow: -10000 }, { walletMovementKopecks: -50000 }))).toBe(true);
  });

  it('combines current and movement conditions with AND', () => {
    const rule = { currentAbove: 10000, movementBelow: 0 };
    expect(checker.check(context(rule, { walletBalanceKopecks: 20000, walletMovementKopecks: -5000 }))).toBe(true);
    expect(checker.check(context(rule, { walletBalanceKopecks: 5000, walletMovementKopecks: -5000 }))).toBe(false);
    expect(checker.check(context(rule, { walletBalanceKopecks: 20000, walletMovementKopecks: 5000 }))).toBe(false);
  });
});
