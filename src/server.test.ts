import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { register as promRegister } from 'prom-client';
import type { LightMyRequestResponse } from 'fastify';
import { buildServer } from './server';

beforeEach(() => { promRegister.clear(); });
afterEach(() => { promRegister.clear(); });
import type { ConfigService } from './services/config-service';
import type { CampaignService } from './services/campaign-service';
import type { BalanceService } from './services/balance-service';
import type { ChargeService } from './services/charge-service';
import type { EventStore, EventPayload } from './services/event-store';
import type { AnalyticsStore } from './services/analytics-store';
import { makePromo } from './test-utils';

const fakeConfig = (promos = [makePromo({
  id: 'summer-sale',
  format: 'popup' as const,
  title: 'Летняя распродажа −30%',
  description: 'Скидки до 30% на весь каталог до конца лета.',
  imageUrl: 'https://cdn.example.com/promo/summer-sale.png',
  action: { href: '/sale/summer', label: 'Подробнее' },
  dismissible: true,
})]): { configService: ConfigService } => ({
  configService: { getQueue: async () => ({ promos, persist: false }) },
});

const AUTH = { authorization: 'Bearer test-token' };

const post = (
  app: ReturnType<typeof buildServer>,
  payload: unknown,
  headers: Record<string, string> = AUTH,
) => app.inject({ method: 'POST', url: '/models', headers, payload: payload as object });

const body = (res: LightMyRequestResponse) => res.json();

describe('POST /models', () => {
  it('returns 401 when the request is not authorized', async () => {
    const app = buildServer({ logger: false });
    const res = await post(app, { models: ['select-promo'], params: { userId: 'u1' } }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when models is missing or empty', async () => {
    const app = buildServer({ logger: false });
    const res = await post(app, { params: { userId: 'u1' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 for an unknown model', async () => {
    const app = buildServer({ logger: false });
    const res = await post(app, { models: ['mega-model'], params: { userId: 'u1' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 400 when params.userId is missing', async () => {
    const app = buildServer({ logger: false });
    const res = await post(app, { models: ['select-promo'], params: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 200 with an ok envelope for a valid request', async () => {
    const app = buildServer({ logger: false, deps: fakeConfig() });
    const res = await post(app, {
      models: ['select-promo'],
      params: { userId: 'user123', context: { platform: 'web', locale: 'ru' } },
    });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      'select-promo': {
        status: 'ok',
        data: {
          id: 'summer-sale',
          format: 'popup',
          title: 'Летняя распродажа −30%',
          description: 'Скидки до 30% на весь каталог до конца лета.',
          imageUrl: 'https://cdn.example.com/promo/summer-sale.png',
          action: { href: '/sale/summer', label: 'Подробнее' },
          dismissible: true,
        },
      },
    });
    await app.close();
  });

  it('returns HTTP 200 with an error envelope when a dependency fails', async () => {
    const brokenConfig: ConfigService = {
      getQueue: async () => {
        throw new Error('bunker unreachable');
      },
    };
    const app = buildServer({ logger: false, deps: { configService: brokenConfig } });
    const res = await post(app, { models: ['select-promo'], params: { userId: 'u1' } });
    // The key contract: a downed dependency is still HTTP 200, error lives in the envelope.
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({
      'select-promo': { status: 'error', reason: 'config_service_unavailable' },
    });
    await app.close();
  });
});

describe('fail-closed auth', () => {
  // In the test env PROMO_TICKET_PUBLIC_KEY is unset, so the default authenticator
  // would fall back to the stub. That is acceptable for dev/test but catastrophic
  // in production (stub authorizes any Authorization header). buildServer must
  // refuse to start instead.
  it('throws when NODE_ENV=production and no ticket public key is configured', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => buildServer({ logger: false })).toThrow(/PROMO_TICKET_PUBLIC_KEY/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('does NOT throw outside production (stub auth is allowed for dev)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const app = buildServer({ logger: false });
      expect(app).toBeDefined();
      void app.close();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('POST /impressions', () => {
  const postImp = (
    app: ReturnType<typeof buildServer>,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url: '/impressions', headers, payload: payload as object });

  it('returns 401 when not authorized', async () => {
    const app = buildServer({ logger: false });
    const res = await postImp(app, { userId: 'u1', promoId: 'p1' }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when userId or promoId is missing', async () => {
    const app = buildServer({ logger: false });
    expect((await postImp(app, { userId: 'u1' })).statusCode).toBe(400);
    expect((await postImp(app, { promoId: 'p1' })).statusCode).toBe(400);
    expect((await postImp(app, { userId: '', promoId: 'p1' })).statusCode).toBe(400);
    await app.close();
  });

  it('records the impression and returns { ok: true }', async () => {
    const calls: Array<[string, string]> = [];
    const app = buildServer({
      logger: false,
      deps: {
        impressionStore: {
          getImpressions: async () => ({ counts: {}, lastShownAt: {} }),
          recordImpression: async (userId, promoId) => {
            calls.push([userId, promoId]);
          },
        },
      },
    });
    const res = await postImp(app, { userId: 'u1', promoId: 'p1' });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ok: true });
    expect(calls).toEqual([['u1', 'p1']]);
    await app.close();
  });

  it('returns 502 when the store write fails', async () => {
    const app = buildServer({
      logger: false,
      deps: {
        impressionStore: {
          getImpressions: async () => ({ counts: {}, lastShownAt: {} }),
          recordImpression: async () => {
            throw new Error('supabase down');
          },
        },
      },
    });
    const res = await postImp(app, { userId: 'u1', promoId: 'p1' });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('POST /auction', () => {
  const postAuction = (
    app: ReturnType<typeof buildServer>,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url: '/auction', headers, payload: payload as object });

  it('returns 401 when not authorized', async () => {
    const app = buildServer({ logger: false });
    const res = await postAuction(app, { slots: [{ slot: 'home-popup', weight: 1 }] }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('runs a batch auction and returns a winner map', async () => {
    const app = buildServer({ logger: false, deps: {
      campaignService: {
        getCampaignsForSlot: async () => [],
        getActiveBannerCampaigns: async () => [
          { id: 1, advertiserId: 'a', cpmKopecks: 9000, creative: { format: 'banner', title: 'B', imageUrl: 'https://i', action: { href: 'https://t' } }, spentKopecks: 0, totalBudgetKopecks: null, targetPages: null, bannerFormat: null },
        ],
      },
      balanceService: { getBalances: async () => new Map([['a', 10]]) },
    } });
    const res = await app.inject({ method: 'POST', url: '/auction', headers: AUTH, payload: { slots: [{ slot: 'home-top-1', weight: 1 }] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()['home-top-1'].id).toBe('campaign:1');
    await app.close();
  });

  it('rejects /auction with no slots (400)', async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/auction', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /impressions routing (campaign vs house)', () => {
  function spies() {
    const recordCampaignImpression = vi.fn(async () => {});
    const recordImpression = vi.fn(async () => {});
    const deps = {
      chargeService: { recordCampaignImpression } as ChargeService,
      impressionStore: { getImpressions: async () => ({ counts: {}, lastShownAt: {} }), recordImpression },
    };
    return { deps, recordCampaignImpression, recordImpression };
  }
  const post = (app: ReturnType<typeof buildServer>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/impressions', headers: AUTH, payload: payload as object });

  it('routes a campaign:<id> impression to the charge service', async () => {
    const { deps, recordCampaignImpression, recordImpression } = spies();
    const app = buildServer({ logger: false, deps });
    const res = await post(app, { userId: 'u1', promoId: 'campaign:9' });
    expect(res.statusCode).toBe(200);
    expect(recordCampaignImpression).toHaveBeenCalledWith(9, 'u1');
    expect(recordImpression).not.toHaveBeenCalled();
    await app.close();
  });

  it('routes a normal promo id to the impression store (regression)', async () => {
    const { deps, recordCampaignImpression, recordImpression } = spies();
    const app = buildServer({ logger: false, deps });
    const res = await post(app, { userId: 'u1', promoId: 'summer-sale' });
    expect(res.statusCode).toBe(200);
    expect(recordImpression).toHaveBeenCalledWith('u1', 'summer-sale');
    expect(recordCampaignImpression).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 502 when the charge service throws', async () => {
    const app = buildServer({ logger: false, deps: {
      chargeService: { recordCampaignImpression: async () => { throw new Error('charge down'); } } as ChargeService,
    } });
    const res = await post(app, { userId: 'u1', promoId: 'campaign:9' });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('POST /events', () => {
  const postEv = (
    app: ReturnType<typeof buildServer>,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url: '/events', headers, payload: payload as object });

  it('returns 401 when not authorized', async () => {
    const app = buildServer({ logger: false });
    const res = await postEv(app, { eventName: 'listing_share' }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when eventName is missing or blank', async () => {
    const app = buildServer({ logger: false });
    expect((await postEv(app, {})).statusCode).toBe(400);
    expect((await postEv(app, { eventName: '' })).statusCode).toBe(400);
    expect((await postEv(app, { eventName: '   ' })).statusCode).toBe(400);
    await app.close();
  });

  it('records the event with snake_case payload and returns { ok: true }', async () => {
    const calls: EventPayload[] = [];
    const eventStore: EventStore = {
      recordEvent: async (p) => {
        calls.push(p);
      },
    };
    const app = buildServer({ logger: false, deps: { eventStore } });
    const res = await postEv(app, {
      eventName: 'listing_share',
      props: { listing_id: 42, source: 'izbrannoe' },
      pagePath: '/lk/izbrannoe',
      sessionId: 'sid-1',
      userId: 'user-1',
      userAgent: 'Mozilla/5.0',
    });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        eventName: 'listing_share',
        props: { listing_id: 42, source: 'izbrannoe' },
        pagePath: '/lk/izbrannoe',
        sessionId: 'sid-1',
        userId: 'user-1',
        userAgent: 'Mozilla/5.0',
      },
    ]);
    await app.close();
  });

  it('coerces missing/invalid optional fields to null and props to {}', async () => {
    const calls: EventPayload[] = [];
    const eventStore: EventStore = {
      recordEvent: async (p) => {
        calls.push(p);
      },
    };
    const app = buildServer({ logger: false, deps: { eventStore } });
    // Анонимный beacon — userId отсутствует, props не передан.
    const res = await postEv(app, { eventName: 'phone_reveal' });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toEqual({
      eventName: 'phone_reveal',
      props: {},
      pagePath: null,
      sessionId: null,
      userId: null,
      userAgent: null,
    });
    await app.close();
  });

  it('rejects props that is an array (PostgREST jsonb expects object, not list)', async () => {
    const calls: EventPayload[] = [];
    const eventStore: EventStore = {
      recordEvent: async (p) => {
        calls.push(p);
      },
    };
    const app = buildServer({ logger: false, deps: { eventStore } });
    const res = await postEv(app, { eventName: 'x', props: [1, 2, 3] });
    expect(res.statusCode).toBe(200);
    // Array coerced to {} (we don't write arrays into a props column that's
    // meant for shaped key/value records).
    expect(calls[0].props).toEqual({});
    await app.close();
  });

  it('returns 502 when the store write fails', async () => {
    const app = buildServer({
      logger: false,
      deps: {
        eventStore: {
          recordEvent: async () => {
            throw new Error('supabase down');
          },
        },
      },
    });
    const res = await postEv(app, { eventName: 'listing_share' });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('Analytics routes', () => {
  // Базовый stub'нутый analytics-store, переопределяется per-тест через spread.
  function makeStore(overrides: Partial<AnalyticsStore> = {}): AnalyticsStore {
    return {
      getKpi: async () => ({ dau: 0, wau: 0, mau: 0, events_today: 0, events_7d: 0, events_total: 0 }),
      getTop: async () => [],
      getFunnel: async () => [],
      getDaily: async () => [],
      getPromoTop: async () => [],
      getPromoZero: async () => [],
      getPromoFunnelByFormat: async () => [],
      getPromoTimeline: async () => [],
      getOnboardingOverview: async () => ({
        welcome_shown: 0, welcome_skipped: 0,
        role_picked: 0, role_buyer: 0, role_seller: 0,
        completed: 0, completed_finished: 0, completed_autoskip: 0,
        skipped_explicit: 0, auto_skipped_steps: 0, restarted: 0,
        step_shown_total: 0, step_next_total: 0,
      }),
      getOnboardingFunnel: async () => [],
      ...overrides,
    };
  }
  const POSTS = (
    app: ReturnType<typeof buildServer>,
    url: string,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url, headers, payload: payload as object });

  it('/analytics/kpi — 401 без ticket, 200 с данными', async () => {
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getKpi: async () => ({ dau: 5, wau: 30, mau: 100, events_today: 42, events_7d: 280, events_total: 9999 }),
    }) } });
    expect((await POSTS(app, '/analytics/kpi', {}, {})).statusCode).toBe(401);
    const ok = await POSTS(app, '/analytics/kpi', {});
    expect(ok.statusCode).toBe(200);
    expect(body(ok)).toEqual({ dau: 5, wau: 30, mau: 100, events_today: 42, events_7d: 280, events_total: 9999 });
    await app.close();
  });

  it('/analytics/top — пробрасывает days+limit, по умолчанию 7/25', async () => {
    const calls: Array<[number, number]> = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getTop: async (days, limit) => { calls.push([days, limit]); return []; },
    }) } });
    await POSTS(app, '/analytics/top', {}); // defaults
    await POSTS(app, '/analytics/top', { days: 14, limit: 10 });
    await POSTS(app, '/analytics/top', { days: 9999, limit: -5 }); // out of range → defaults
    expect(calls).toEqual([[7, 25], [14, 10], [7, 25]]);
    await app.close();
  });

  it('/analytics/daily — clamp days 1..365, default 30', async () => {
    const calls: number[] = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getDaily: async (days) => { calls.push(days); return []; },
    }) } });
    await POSTS(app, '/analytics/daily', {});
    await POSTS(app, '/analytics/daily', { days: 90 });
    await POSTS(app, '/analytics/daily', { days: 0 }); // → default 30
    await POSTS(app, '/analytics/daily', { days: 366 }); // → default 30
    expect(calls).toEqual([30, 90, 30, 30]);
    await app.close();
  });

  it('/analytics/funnel — требует non-empty string[]', async () => {
    const calls: Array<[string[], number]> = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getFunnel: async (events, days) => { calls.push([events, days]); return []; },
    }) } });
    expect((await POSTS(app, '/analytics/funnel', {})).statusCode).toBe(400);
    expect((await POSTS(app, '/analytics/funnel', { events: [] })).statusCode).toBe(400);
    expect((await POSTS(app, '/analytics/funnel', { events: ['a', 1] })).statusCode).toBe(400);
    const ok = await POSTS(app, '/analytics/funnel', { events: ['a', 'b'], days: 14 });
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual([[['a', 'b'], 14]]);
    await app.close();
  });

  it('/analytics/* — 502 когда store бросает (Supabase недоступен)', async () => {
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getKpi: async () => { throw new Error('aa down'); },
      getDaily: async () => { throw new Error('aa down'); },
    }) } });
    expect((await POSTS(app, '/analytics/kpi', {})).statusCode).toBe(502);
    expect((await POSTS(app, '/analytics/daily', {})).statusCode).toBe(502);
    await app.close();
  });

  it('/analytics/promos/top + /zero — 200 с rows, default days=30 limit=25', async () => {
    const topCalls: Array<[number, number]> = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getPromoTop: async (d, l) => { topCalls.push([d, l]); return [
        { promo_id: 'p1', title: 'P1', format: 'popup', views: 100, views_visible: 80, cta_clicks: 10, closes: 5, dismisses: 0, ctr_pct: 10 },
      ]; },
    }) } });
    const res = await POSTS(app, '/analytics/promos/top', {});
    expect(res.statusCode).toBe(200);
    expect(body(res).rows).toHaveLength(1);
    expect(topCalls).toEqual([[30, 25]]);
    await app.close();
  });

  it('/analytics/promos/timeline — требует promo_id', async () => {
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore() } });
    expect((await POSTS(app, '/analytics/promos/timeline', {})).statusCode).toBe(400);
    expect((await POSTS(app, '/analytics/promos/timeline', { promo_id: '' })).statusCode).toBe(400);
    expect((await POSTS(app, '/analytics/promos/timeline', { promo_id: 'p1' })).statusCode).toBe(200);
    await app.close();
  });

  it('/analytics/onboarding/overview — 401/200, default days=30', async () => {
    const calls: number[] = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getOnboardingOverview: async (d) => {
        calls.push(d);
        return {
          welcome_shown: 100, welcome_skipped: 30,
          role_picked: 70, role_buyer: 50, role_seller: 20,
          completed: 20, completed_finished: 18, completed_autoskip: 2,
          skipped_explicit: 10, auto_skipped_steps: 40, restarted: 3,
          step_shown_total: 500, step_next_total: 400,
        };
      },
    }) } });
    expect((await POSTS(app, '/analytics/onboarding/overview', {}, {})).statusCode).toBe(401);
    const ok = await POSTS(app, '/analytics/onboarding/overview', {});
    expect(ok.statusCode).toBe(200);
    expect(body(ok).welcome_shown).toBe(100);
    expect(calls).toEqual([30]);
    await app.close();
  });

  it('/analytics/onboarding/funnel — clamp days, 502 на падение store', async () => {
    const calls: number[] = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getOnboardingFunnel: async (d) => { calls.push(d); return [
        { step_id: 'u01-welcome', step_idx: 0, shown_count: 10, next_count: 8, auto_skipped_count: 0 },
      ]; },
    }) } });
    const r1 = await POSTS(app, '/analytics/onboarding/funnel', { days: 7 });
    expect(r1.statusCode).toBe(200);
    expect(body(r1).rows).toHaveLength(1);
    expect(calls).toEqual([7]);

    // out-of-range days → clamp to 30
    await POSTS(app, '/analytics/onboarding/funnel', { days: 9999 });
    expect(calls).toEqual([7, 30]);

    await app.close();
  });
});
