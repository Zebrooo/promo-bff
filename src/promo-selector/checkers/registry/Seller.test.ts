import { describe, expect, it } from 'vitest';
import { SellerChecker } from './Seller';
import { makeCheckContext, makePromo, makeListingStats } from '../../../test-utils';

const c = new SellerChecker();

describe('SellerChecker', () => {
  it('skips when no sellerStatus is set', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBeTruthy();
  });
  it('seller gate: passes with active listings, fails without', () => {
    const ctx = makeCheckContext({ promo: makePromo({ sellerStatus: 'seller' }) });
    expect(c.check(ctx, makeListingStats(2))).toBe(true);
    expect(c.check(ctx, makeListingStats(0))).toBe(false);
  });
  it('buyer gate: passes without active listings, fails with', () => {
    const ctx = makeCheckContext({ promo: makePromo({ sellerStatus: 'buyer' }) });
    expect(c.check(ctx, makeListingStats(0))).toBe(true);
    expect(c.check(ctx, makeListingStats(5))).toBe(false);
  });
});
