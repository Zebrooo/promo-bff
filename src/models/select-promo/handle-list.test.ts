import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSelectPromoList } from './handle-list';
import type { SelectPromoDeps } from './handle';
import type { ConfigService } from '../../services/config-service';
import type { UserService } from '../../services/user-service';
import type { BillingService } from '../../services/billing-service';
import type { ImpressionStore } from '../../services/impression-store';
import type { ListingService } from '../../services/listing-service';
import { makePromo } from '../../test-utils';
import { __clearUserDataCache } from '../../promo-selector/checkers/suppliers';

const fakeConfigService = (over: Partial<ConfigService> = {}): ConfigService => ({
  getQueue: async () => ({ promos: [makePromo()], persist: false }),
  ...over,
});
const deps = (over: Partial<SelectPromoDeps> = {}): SelectPromoDeps => ({
  configService: fakeConfigService(),
  userService: { getUserProfile: async (userId) => ({ userId, age: 30, region: 'ru' }) } as UserService,
  billingService: { getSubscription: async () => ({ level: 'plus' }) } as BillingService,
  impressionStore: { getImpressions: async () => ({ counts: {}, lastShownAt: {} }), recordImpression: async () => {} } as ImpressionStore,
  listingService: { getListingStats: async () => ({ activeListings: 0 }) } as ListingService,
  searchHistoryService: { getSearchHistory: async () => [] },
  ...over,
});

describe('handleSelectPromoList', () => {
  beforeEach(() => {
    __clearUserDataCache();
  });

  it('returns status "ok" with the WHOLE ordered list of passing steps (stripped to Advertisement)', async () => {
    const configService = fakeConfigService({
      getQueue: async () => ({
        promos: [makePromo({ id: 'intro' }), makePromo({ id: 's1' }), makePromo({ id: 's2' })],
        persist: false,
      }),
    });
    const result = await handleSelectPromoList({ userId: 'u1' }, deps({ configService }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.steps.map((s) => s.id)).toEqual(['intro', 's1', 's2']);
    // stripped: no server-only selection fields on a step
    expect(result.steps[0]).not.toHaveProperty('startsAt');
    expect(result.steps[0]).not.toHaveProperty('maxImpressionsPerUser');
  });

  it('DROPS the chain checker: a chained step with no predecessor impression is still included', async () => {
    const configService = fakeConfigService({
      getQueue: async () => ({
        promos: [makePromo({ id: 'intro' }), makePromo({ id: 's1', afterPromoId: 'intro' })],
        persist: false,
      }),
    });
    // impressions are empty → the chain checker WOULD block s1 (no 'intro' impression);
    // the list handler drops chain, so s1 is included and order comes from the queue.
    const result = await handleSelectPromoList({ userId: 'u1' }, deps({ configService }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.steps.map((s) => s.id)).toEqual(['intro', 's1']);
  });

  it('still applies non-chain checkers: an expired step is filtered out', async () => {
    const configService = fakeConfigService({
      getQueue: async () => ({
        promos: [makePromo({ id: 'ok' }), makePromo({ id: 'expired', endsAt: '2000-01-01T00:00:00.000Z' })],
        persist: false,
      }),
    });
    const result = await handleSelectPromoList({ userId: 'u1' }, deps({ configService }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.steps.map((s) => s.id)).toEqual(['ok']);
  });

  it('propagates logged-out account identity to account-backed suppliers', async () => {
    const profile = vi.fn(async (userId: string) => ({ userId, age: 30, region: 'ru' }));
    const subscription = vi.fn(async () => ({ level: 'plus' as const }));
    const listings = vi.fn(async () => ({ activeListings: 1 }));
    const configService = fakeConfigService({
      getQueue: async () => ({ promos: [makePromo({ sellerStatus: 'seller' })], persist: false }),
    });
    const result = await handleSelectPromoList({
      userId: 'account-list',
      user: { isAuthorized: false, identityKind: 'account' },
    }, deps({
      configService,
      userService: { getUserProfile: profile },
      billingService: { getSubscription: subscription },
      listingService: { getListingStats: listings },
    }));
    expect(result.status).toBe('ok');
    expect(profile).toHaveBeenCalledWith('account-list');
    expect(subscription).toHaveBeenCalledTimes(1);
    expect(listings).toHaveBeenCalledWith('account-list');
  });

  it('returns status "skipped" no_promo on an empty queue', async () => {
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [], persist: false }) });
    const result = await handleSelectPromoList({ userId: 'u1' }, deps({ configService }));
    expect(result).toEqual({ status: 'skipped', reason: 'no_promo' });
  });

  it('returns status "error" config_service_unavailable when the queue load throws', async () => {
    const configService = fakeConfigService({ getQueue: async () => { throw new Error('s3 down'); } });
    const result = await handleSelectPromoList({ userId: 'u1' }, deps({ configService }));
    expect(result).toEqual({ status: 'error', reason: 'config_service_unavailable' });
  });

  it('loads search history once for the whole list and filters targeted steps', async () => {
    let loads = 0;
    const configService = fakeConfigService({
      getQueue: async () => ({
        promos: [
          makePromo({ id: 'toyota', targeting: { search: { terms: ['toyota'] } } }),
          makePromo({ id: 'honda', targeting: { search: { terms: ['honda'] } } }),
          makePromo({ id: 'generic' }),
        ],
        persist: false,
      }),
    });
    const result = await handleSelectPromoList(
      { userId: 'u-search', viewerKey: 'viewer-search' },
      deps({
        configService,
        now: () => new Date('2026-08-12T12:00:00.000Z'),
        searchHistoryService: {
          getSearchHistory: async () => {
            loads += 1;
            return [{ query: 'Toyota Camry', section: 'avto', createdAt: '2026-08-11T12:00:00.000Z' }];
          },
        },
      }),
    );
    expect(loads).toBe(1);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.steps.map((step) => step.id)).toEqual(['toyota', 'generic']);
  });

  it('keeps generic list steps when search history loading fails', async () => {
    let loads = 0;
    const configService = fakeConfigService({
      getQueue: async () => ({
        promos: [
          makePromo({ id: 'targeted', targeting: { search: { sections: ['avto'] } } }),
          makePromo({ id: 'generic' }),
        ],
        persist: false,
      }),
    });
    const result = await handleSelectPromoList(
      { userId: 'u-search', viewerKey: 'viewer-search' },
      deps({
        configService,
        searchHistoryService: {
          getSearchHistory: async () => {
            loads += 1;
            throw new Error('database unavailable');
          },
        },
      }),
    );
    expect(loads).toBe(1);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.steps.map((step) => step.id)).toEqual(['generic']);
  });
});
