/** Test-only builders. Keep defaults "valid" so each test overrides just one field. */
import type { Promo } from './promo-selector/types';
import type { CheckContext, UserData, ListingStats } from './promo-selector/checkers/Checker';

export function makePromo(overrides: Partial<Promo> = {}): Promo {
  return {
    id: 'promo-1',
    name: 'Test Promo',
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2100-01-01T00:00:00.000Z',
    targeting: {},
    cooldownHours: 0,
    format: 'inline',
    title: 'Test Promo',
    ...overrides,
  };
}

export function makeCheckContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    promo: makePromo(),
    userId: 'user-1',
    isAuthorized: false,
    now: new Date('2024-06-01T12:00:00.000Z'),
    ...overrides,
  };
}

export function makeSuppliers(userData: Partial<UserData> = {}): { userData: UserData } {
  return {
    userData: {
      age: 30,
      region: 'ru',
      subscriptionLevel: 'plus',
      impressionCounts: {},
      lastShownAt: {},
      ...userData,
    },
  };
}

export function makeListingStats(activeListings = 0): { listingStats: ListingStats } {
  return { listingStats: { activeListings } };
}
