import { describe, expect, it } from 'vitest';
import { ContextChecker } from './Context';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new ContextChecker();

describe('ContextChecker', () => {
  it('skips when the promo has no section/category gate', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBeTruthy();
  });
  it('passes when the page section is in the allow-list', () => {
    const ctx = makeCheckContext({ promo: makePromo({ sections: ['avto', 'realty'] }), section: 'avto' });
    expect(c.check(ctx)).toBe(true);
  });
  it('fails when the page section is not in the allow-list', () => {
    const ctx = makeCheckContext({ promo: makePromo({ sections: ['avto'] }), section: 'realty' });
    expect(c.check(ctx)).toBe(false);
  });
  it('fails when the promo gates a section but the request has none', () => {
    const ctx = makeCheckContext({ promo: makePromo({ sections: ['avto'] }), section: undefined });
    expect(c.check(ctx)).toBe(false);
  });
  it('requires BOTH section and category when both are gated', () => {
    const promo = makePromo({ sections: ['avto'], categories: ['sedan'] });
    expect(c.check(makeCheckContext({ promo, section: 'avto', category: 'sedan' }))).toBe(true);
    expect(c.check(makeCheckContext({ promo, section: 'avto', category: 'suv' }))).toBe(false);
  });
});
