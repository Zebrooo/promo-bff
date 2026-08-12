import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSuppliers, __clearUserDataCache, USERDATA_TTL_MS, type SupplierDeps } from './suppliers';
import { Checker, type SupplierId } from './Checker';

class NeedsUserData extends Checker<'userData'> {
  readonly name = 'needs';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return ''; }
  check() { return true; }
}
class NeedsNothing extends Checker {
  readonly name = 'nothing';
  expect() { return ''; }
  check() { return true; }
}
class NeedsListingStats extends Checker<'listingStats'> {
  readonly name = 'needs-listings';
  readonly requiredSupplierIDs = ['listingStats'] as const;
  expect() { return ''; }
  check() { return true; }
}

function makeDeps(getImpressions = vi.fn(async () => ({ counts: {}, lastShownAt: {} }))): SupplierDeps {
  return {
    userService: { getUserProfile: vi.fn(async (id: string) => ({ userId: id, age: 30, region: 'ru' })) },
    billingService: { getSubscription: vi.fn(async () => ({ level: 'plus' as const })) },
    impressionStore: { getImpressions, recordImpression: vi.fn(async () => {}) },
    listingService: { getListingStats: vi.fn(async () => ({ activeListings: 0 })) },
  };
}

const ctx = { userId: 'u1', identityKind: 'account' as const };

beforeEach(() => {
  __clearUserDataCache();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('loadSuppliers', () => {
  it('loads userData when a checker requires it', async () => {
    const deps = makeDeps();
    const data = await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], ctx, deps);
    expect(data.userData).toEqual({
      age: 30, region: 'ru', subscriptionLevel: 'plus', impressionCounts: {}, lastShownAt: {},
    });
    expect(deps.impressionStore.getImpressions).toHaveBeenCalledTimes(1);
  });

  it('does not load userData when no active checker requires it', async () => {
    const deps = makeDeps();
    const data = await loadSuppliers([new NeedsNothing() as Checker<SupplierId>], ctx, deps);
    expect(data.userData).toBeUndefined();
    expect(deps.impressionStore.getImpressions).not.toHaveBeenCalled();
  });

  it('caches account metadata within the TTL but reads impressions fresh', async () => {
    const getImpressions = vi.fn(async () => ({ counts: {}, lastShownAt: {} }));
    const deps = makeDeps(getImpressions);
    await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], ctx, deps);
    vi.advanceTimersByTime(USERDATA_TTL_MS - 1);
    await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], ctx, deps);
    expect(deps.userService.getUserProfile).toHaveBeenCalledTimes(1);
    expect(deps.billingService.getSubscription).toHaveBeenCalledTimes(1);
    expect(getImpressions).toHaveBeenCalledTimes(2);
  });

  it('refetches account metadata after the TTL expires', async () => {
    const getImpressions = vi.fn(async () => ({ counts: {}, lastShownAt: {} }));
    const deps = makeDeps(getImpressions);
    await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], ctx, deps);
    vi.advanceTimersByTime(USERDATA_TTL_MS + 1);
    await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], ctx, deps);
    expect(deps.userService.getUserProfile).toHaveBeenCalledTimes(2);
    expect(deps.billingService.getSubscription).toHaveBeenCalledTimes(2);
    expect(getImpressions).toHaveBeenCalledTimes(2);
  });

  it('skips profile + billing for anonymous users (still loads impressions)', async () => {
    const deps = makeDeps();
    const data = await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], { userId: 'anon', identityKind: 'anonymous' }, deps);
    expect(deps.userService.getUserProfile).not.toHaveBeenCalled();
    expect(deps.billingService.getSubscription).not.toHaveBeenCalled();
    expect(deps.impressionStore.getImpressions).toHaveBeenCalledTimes(1);
    expect(data.userData).toEqual({ age: undefined, region: '', subscriptionLevel: 'none', impressionCounts: {}, lastShownAt: {} });
  });

  it('loads profile + billing for an account identity regardless of login state', async () => {
    const deps = makeDeps();
    await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], { userId: 'u1', identityKind: 'account' }, deps);
    expect(deps.userService.getUserProfile).toHaveBeenCalledTimes(1);
    expect(deps.billingService.getSubscription).toHaveBeenCalledTimes(1);
  });

  it('loads listingStats only when a checker requires it', async () => {
    const deps = makeDeps();
    const noLoad = await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], ctx, deps);
    expect(noLoad.listingStats).toBeUndefined();
    expect(deps.listingService.getListingStats).not.toHaveBeenCalled();

    const withLoad = await loadSuppliers([new NeedsListingStats() as Checker<SupplierId>], ctx, deps);
    expect(withLoad.listingStats).toEqual({ activeListings: 0 });
    expect(deps.listingService.getListingStats).toHaveBeenCalledTimes(1);
  });

  it('keeps anonymous and account datasource caches isolated by identity kind', async () => {
    const deps = makeDeps();
    await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], { userId: 'u1', identityKind: 'anonymous' }, deps);
    vi.advanceTimersByTime(1000);
    const data = await loadSuppliers([new NeedsUserData() as Checker<SupplierId>], { userId: 'u1', identityKind: 'account' }, deps);
    expect(deps.userService.getUserProfile).toHaveBeenCalledTimes(1);
    expect(data.userData).toMatchObject({ region: 'ru', subscriptionLevel: 'plus' });
  });

  it('does not query listings for anonymous users (buyer by default)', async () => {
    const deps = makeDeps();
    const data = await loadSuppliers([new NeedsListingStats() as Checker<SupplierId>], { userId: 'anon', identityKind: 'anonymous' }, deps);
    expect(data.listingStats).toEqual({ activeListings: 0 });
    expect(deps.listingService.getListingStats).not.toHaveBeenCalled();
  });
});
