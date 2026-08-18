import { describe, expect, it } from 'vitest';
import { ReactionChecker } from './Reaction';
import { makeCheckContext, makePromo, makeSuppliers } from '../../../test-utils';

describe('ReactionChecker', () => {
  const c = new ReactionChecker();

  it('skips when suppressAfterClick is not set', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ id: 'p' }) }))).toBeTruthy();
  });

  it('skips when suppressAfterClick is explicitly false', () => {
    expect(
      c.shouldSkip(makeCheckContext({ promo: makePromo({ id: 'p', suppressAfterClick: false }) })),
    ).toBeTruthy();
  });

  it('passes while the user has not clicked this promo', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', suppressAfterClick: true }) });
    expect(c.check(ctx, makeSuppliers({ clickCounts: {} }))).toBe(true);
    expect(c.check(ctx, makeSuppliers({ clickCounts: { other: 5 } }))).toBe(true);
  });

  it('blocks once the user clicked this promo', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', suppressAfterClick: true }) });
    expect(c.check(ctx, makeSuppliers({ clickCounts: { p: 1 } }))).toBe(false);
  });

  it('blocks on a conversion-only reaction (store схлопнул kind-ы в counts)', () => {
    // click-store суммирует строки cta+conversion в один counts[promoId];
    // фикстура: только конверсия (одна строка kind='conversion', count=1).
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', suppressAfterClick: true }) });
    expect(c.check(ctx, makeSuppliers({ clickCounts: { p: 1 } }))).toBe(false);
  });
});
