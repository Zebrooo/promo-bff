import { describe, expect, it, vi } from 'vitest';
import { selectPromo, WEB_CHECKERS } from './index';
import { __clearUserDataCache, type SupplierDeps } from './checkers/suppliers';
import { makePromo } from '../test-utils';

function makeDeps(over: Partial<{ counts: Record<string, number>; lastShownAt: Record<string, string> }> = {}): SupplierDeps {
  return {
    userService: { getUserProfile: async (id: string) => ({ userId: id, age: 30, region: 'ru' }) },
    billingService: { getSubscription: async () => ({ level: 'plus' as const }) },
    impressionStore: {
      getImpressions: async () => ({ counts: over.counts ?? {}, lastShownAt: over.lastShownAt ?? {} }),
      recordImpression: async () => {},
    },
    listingService: { getListingStats: async () => ({ activeListings: 0 }) },
  };
}

const ctx = { userId: 'u1', authenticated: false, now: new Date('2024-06-01T12:00:00.000Z') };

describe('selectPromo', () => {
  it('returns the first promo passing every checker, in queue order', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'a' }), makePromo({ id: 'b' })];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('a');
  });

  it('returns null when the queue is empty', async () => {
    expect(await selectPromo([], ctx, { deps: makeDeps() })).toBeNull();
  });

  it('rejects a promo blocked by the cooldown checker', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'p', cooldownHours: 24 })];
    const deps = makeDeps({ lastShownAt: { p: '2024-06-01T11:00:00.000Z' } });
    expect(await selectPromo(promos, ctx, { deps })).toBeNull();
  });

  it('skip removes a checker so a blocked promo passes', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'p', cooldownHours: 24 })];
    const deps = makeDeps({ lastShownAt: { p: '2024-06-01T11:00:00.000Z' } });
    const result = await selectPromo(promos, ctx, { deps, skip: ['cooldown'] });
    expect(result?.id).toBe('p');
  });

  it('skips a desktop-only promo at the queue head and falls through for a touch user', async () => {
    __clearUserDataCache();
    // Head promo is topline (desktop-only format); next is touch-capable inline.
    const promos = [makePromo({ id: 'top', format: 'topline' }), makePromo({ id: 'inl', format: 'inline' })];
    const result = await selectPromo(promos, { ...ctx, device: 'touch' }, { deps: makeDeps() });
    expect(result?.id).toBe('inl');
  });

  it('respects an explicit deviceTarget for a touch user', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'd', deviceTarget: 'desktop' }), makePromo({ id: 't', deviceTarget: 'touch' })];
    const result = await selectPromo(promos, { ...ctx, device: 'touch' }, { deps: makeDeps() });
    expect(result?.id).toBe('t');
  });

  it('does not filter by device when the request carries no device', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'top', format: 'topline', deviceTarget: 'desktop' })];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('top');
  });

  it('format filter picks the requested surface format from a mixed-format queue', async () => {
    __clearUserDataCache();
    // A per-catalog queue holding a topline banner then an overlay popup.
    const promos = [makePromo({ id: 'top', format: 'topline' }), makePromo({ id: 'pop', format: 'popup' })];
    // Overlay surface asks only for popup/fullscreen → skips the topline head.
    const overlay = await selectPromo(promos, { ...ctx, formats: ['popup', 'fullscreen'] }, { deps: makeDeps() });
    expect(overlay?.id).toBe('pop');
    // Topline surface asks only for topline → gets the banner.
    __clearUserDataCache();
    const topline = await selectPromo(promos, { ...ctx, formats: ['topline'] }, { deps: makeDeps() });
    expect(topline?.id).toBe('top');
  });

  it('no formats filter keeps queue order (back-compat)', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'top', format: 'topline' }), makePromo({ id: 'pop', format: 'popup' })];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('top');
  });

  it('does not load suppliers when only context-only checkers are active', async () => {
    __clearUserDataCache();
    const deps = makeDeps();
    const getImpressions = vi.spyOn(deps.impressionStore, 'getImpressions');
    // skip the three userData checkers → only date + audience remain
    await selectPromo([makePromo({ id: 'a' })], ctx, {
      deps,
      skip: ['targeting', 'limit', 'cooldown'],
    });
    expect(getImpressions).not.toHaveBeenCalled();
  });
});
