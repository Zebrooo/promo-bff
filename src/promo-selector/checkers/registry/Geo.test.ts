import { describe, expect, it } from 'vitest';
import { GeoChecker } from './Geo';
import { WEB_CHECKERS } from '../index';
import { makeCheckContext, makePromo } from '../../../test-utils';
import type { PromoTargeting } from '../../types';

const c = new GeoChecker();
const geoPromo = (t: PromoTargeting) => makePromo({ targeting: t });

describe('GeoChecker', () => {
  it('skips when the promo has no geo rules (back-compat)', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo() }))).toBe('no geo rules');
    expect(c.shouldSkip(makeCheckContext({ promo: geoPromo({ geoSegments: [], geoCities: [] }) }))).toBe('no geo rules');
  });

  it('runs when either rule is present', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: geoPromo({ geoSegments: ['local'] }) }))).toBe(false);
    expect(c.shouldSkip(makeCheckContext({ promo: geoPromo({ geoCities: ['gagra'] }) }))).toBe(false);
  });

  it('fails closed when a rule is present but the signal is absent (VPN/no mmdb)', () => {
    expect(c.check(makeCheckContext({ promo: geoPromo({ geoSegments: ['tourist'] }) }))).toBe(false);
    expect(c.check(makeCheckContext({ promo: geoPromo({ geoCities: ['sochi'] }) }))).toBe(false);
  });

  it('passes/fails by segment', () => {
    const p = geoPromo({ geoSegments: ['tourist'] });
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'tourist' }))).toBe(true);
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'local' }))).toBe(false);
  });

  it('passes/fails by city; unknown city with a city rule fails', () => {
    const p = geoPromo({ geoCities: ['gagra', 'sukhum'] });
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'local', geoCity: 'gagra' }))).toBe(true);
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'local', geoCity: 'sochi' }))).toBe(false);
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'local' }))).toBe(false); // city rule + city unknown
  });

  it('applies both rules together (AND)', () => {
    const p = geoPromo({ geoSegments: ['tourist'], geoCities: ['sochi'] });
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'tourist', geoCity: 'sochi' }))).toBe(true);
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'tourist', geoCity: 'moskva' }))).toBe(false);
    expect(c.check(makeCheckContext({ promo: p, geoSegment: 'local', geoCity: 'sochi' }))).toBe(false);
  });

  it('is registered in WEB_CHECKERS right after targeting (auto-allowlists "geo" in skipCheckers)', () => {
    const names = WEB_CHECKERS.map((x) => x.name);
    expect(names.indexOf('geo')).toBe(names.indexOf('targeting') + 1);
  });
});
