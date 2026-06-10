import { describe, expect, it } from 'vitest';
import { AudienceChecker } from './Audience';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new AudienceChecker();

describe('AudienceChecker', () => {
  it('skips when audience is omitted or all', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBeTruthy();
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ audience: 'all' }) }))).toBeTruthy();
  });
  it('authenticated gate: passes only for logged-in users', () => {
    const promo = makePromo({ audience: 'authenticated' });
    expect(c.check(makeCheckContext({ promo, authenticated: true }))).toBe(true);
    expect(c.check(makeCheckContext({ promo, authenticated: false }))).toBe(false);
  });
  it('anonymous gate: passes only for guests', () => {
    const promo = makePromo({ audience: 'anonymous' });
    expect(c.check(makeCheckContext({ promo, authenticated: false }))).toBe(true);
    expect(c.check(makeCheckContext({ promo, authenticated: true }))).toBe(false);
  });
});
