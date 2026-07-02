import { beforeEach, describe, expect, it } from 'vitest';
import { handleSelectPromo, type SelectPromoDeps } from './handle';
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

const fakeUserService = (over: Partial<UserService> = {}): UserService => ({
  getUserProfile: async (userId) => ({ userId, age: 30, region: 'ru' }),
  ...over,
});

const fakeBillingService = (over: Partial<BillingService> = {}): BillingService => ({
  getSubscription: async () => ({ level: 'plus' }),
  ...over,
});

const fakeImpressionStore = (over: Partial<ImpressionStore> = {}): ImpressionStore => ({
  getImpressions: async () => ({ counts: {}, lastShownAt: {} }),
  recordImpression: async () => {},
  ...over,
});

const fakeListingService = (over: Partial<ListingService> = {}): ListingService => ({
  getListingStats: async () => ({ activeListings: 0 }),
  ...over,
});

const deps = (over: Partial<SelectPromoDeps> = {}): SelectPromoDeps => ({
  configService: fakeConfigService(),
  userService: fakeUserService(),
  billingService: fakeBillingService(),
  impressionStore: fakeImpressionStore(),
  listingService: fakeListingService(),
  ...over,
});

describe('handleSelectPromo', () => {
  beforeEach(() => {
    __clearUserDataCache();
  });

  it('returns status "ok" with the promo data when a promo passes', async () => {
    const result = await handleSelectPromo({ userId: 'u1' }, deps());
    expect(result).toEqual({
      status: 'ok',
      data: { id: 'promo-1', format: 'inline', title: 'Test Promo' },
    });
  });

  it('returns status "skipped" with reason no_promo when nothing passes', async () => {
    const configService = fakeConfigService({
      getQueue: async () => ({ promos: [makePromo({ endsAt: '2000-01-01T00:00:00.000Z' })], persist: false }),
    });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({ configService }));
    expect(result).toEqual({ status: 'skipped', reason: 'no_promo' });
  });

  it('returns status "skipped" on an empty catalogue', async () => {
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [], persist: false }) });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({ configService }));
    expect(result).toEqual({ status: 'skipped', reason: 'no_promo' });
  });

  it('logs "queue resolved to zero promos" only when the queue was empty (≠ checkers filtered)', async () => {
    const infos: { obj: unknown; msg?: string }[] = [];
    const logger = {
      info: (obj: unknown, msg?: string) => infos.push({ obj, msg }),
      error: () => {},
    };

    const emptyQueue = fakeConfigService({ getQueue: async () => ({ promos: [], persist: false }) });
    await handleSelectPromo({ userId: 'u1', queue: 'home' }, deps({ configService: emptyQueue, logger }));
    expect(infos).toEqual([{ obj: { queue: 'home' }, msg: 'select-promo: queue resolved to zero promos' }]);

    infos.length = 0;
    const allFiltered = fakeConfigService({
      getQueue: async () => ({ promos: [makePromo({ endsAt: '2000-01-01T00:00:00.000Z' })], persist: false }),
    });
    const result = await handleSelectPromo({ userId: 'u1', queue: 'home' }, deps({ configService: allFiltered, logger }));
    expect(result).toEqual({ status: 'skipped', reason: 'no_promo' });
    expect(infos).toEqual([]);
  });

  it('returns status "error" when the config service is down', async () => {
    const configService = fakeConfigService({
      getQueue: async () => { throw new Error('bunker unreachable'); },
    });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({ configService }));
    expect(result).toEqual({ status: 'error', reason: 'config_service_unavailable' });
  });

  it('maps every Advertisement field from the selected promo', async () => {
    const ad = makePromo({
      id: 'full-1',
      format: 'popup',
      title: 'Full',
      description: 'Desc',
      imageUrl: 'https://example.com/x.png',
      action: { href: '/go', label: 'Go' },
      dismissible: true,
    });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [ad], persist: false }) });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({ configService }));
    expect(result).toEqual({
      status: 'ok',
      data: {
        id: 'full-1',
        format: 'popup',
        title: 'Full',
        description: 'Desc',
        imageUrl: 'https://example.com/x.png',
        action: { href: '/go', label: 'Go' },
        dismissible: true,
      },
    });
  });

  it('uses the named queue from params.queue', async () => {
    let capturedName: string | undefined;
    const configService = fakeConfigService({
      getQueue: async (name) => { capturedName = name; return { promos: [makePromo()], persist: false }; },
    });
    await handleSelectPromo({ userId: 'u1', queue: 'home' }, deps({ configService }));
    expect(capturedName).toBe('home');
  });

  it('defaults to queue "main" when params.queue is absent', async () => {
    let capturedName: string | undefined;
    const configService = fakeConfigService({
      getQueue: async (name) => { capturedName = name; return { promos: [makePromo()], persist: false }; },
    });
    await handleSelectPromo({ userId: 'u1' }, deps({ configService }));
    expect(capturedName).toBe('main');
  });

  it('persist queue auto-skips the frequency checkers (frequency never blocks)', async () => {
    // The promo would be blocked by both the cap (seen 5 >= 1) and the cooldown
    // (shown just now), but a persist queue skips limit+cooldown, so it still passes.
    const promo = makePromo({ id: 'p1', cooldownHours: 24, maxImpressionsPerUser: 1 });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: true }) });
    const impressionStore = fakeImpressionStore({
      getImpressions: async () => ({ counts: { p1: 5 }, lastShownAt: { p1: new Date().toISOString() } }),
    });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({ configService, impressionStore }));
    expect(result.status).toBe('ok');
  });

  it('params.user.authenticated gates an audience:authenticated promo', async () => {
    const promo = makePromo({ id: 'auth-only', audience: 'authenticated' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });

    const denied = await handleSelectPromo({ userId: 'u1', user: { authenticated: false } }, deps({ configService }));
    expect(denied.status).toBe('skipped');

    const allowed = await handleSelectPromo({ userId: 'u1', user: { authenticated: true } }, deps({ configService }));
    expect(allowed.status).toBe('ok');
  });

  it('last-shown timestamp from the store drives the cooldown checker', async () => {
    const promo = makePromo({ id: 'cd', cooldownHours: 24 });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });
    const now = () => new Date('2024-06-01T12:00:00.000Z');

    // distinct userIds so the per-user cache doesn't serve stale impression data
    const blocked = await handleSelectPromo({ userId: 'cd-blocked' }, deps({
      configService, now,
      impressionStore: fakeImpressionStore({ getImpressions: async () => ({ counts: {}, lastShownAt: { cd: '2024-06-01T11:00:00.000Z' } }) }),
    }));
    expect(blocked.status).toBe('skipped');

    const ok = await handleSelectPromo({ userId: 'cd-ok' }, deps({
      configService, now,
      impressionStore: fakeImpressionStore({ getImpressions: async () => ({ counts: {}, lastShownAt: { cd: '2024-05-30T12:00:00.000Z' } }) }),
    }));
    expect(ok.status).toBe('ok');
  });

  it('impression count from the store drives the optional limit checker', async () => {
    const promo = makePromo({ id: 'capped', maxImpressionsPerUser: 3 });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });

    // distinct userIds so the per-user cache doesn't serve stale impression data
    const ok = await handleSelectPromo({ userId: 'lim-ok' }, deps({
      configService,
      impressionStore: fakeImpressionStore({ getImpressions: async () => ({ counts: { capped: 2 }, lastShownAt: {} }) }),
    }));
    expect(ok.status).toBe('ok');

    const blocked = await handleSelectPromo({ userId: 'lim-blocked' }, deps({
      configService,
      impressionStore: fakeImpressionStore({ getImpressions: async () => ({ counts: { capped: 3 }, lastShownAt: {} }) }),
    }));
    expect(blocked.status).toBe('skipped');
  });

  it('a promo with no cap is unlimited regardless of count', async () => {
    const promo = makePromo({ id: 'free' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({
      configService,
      impressionStore: fakeImpressionStore({ getImpressions: async () => ({ counts: { free: 1000 }, lastShownAt: {} }) }),
    }));
    expect(result.status).toBe('ok');
  });

  it('returns error when the impression store is unavailable (cooldown active)', async () => {
    const promo = makePromo({ id: 'x', cooldownHours: 24 });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });
    const impressionStore = fakeImpressionStore({ getImpressions: async () => { throw new Error('supabase down'); } });
    const result = await handleSelectPromo({ userId: 'u1' }, deps({ configService, impressionStore }));
    expect(result).toEqual({ status: 'error', reason: 'impression_store_unavailable' });
  });

  it('user-service failure surfaces as impression_store_unavailable (bundled supplier load)', async () => {
    // For authenticated users, profile + subscription load alongside impressions,
    // so any of the three failing maps to the same umbrella reason.
    const userService = fakeUserService({ getUserProfile: async () => { throw new Error('blackbox down'); } });
    const result = await handleSelectPromo({ userId: 'u1', user: { authenticated: true } }, deps({ userService }));
    expect(result).toEqual({ status: 'error', reason: 'impression_store_unavailable' });
  });

  it('context gates a section-targeted promo', async () => {
    const promo = makePromo({ id: 'avto-only', sections: ['avto'] });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });
    const onAvto = await handleSelectPromo({ userId: 'ctx-1', context: { section: 'avto' } }, deps({ configService }));
    expect(onAvto.status).toBe('ok');
    const onRealty = await handleSelectPromo({ userId: 'ctx-2', context: { section: 'realty' } }, deps({ configService }));
    expect(onRealty.status).toBe('skipped');
    const noContext = await handleSelectPromo({ userId: 'ctx-3' }, deps({ configService }));
    expect(noContext.status).toBe('skipped');
  });

  it('params.formats narrows the queue to matching formats; omitted = head of queue', async () => {
    // One per-catalog queue serving two surfaces: topline banner first, popup after.
    const topline = makePromo({ id: 'top-1', format: 'topline' });
    const popup = makePromo({ id: 'pop-1', format: 'popup' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [topline, popup], persist: false }) });

    const overlay = await handleSelectPromo({ userId: 'fmt-1', formats: ['popup'] }, deps({ configService }));
    expect(overlay).toMatchObject({ status: 'ok', data: { id: 'pop-1', format: 'popup' } });

    const noFilter = await handleSelectPromo({ userId: 'fmt-2' }, deps({ configService }));
    expect(noFilter).toMatchObject({ status: 'ok', data: { id: 'top-1', format: 'topline' } });
  });

  it('params.excludeIds skips excluded promos before the checkers run', async () => {
    // Client-side session-seen list: [a, b] with a excluded → b is served even
    // though a passes every checker (exclusion happens BEFORE the checker walk).
    const a = makePromo({ id: 'a', title: 'A' });
    const b = makePromo({ id: 'b', title: 'B' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [a, b], persist: false }) });

    const result = await handleSelectPromo({ userId: 'ex-1', excludeIds: ['a'] }, deps({ configService }));
    expect(result).toMatchObject({ status: 'ok', data: { id: 'b' } });
  });

  it('params.excludeIds covering the whole queue yields skipped/no_promo', async () => {
    const a = makePromo({ id: 'a' });
    const b = makePromo({ id: 'b' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [a, b], persist: false }) });

    const result = await handleSelectPromo({ userId: 'ex-2', excludeIds: ['a', 'b'] }, deps({ configService }));
    expect(result).toEqual({ status: 'skipped', reason: 'no_promo' });
  });

  it('empty excludeIds is a no-op (head of queue wins)', async () => {
    const a = makePromo({ id: 'a' });
    const b = makePromo({ id: 'b' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [a, b], persist: false }) });

    const result = await handleSelectPromo({ userId: 'ex-3', excludeIds: [] }, deps({ configService }));
    expect(result).toMatchObject({ status: 'ok', data: { id: 'a' } });
  });

  it('seller gate: shows a seller promo only to users with active listings', async () => {
    const promo = makePromo({ id: 'seller-only', sellerStatus: 'seller' });
    const configService = fakeConfigService({ getQueue: async () => ({ promos: [promo], persist: false }) });
    const seller = await handleSelectPromo({ userId: 's1', user: { authenticated: true } }, deps({
      configService,
      listingService: fakeListingService({ getListingStats: async () => ({ activeListings: 3 }) }),
    }));
    expect(seller.status).toBe('ok');
    const buyer = await handleSelectPromo({ userId: 'b1', user: { authenticated: true } }, deps({
      configService,
      listingService: fakeListingService({ getListingStats: async () => ({ activeListings: 0 }) }),
    }));
    expect(buyer.status).toBe('skipped');
  });
});
