import { describe, expect, it } from 'vitest';
import { SourceChecker } from './Source';
import { WEB_CHECKERS } from '../index';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new SourceChecker();
const promo = makePromo({ entrySources: ['telegram', 'search'] });

describe('SourceChecker', () => {
  it('skips when entrySources is absent or empty', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBe('no entry-source rule');
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ entrySources: [] }) }))).toBe('no entry-source rule');
    expect(c.shouldSkip(makeCheckContext({ promo }))).toBe(false);
  });

  it('passes when the session source is in the list', () => {
    expect(c.check(makeCheckContext({ promo, visit: { source: 'telegram' } }))).toBe(true);
    expect(c.check(makeCheckContext({ promo, visit: { source: 'search' } }))).toBe(true);
  });

  it('fails on a mismatching source', () => {
    expect(c.check(makeCheckContext({ promo, visit: { source: 'direct' } }))).toBe(false);
    expect(c.check(makeCheckContext({ promo, visit: { source: 'other' } }))).toBe(false);
  });

  it('fails closed when visit or visit.source is missing', () => {
    expect(c.check(makeCheckContext({ promo }))).toBe(false);
    expect(c.check(makeCheckContext({ promo, visit: { visitDays: 9 } }))).toBe(false);
  });

  it("is registered right after 'visitor', which follows 'audience' (auto-allowlists both in skipCheckers)", () => {
    const names = WEB_CHECKERS.map((x) => x.name);
    expect(names.indexOf('visitor')).toBe(names.indexOf('audience') + 1);
    expect(names.indexOf('source')).toBe(names.indexOf('visitor') + 1);
  });
});
