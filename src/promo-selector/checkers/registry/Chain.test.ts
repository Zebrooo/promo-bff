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

  it('back-compat: only afterPromoId ignores clicks entirely', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'b', afterPromoId: 'a' }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { a: 1 }, clickCounts: {} }))).toBe(true);
  });

  it('afterClickPromoId alone: blocks without a click, passes with one', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'b', afterClickPromoId: 'a' }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { a: 9 }, clickCounts: {} }))).toBe(false);
    expect(c.check(ctx, makeSuppliers({ clickCounts: { a: 1 } }))).toBe(true);
  });

  it('does not skip when only afterClickPromoId is configured', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ id: 'b', afterClickPromoId: 'a' }) }))).toBe(false);
  });

  it('both fields = AND: seen but not clicked → blocked', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'b', afterPromoId: 'a', afterClickPromoId: 'a' }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { a: 1 }, clickCounts: {} }))).toBe(false);
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { a: 1 }, clickCounts: { a: 1 } }))).toBe(true);
  });
});
