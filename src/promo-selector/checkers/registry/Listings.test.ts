import { describe, expect, it } from 'vitest';
import { ListingsChecker, hasListingsRule } from './Listings';
import { makeCheckContext, makePromo } from '../../../test-utils';
import type { ListingStats } from '../Checker';

const c = new ListingsChecker();

function stats(overrides: Partial<ListingStats> = {}): { listingStats: ListingStats } {
  return {
    listingStats: {
      activeListings: 0,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
      ...overrides,
    },
  };
}

describe('hasListingsRule', () => {
  it('false when targeting.listings is undefined', () => {
    expect(hasListingsRule(makePromo({}))).toBe(false);
  });
  it('false when targeting.listings is an empty object', () => {
    expect(hasListingsRule(makePromo({ targeting: { listings: {} } }))).toBe(false);
  });
  it('true when any field is set', () => {
    expect(hasListingsRule(makePromo({ targeting: { listings: { inactiveDays: 7 } } }))).toBe(true);
  });
});

describe('ListingsChecker', () => {
  it('skips when no listings targeting is set', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBeTruthy();
  });

  it('fails closed for an unauthorized viewer even with data present', () => {
    const ctx = makeCheckContext({
      isAuthorized: false,
      promo: makePromo({ targeting: { listings: { activeCategories: ['avto'] } } }),
    });
    expect(c.check(ctx, stats({ activeCategories: ['avto'] }))).toBe(false);
  });

  it('categories: passes when everCategories contains one of the required (any)', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { categories: ['avto', 'realty'] } } }),
    });
    expect(c.check(ctx, stats({ everCategories: ['realty'] }))).toBe(true);
    expect(c.check(ctx, stats({ everCategories: ['uslugi'] }))).toBe(false);
  });

  it('categories: categoriesMatch "all" requires every listed category', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { categories: ['avto', 'realty'], categoriesMatch: 'all' } } }),
    });
    expect(c.check(ctx, stats({ everCategories: ['avto', 'realty', 'uslugi'] }))).toBe(true);
    expect(c.check(ctx, stats({ everCategories: ['avto'] }))).toBe(false);
  });

  it('activeCategories: independent from categories (any by default)', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { activeCategories: ['avto'] } } }),
    });
    expect(c.check(ctx, stats({ activeCategories: ['avto'] }))).toBe(true);
    expect(c.check(ctx, stats({ everCategories: ['avto'], activeCategories: [] }))).toBe(false);
  });

  it('hasUnpromotedActive gate matches exactly', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { hasUnpromotedActive: true } } }),
    });
    expect(c.check(ctx, stats({ hasUnpromotedActive: true }))).toBe(true);
    expect(c.check(ctx, stats({ hasUnpromotedActive: false }))).toBe(false);
  });

  it('inactiveDays: passes when daysSinceLastListing is at least the threshold', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { inactiveDays: 30 } } }),
    });
    expect(c.check(ctx, stats({ daysSinceLastListing: 45 }))).toBe(true);
    expect(c.check(ctx, stats({ daysSinceLastListing: 10 }))).toBe(false);
  });

  it('inactiveDays: fails when the user has no listings at all (daysSinceLastListing undefined)', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { inactiveDays: 30 } } }),
    });
    expect(c.check(ctx, stats({ daysSinceLastListing: undefined }))).toBe(false);
  });

  it('combines multiple fields with AND', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { activeCategories: ['avto'], hasUnpromotedActive: true } } }),
    });
    expect(c.check(ctx, stats({ activeCategories: ['avto'], hasUnpromotedActive: true }))).toBe(true);
    expect(c.check(ctx, stats({ activeCategories: ['avto'], hasUnpromotedActive: false }))).toBe(false);
  });
});
