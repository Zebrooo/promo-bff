import { describe, expect, it } from 'vitest';
import { ChainChecker } from './Chain';
import { makeCheckContext, makePromo, makeSuppliers } from '../../../test-utils';

describe('ChainChecker', () => {
  const c = new ChainChecker();

  it('skips when no afterPromoId is configured', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ id: 'p' }) }))).toBeTruthy();
  });

  it('blocks when the predecessor has never been shown', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'b', afterPromoId: 'a' }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: {} }))).toBe(false);
  });

  it('passes once the predecessor has at least one impression', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'b', afterPromoId: 'a' }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { a: 1 } }))).toBe(true);
  });
});
