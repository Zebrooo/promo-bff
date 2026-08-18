import { describe, expect, it } from 'vitest';
import { LifecycleChecker } from './Lifecycle';
import { makeCheckContext, makeListingStats, makePromo } from '../../../test-utils';
import type { PromoLifecycle } from '../../types';

const c = new LifecycleChecker();
const NOW = new Date('2026-08-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function ctx(lifecycle: PromoLifecycle) {
  return makeCheckContext({ promo: makePromo({ lifecycle }), now: NOW, isAuthorized: true });
}

describe('LifecycleChecker', () => {
  it('skips when the promo has no lifecycle gate (back-compat)', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBeTruthy();
    expect(c.shouldSkip(ctx({ soldWithinDays: 14 }))).toBe(false);
  });

  it('activeInCategories: passes on a non-empty intersection, fails without one', () => {
    const g = ctx({ activeInCategories: ['avto', 'moto'] });
    expect(c.check(g, makeListingStats(1, { activeCategories: ['avto'] }))).toBe(true);
    expect(c.check(g, makeListingStats(1, { activeCategories: ['mebel'] }))).toBe(false);
    expect(c.check(g, makeListingStats(0, { activeCategories: [] }))).toBe(false);
  });

  it('soldWithinDays: exactly N days ago passes, a moment earlier fails (boundary)', () => {
    const g = ctx({ soldWithinDays: 14 });
    expect(c.check(g, makeListingStats(0, { lastSoldAt: iso(14 * DAY) }))).toBe(true);
    expect(c.check(g, makeListingStats(0, { lastSoldAt: iso(14 * DAY + 1) }))).toBe(false);
  });

  it('soldWithinDays: fails closed without lastSoldAt (null or undefined = RPC not applied yet)', () => {
    const g = ctx({ soldWithinDays: 14 });
    expect(c.check(g, makeListingStats(0, { lastSoldAt: null }))).toBe(false);
    expect(c.check(g, makeListingStats(0))).toBe(false);
  });

  it('hasStalledActive: passes only on stats.hasStalledActive === true', () => {
    const g = ctx({ hasStalledActive: true });
    expect(c.check(g, makeListingStats(1, { hasStalledActive: true }))).toBe(true);
    expect(c.check(g, makeListingStats(1, { hasStalledActive: false }))).toBe(false);
    expect(c.check(g, makeListingStats(1))).toBe(false); // undefined → fail closed
  });

  it('firstListingWithinDays: exactly one fresh lifetime listing passes', () => {
    const g = ctx({ firstListingWithinDays: 7 });
    const fresh = { totalListings: 1, firstCreatedAt: iso(3 * DAY) };
    expect(c.check(g, makeListingStats(1, fresh))).toBe(true);
    expect(c.check(g, makeListingStats(1, { ...fresh, totalListings: 2 }))).toBe(false);
    expect(c.check(g, makeListingStats(1, { totalListings: 1, firstCreatedAt: iso(8 * DAY) }))).toBe(false);
    expect(c.check(g, makeListingStats(1, { totalListings: 1, firstCreatedAt: null }))).toBe(false);
  });

  it('combines conditions with AND: one mismatch fails the whole gate', () => {
    const g = ctx({ activeInCategories: ['avto'], soldWithinDays: 14 });
    const soldOnly = makeListingStats(0, { activeCategories: [], lastSoldAt: iso(DAY) });
    const activeOnly = makeListingStats(1, { activeCategories: ['avto'], lastSoldAt: null });
    const both = makeListingStats(1, { activeCategories: ['avto'], lastSoldAt: iso(DAY) });
    expect(c.check(g, soldOnly)).toBe(false);
    expect(c.check(g, activeOnly)).toBe(false);
    expect(c.check(g, both)).toBe(true);
  });

  it('an anonymous viewer never passes any gate, even with matching-looking stats', () => {
    const anonCtx = (lifecycle: PromoLifecycle) =>
      makeCheckContext({ promo: makePromo({ lifecycle }), now: NOW, isAuthorized: false });
    const anonStats = makeListingStats(0);
    expect(c.check(anonCtx({ activeInCategories: ['avto'] }), anonStats)).toBe(false);
    expect(c.check(anonCtx({ soldWithinDays: 90 }), anonStats)).toBe(false);
    expect(c.check(anonCtx({ hasStalledActive: true }), anonStats)).toBe(false);
    expect(c.check(anonCtx({ firstListingWithinDays: 30 }), anonStats)).toBe(false);
    // Даже «совпавшие» данные не пропускают гостя (явный isAuthorized-гейт).
    expect(c.check(anonCtx({ soldWithinDays: 14 }), makeListingStats(0, { lastSoldAt: iso(DAY) }))).toBe(false);
  });

  it('hand-written invalid gates fail closed, never pass-for-all', () => {
    const richStats = makeListingStats(1, {
      activeCategories: ['avto'],
      lastSoldAt: iso(DAY),
      hasStalledActive: true,
      totalListings: 1,
      firstCreatedAt: iso(DAY),
    });
    // Пустой гейт {} — вакуумное «всё выполнено» показало бы промо всем.
    expect(c.shouldSkip(ctx({}))).toBe(false);
    expect(c.check(ctx({}), richStats)).toBe(false);
    // Пустой список / пустые строки категорий.
    expect(c.check(ctx({ activeInCategories: [] }), richStats)).toBe(false);
    expect(c.check(ctx({ activeInCategories: ['avto', ' '] }), richStats)).toBe(false);
    // Нецелые/неположительные окна.
    expect(c.check(ctx({ soldWithinDays: 0 }), richStats)).toBe(false);
    expect(c.check(ctx({ firstListingWithinDays: -1 }), richStats)).toBe(false);
  });
});
