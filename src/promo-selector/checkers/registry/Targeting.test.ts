import { describe, expect, it } from 'vitest';
import { TargetingChecker } from './Targeting';
import { makeCheckContext, makePromo, makeSuppliers } from '../../../test-utils';

const c = new TargetingChecker();

describe('TargetingChecker', () => {
  it('skips when the promo has no targeting rules', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ targeting: {} }) }))).toBeTruthy();
  });
  it('passes a matching user', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { minAge: 18, regions: ['ru'] } }) });
    expect(c.check(ctx, makeSuppliers({ age: 30, region: 'ru' }))).toBe(true);
  });
  it('rejects an out-of-region user', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { regions: ['by'] } }) });
    expect(c.check(ctx, makeSuppliers({ region: 'ru' }))).toBe(false);
  });
  it('rejects an under-age user', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { minAge: 40 } }) });
    expect(c.check(ctx, makeSuppliers({ age: 30 }))).toBe(false);
  });
  it('rejects an over-age user (maxAge)', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { maxAge: 25 } }) });
    expect(c.check(ctx, makeSuppliers({ age: 30 }))).toBe(false);
  });
  it('rejects a user whose subscription level is not allowed', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { subscriptionLevels: ['premium'] } }) });
    expect(c.check(ctx, makeSuppliers({ subscriptionLevel: 'plus' }))).toBe(false);
  });
  it('rejects an age-gated promo when the user age is unknown', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { minAge: 18 } }) });
    expect(c.check(ctx, makeSuppliers({ age: undefined }))).toBe(false);
  });
  it('still matches a region-only promo when age is unknown', () => {
    const ctx = makeCheckContext({ promo: makePromo({ targeting: { regions: ['ru'] } }) });
    expect(c.check(ctx, makeSuppliers({ age: undefined, region: 'ru' }))).toBe(true);
  });
});
