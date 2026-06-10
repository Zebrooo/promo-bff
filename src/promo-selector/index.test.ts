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
