import { describe, expect, it } from 'vitest';
import { DateChecker } from './Date';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new DateChecker();

describe('DateChecker', () => {
  it('passes inside the window', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2100-01-01T00:00:00.000Z' }),
      now: new Date('2024-06-01T12:00:00.000Z'),
    });
    expect(c.check(ctx)).toBe(true);
  });
  it('fails before the start', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: '2100-01-01T00:00:00.000Z', endsAt: '2200-01-01T00:00:00.000Z' }),
    });
    expect(c.check(ctx)).toBe(false);
  });
  it('fails after the end', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: '2000-01-01T00:00:00.000Z', endsAt: '2001-01-01T00:00:00.000Z' }),
    });
    expect(c.check(ctx)).toBe(false);
  });
  it('fails on an unparseable date range', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: 'not-a-date', endsAt: 'also-not-a-date' }),
    });
    expect(c.check(ctx)).toBe(false);
  });
});
