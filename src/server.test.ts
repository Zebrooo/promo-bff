import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { register as promRegister } from 'prom-client';
import type { LightMyRequestResponse } from 'fastify';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { generateKeyPair, issueServiceTicket } from '@zebrooo/service-ticket';
import { buildServer } from './server';
import { createTicketAuthenticator } from './auth-ticket';
import { createIdentityProofVerifier } from './identity-proof';

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

const identityKeys = generateKeyPair();
const identityPrivateKey = createPrivateKey({
  key: Buffer.from(identityKeys.privateKey, 'base64'),
  format: 'der',
  type: 'pkcs8',
});

function issueIdentityProof(opts: {
  userId: string;
  src?: string;
  iat?: number;
  exp?: number;
}): string {
  const src = opts.src ?? 'abkhaz-auto';
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const exp = opts.exp ?? iat + 60;
  const canonical = ['promo-account-continuity', opts.userId, String(iat), String(exp), src, 'promo-bff'].join('\0');
  const signature = edSign(null, Buffer.from(canonical), identityPrivateKey).toString('base64url');
  return `pi1.${iat}.${exp}.${signature}`;
}

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

describe('POST /models account identity proof boundary', () => {
  const authenticator = createTicketAuthenticator({
    publicKey: identityKeys.publicKey,
    expectedDst: 'promo-bff',
    // `other-web` is intentionally authenticated too: proof verification must
    // still bind identity to the actual ticket src instead of trusting payload.
    allowedSrc: ['abkhaz-auto', 'other-web'],
  });
  const identityProofVerifier = createIdentityProofVerifier({
    publicKey: identityKeys.publicKey,
    expectedDst: 'promo-bff',
  });
  const headersFor = (src: string) => ({
    'x-service-ticket': issueServiceTicket({
      src,
      dst: 'promo-bff',
      privateKey: identityKeys.privateKey,
    }),
  });
  const requestFor = (userId: string, identityProof: string) => ({
    models: ['select-promo'],
    params: {
      userId,
      user: { id: userId, isAuthorized: false, identityKind: 'account', identityProof },
    },
  });
  const build = () => buildServer({
    logger: false,
    authenticator,
    identityProofVerifier,
    deps: fakeConfig(),
  });

  it('accepts a logged-out account with a proof bound to id + authenticated ticket src', async () => {
    const app = build();
    const userId = '11111111-1111-4111-8111-111111111111';
    const res = await post(app, requestFor(userId, issueIdentityProof({ userId })), headersFor('abkhaz-auto'));
    expect(res.statusCode).toBe(200);
    expect(body(res)['select-promo'].status).toBe('ok');
    await app.close();
  });

  it.each([
    ['different service-ticket src', (id: string) => ({ proof: issueIdentityProof({ userId: id }), src: 'other-web' })],
    ['different account subject', () => ({ proof: issueIdentityProof({ userId: 'other-account' }), src: 'abkhaz-auto' })],
    ['tampered proof', (id: string) => ({ proof: `${issueIdentityProof({ userId: id })}x`, src: 'abkhaz-auto' })],
    ['expired proof', (id: string) => {
      const now = Math.floor(Date.now() / 1000);
      return { proof: issueIdentityProof({ userId: id, iat: now - 120, exp: now - 60 }), src: 'abkhaz-auto' };
    }],
  ])('rejects %s', async (_label, makeInvalid) => {
    const app = build();
    const userId = '11111111-1111-4111-8111-111111111111';
    const invalid = makeInvalid(userId);
    const res = await post(app, requestFor(userId, invalid.proof), headersFor(invalid.src));
    expect(res.statusCode).toBe(400);
    expect(body(res).reason).toMatch(/identity proof is invalid/);
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

  it('applies a recorded impression to the immediately following /models cooldown check', async () => {
    let count = 0;
    let lastShownAt: string | undefined;
    const promo = makePromo({ id: 'cooldown-promo', cooldownHours: 24 });
    const app = buildServer({
      logger: false,
      deps: {
        ...fakeConfig([promo]),
        impressionStore: {
          getImpressions: async () => ({
            counts: count === 0 ? {} : { [promo.id]: count },
            lastShownAt: lastShownAt ? { [promo.id]: lastShownAt } : {},
          }),
          recordImpression: async () => {
            count += 1;
            lastShownAt = new Date().toISOString();
          },
        },
      },
    });
    const selectPayload = { models: ['select-promo'], params: { userId: 'cooldown-user' } };

    const first = await post(app, selectPayload);
    expect(first.statusCode).toBe(200);
    expect(body(first)['select-promo'].status).toBe('ok');

    const recorded = await postImp(app, { userId: 'cooldown-user', promoId: promo.id });
    expect(recorded.statusCode).toBe(200);

    // Regression: userData used to cache the empty impression snapshot for 60s,
    // so this tight follow-up selected the promo again until the cache expired.
    const immediate = await post(app, selectPayload);
    expect(immediate.statusCode).toBe(200);
    expect(body(immediate)['select-promo']).toEqual({ status: 'skipped', reason: 'no_promo' });
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

describe('POST /clicks', () => {
  const postClick = (
    app: ReturnType<typeof buildServer>,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url: '/clicks', headers, payload: payload as object });

  it('returns 401 when not authorized', async () => {
    const app = buildServer({ logger: false });
    expect((await postClick(app, { userId: 'u1', promoId: 'p1' }, {})).statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 on empty userId/promoId and on an unknown kind', async () => {
    const app = buildServer({ logger: false });
    expect((await postClick(app, { userId: 'u1' })).statusCode).toBe(400);
    expect((await postClick(app, { promoId: 'p1' })).statusCode).toBe(400);
    expect((await postClick(app, { userId: '', promoId: 'p1' })).statusCode).toBe(400);
    expect((await postClick(app, { userId: 'u1', promoId: 'p1', kind: 'hover' })).statusCode).toBe(400);
    await app.close();
  });

  it('records the click (default kind cta) and returns { ok: true }', async () => {
    const calls: Array<[string, string, string]> = [];
    const app = buildServer({
      logger: false,
      deps: {
        clickStore: {
          getClicks: async () => ({ counts: {} }),
          recordClick: async (userId, promoId, kind) => {
            calls.push([userId, promoId, kind]);
          },
        },
      },
    });
    const res = await postClick(app, { userId: 'u1', promoId: 'p1' });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ok: true });
    expect(calls).toEqual([['u1', 'p1', 'cta']]);
    await app.close();
  });

  it('accepts kind lead — заявка «Связаться» гасит промо тем же контуром', async () => {
    const calls: string[] = [];
    const app = buildServer({
      logger: false,
      deps: {
        clickStore: {
          getClicks: async () => ({ counts: {} }),
          recordClick: async (_u, _p, kind) => {
            calls.push(kind);
          },
        },
      },
    });
    expect((await postClick(app, { userId: 'u1', promoId: 'p1', kind: 'lead' })).statusCode).toBe(200);
    expect(calls).toEqual(['lead']);
    await app.close();
  });

  it('accepts kind conversion explicitly', async () => {
    const calls: string[] = [];
    const app = buildServer({
      logger: false,
      deps: {
        clickStore: {
          getClicks: async () => ({ counts: {} }),
          recordClick: async (_u, _p, kind) => {
            calls.push(kind);
          },
        },
      },
    });
    expect((await postClick(app, { userId: 'u1', promoId: 'p1', kind: 'conversion' })).statusCode).toBe(200);
    expect(calls).toEqual(['conversion']);
    await app.close();
  });

  it('skips campaign:* ids without touching the store', async () => {
    const recordClick = vi.fn(async () => {});
    const app = buildServer({
      logger: false,
      deps: { clickStore: { getClicks: async () => ({ counts: {} }), recordClick } },
    });
    const res = await postClick(app, { userId: 'u1', promoId: 'campaign:42' });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ok: true, skipped: 'campaign' });
    expect(recordClick).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 502 when the click store is unavailable', async () => {
    const app = buildServer({
      logger: false,
      deps: {
        clickStore: {
          getClicks: async () => ({ counts: {} }),
          recordClick: async () => {
            throw new Error('db down');
          },
        },
      },
    });
    const res = await postClick(app, { userId: 'u1', promoId: 'p1' });
    expect(res.statusCode).toBe(502);
    expect(body(res)).toEqual({ error: 'click_store_unavailable' });
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

  it('returns only the image variant selected for the requested slot dimensions', async () => {
    const app = buildServer({ logger: false, deps: {
      campaignService: {
        getCampaignsForSlot: async () => [],
        getActiveBannerCampaigns: async () => [
          {
            id: 1,
            advertiserId: 'a',
            cpmKopecks: 9000,
            creative: {
              format: 'banner',
              title: 'B',
              imageUrl: 'https://i/legacy.png',
              imageVariants: {
                wide: { imageUrl: 'https://i/wide.png', width: 1200, height: 150 },
                compact: { imageUrl: 'https://i/compact.png', width: 580, height: 120 },
              },
            },
            spentKopecks: 0,
            totalBudgetKopecks: null,
            targetPages: null,
            bannerFormat: 'horizontal',
          },
        ],
      },
      balanceService: { getBalances: async () => new Map([['a', 10]]) },
    } });
    const res = await postAuction(app, {
      slots: [{ slot: 'home-top-1', weight: 1, format: 'horizontal', width: 580, height: 120 }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()['home-top-1']).toMatchObject({
      id: 'campaign:1',
      imageUrl: 'https://i/compact.png',
    });
    expect(res.json()['home-top-1']).not.toHaveProperty('imageVariants');
    await app.close();
  });

  it('serializes one singleton image URL when only one co-display position wins', async () => {
    const app = buildServer({ logger: false, deps: {
      campaignService: {
        getCampaignsForSlot: async () => [],
        getActiveBannerCampaigns: async () => [
          {
            id: 1,
            advertiserId: 'a',
            cpmKopecks: 9000,
            creative: {
              format: 'banner',
              title: 'B',
              imageUrl: 'https://i/legacy.png',
              imageVariants: {
                wide: { imageUrl: 'https://i/wide.png', width: 1200, height: 150 },
                compact: { imageUrl: 'https://i/compact.png', width: 580, height: 120 },
              },
            },
            spentKopecks: 0,
            totalBudgetKopecks: null,
            targetPages: null,
            bannerFormat: 'horizontal',
          },
        ],
      },
      balanceService: { getBalances: async () => new Map([['a', 10]]) },
    } });
    const res = await postAuction(app, {
      slots: [
        {
          slot: 'home-top-left',
          weight: 1,
          format: 'horizontal',
          width: 580,
          height: 120,
          singletonWidth: 1200,
          singletonHeight: 150,
          coDisplayGroup: 'desktop-top',
        },
        {
          slot: 'home-top-right',
          weight: 2,
          format: 'horizontal',
          width: 580,
          height: 120,
          singletonWidth: 1200,
          singletonHeight: 150,
          coDisplayGroup: 'desktop-top',
        },
      ],
      exposure: 'mixed',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body['home-top-left']).toMatchObject({
      id: 'campaign:1',
      imageUrl: 'https://i/wide.png',
    });
    expect(body['home-top-left']).not.toHaveProperty('imageVariants');
    expect(Object.keys(body['home-top-left']).filter((key) => key.toLowerCase().includes('image'))).toEqual(['imageUrl']);
    expect(body['home-top-right']).toBeNull();
    await app.close();
  });

  it('rejects an auction slot with only one dimension', async () => {
    const app = buildServer({ logger: false });
    const res = await postAuction(app, { slots: [{ slot: 'home-top-1', weight: 1, width: 580 }] });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an auction slot with a partial singleton dimension pair', async () => {
    const app = buildServer({ logger: false });
    const res = await postAuction(app, {
      slots: [{
        slot: 'home-top-left',
        weight: 1,
        width: 580,
        height: 120,
        singletonWidth: 1200,
        coDisplayGroup: 'desktop-top',
      }],
      exposure: 'mixed',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects /auction with no slots (400)', async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: 'POST', url: '/auction', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /promo-list (onboarding tour)', () => {
  const postList = (
    app: ReturnType<typeof buildServer>,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url: '/promo-list', headers, payload: payload as object });

  it('returns 401 when not authorized', async () => {
    const app = buildServer({ logger: false });
    const res = await postList(app, { userId: 'u1' }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns the whole ordered tour as { status: "ok", steps }', async () => {
    const promos = [makePromo({ id: 'intro' }), makePromo({ id: 's1' }), makePromo({ id: 's2' })];
    const app = buildServer({ logger: false, deps: fakeConfig(promos) });
    const res = await postList(app, { userId: 'u1', queue: 'cabinet-onboarding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
    expect(res.json().steps.map((s: { id: string }) => s.id)).toEqual(['intro', 's1', 's2']);
    await app.close();
  });

  it('rejects a request without a userId (400)', async () => {
    const app = buildServer({ logger: false });
    const res = await postList(app, {});
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

describe('POST /impressions — idempotency (Bug 2)', () => {
  // The /impressions endpoint is called by the storefront after rendering an ad.
  // Without a dedup guard, a caller can replay the same request (or a network
  // retry after a 502) and bill the same campaign twice.
  //
  // Fix: an optional `impressionId` nonce in the body acts as a short-TTL in-process
  // dedup key (campaignId:userId:nonce). Same nonce → charge once; distinct nonce
  // → charge again (expected: different real impressions). Missing nonce is accepted
  // for backward-compat but logged as a residual-risk warning.
  //
  // RESIDUAL RISK: the dedup window is in-process and process-local (survives
  // process restarts). A distributed dedup (Supabase unique index on impression_id
  // inside record_campaign_impression) is the correct long-term fix. The nonce also
  // comes from the client and is not cryptographically signed, so a determined caller
  // can still vary the nonce to bill multiple times. The current fix reduces the
  // accidental-retry / thundering-herd case, not the adversarial case.

  function spies() {
    const recordCampaignImpression = vi.fn(async () => {});
    const deps = {
      chargeService: { recordCampaignImpression } as ChargeService,
      impressionStore: { getImpressions: async () => ({ counts: {}, lastShownAt: {} }), recordImpression: vi.fn(async () => {}) },
    };
    return { deps, recordCampaignImpression };
  }
  const postImp = (app: ReturnType<typeof buildServer>, payload: unknown) =>
    app.inject({ method: 'POST', url: '/impressions', headers: AUTH, payload: payload as object });

  it('same nonce → charge fires once even when the endpoint is called twice', async () => {
    const { deps, recordCampaignImpression } = spies();
    const app = buildServer({ logger: false, deps });
    const payload = { userId: 'u1', promoId: 'campaign:9', impressionId: 'nonce-abc' };
    const r1 = await postImp(app, payload);
    const r2 = await postImp(app, payload); // exact replay
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200); // caller gets 200 (idempotent, not an error)
    // The charge must fire exactly once.
    expect(recordCampaignImpression).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('different nonces → two distinct charges (real impressions)', async () => {
    const { deps, recordCampaignImpression } = spies();
    const app = buildServer({ logger: false, deps });
    await postImp(app, { userId: 'u1', promoId: 'campaign:9', impressionId: 'nonce-1' });
    await postImp(app, { userId: 'u1', promoId: 'campaign:9', impressionId: 'nonce-2' });
    expect(recordCampaignImpression).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('missing nonce is accepted (backward-compat) — charge fires', async () => {
    const { deps, recordCampaignImpression } = spies();
    const app = buildServer({ logger: false, deps });
    const res = await postImp(app, { userId: 'u1', promoId: 'campaign:9' }); // no impressionId
    expect(res.statusCode).toBe(200);
    expect(recordCampaignImpression).toHaveBeenCalledTimes(1);
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

describe('POST /referral-config/sync', () => {
  const postSync = (
    app: ReturnType<typeof buildServer>,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url: '/referral-config/sync', headers, payload: payload as object });

  const validPayload = {
    active: true,
    inviterCreditKopecks: 50000,
    sellerBonusKopecks: 20000,
    dailyInviteCap: 5,
    holdHours: 72,
    dailyBudgetKopecks: 100000,
  };

  it('returns 401 when not authorized', async () => {
    const app = buildServer({ logger: false });
    const res = await postSync(app, validPayload, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 on non-integer/negative fields', async () => {
    const app = buildServer({ logger: false });
    expect((await postSync(app, { ...validPayload, inviterCreditKopecks: -1 })).statusCode).toBe(400);
    expect((await postSync(app, { ...validPayload, sellerBonusKopecks: 1.5 })).statusCode).toBe(400);
    expect((await postSync(app, { ...validPayload, dailyInviteCap: 0 })).statusCode).toBe(400);
    expect((await postSync(app, { ...validPayload, holdHours: -1 })).statusCode).toBe(400);
    expect((await postSync(app, { ...validPayload, dailyBudgetKopecks: -1 })).statusCode).toBe(400);
    expect((await postSync(app, { ...validPayload, dailyBudgetKopecks: 1.5 })).statusCode).toBe(400);
    await app.close();
  });

  it('upserts the payload and returns { ok: true }', async () => {
    const calls: unknown[] = [];
    const referralConfigService = { sync: async (p: unknown) => { calls.push(p); } };
    const app = buildServer({ logger: false, deps: { referralConfigService } });
    const res = await postSync(app, validPayload);
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ ok: true });
    expect(calls).toEqual([validPayload]);
    await app.close();
  });

  it('returns 502 (best-effort failure) when the upsert throws', async () => {
    const referralConfigService = {
      sync: async () => { throw new Error('aa-supabase down'); },
    };
    const app = buildServer({ logger: false, deps: { referralConfigService } });
    const res = await postSync(app, validPayload);
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('Analytics routes', () => {
  // После чистки 2026-07-27 из десятка /analytics/* ручек остался один
  // таймлайн (см. комментарий в server.ts). Стаб — только он.
  function makeStore(overrides: Partial<AnalyticsStore> = {}): AnalyticsStore {
    return {
      getPromoTimeline: async () => [],
      ...overrides,
    };
  }
  const POSTS = (
    app: ReturnType<typeof buildServer>,
    url: string,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url, headers, payload: payload as object });

  it('/analytics/promos/timeline — 401 без ticket, 400 без promo_id, 200 с rows', async () => {
    const calls: Array<[string, number]> = [];
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getPromoTimeline: async (id, days) => { calls.push([id, days]); return [{ day: '2026-07-01', views: 5, views_visible: 4, cta_clicks: 1 }]; },
    }) } });
    expect((await POSTS(app, '/analytics/promos/timeline', { promo_id: 'p1' }, {})).statusCode).toBe(401);
    expect((await POSTS(app, '/analytics/promos/timeline', {})).statusCode).toBe(400);
    expect((await POSTS(app, '/analytics/promos/timeline', { promo_id: '' })).statusCode).toBe(400);
    const ok = await POSTS(app, '/analytics/promos/timeline', { promo_id: 'p1', days: 14 });
    expect(ok.statusCode).toBe(200);
    expect(body(ok).rows).toHaveLength(1);
    // days вне 1..365 схлопывается в default 30.
    await POSTS(app, '/analytics/promos/timeline', { promo_id: 'p1', days: 9999 });
    expect(calls).toEqual([['p1', 14], ['p1', 30]]);
    await app.close();
  });

  it('/analytics/promos/timeline — 502 когда store бросает (Supabase недоступен)', async () => {
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore({
      getPromoTimeline: async () => { throw new Error('down'); },
    }) } });
    expect((await POSTS(app, '/analytics/promos/timeline', { promo_id: 'p1' })).statusCode).toBe(502);
    await app.close();
  });

  it('мёртвые /analytics/* ручки сняты — 404 даже с валидным тикетом', async () => {
    // Регрессионный замок: агрегатные эндпоинты умерли вместе с дашбордами
    // кабинета (инициатива «Метрика — единственный источник»). Если кто-то
    // вернёт их «на всякий случай» — этот тест напомнит, что это осознанно
    // снятая поверхность с service-role-доступом к БД, а не забытая фича.
    const app = buildServer({ logger: false, deps: { analyticsStore: makeStore() } });
    for (const url of [
      '/analytics/kpi', '/analytics/top', '/analytics/daily', '/analytics/funnel',
      '/analytics/promos/top', '/analytics/promos/zero', '/analytics/promos/funnel-by-format',
      '/analytics/onboarding/overview', '/analytics/onboarding/funnel',
    ]) {
      expect((await POSTS(app, url, {})).statusCode, url).toBe(404);
    }
    await app.close();
  });
});

describe('POST /aa-admin/*', () => {
  const POSTS = (
    app: ReturnType<typeof buildServer>,
    url: string,
    payload: unknown,
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'POST', url, headers, payload: payload as object });

  function makeAdminStore(overrides: Partial<AaAdminStore> = {}): AaAdminStore {
    return {
      configured: true,
      getCanaryState: async () => null,
      setCanaryPct: async () => ({ ok: true }),
      listExperiments: async () => ({ experiments: [], variants: [] }),
      createExperiment: async () => ({ ok: true }),
      patchExperiment: async () => ({ ok: true }),
      bumpSalt: async () => ({ ok: true }),
      renameVariant: async () => ({ ok: true }),
      saveVariantWeights: async () => ({ ok: true }),
      ...overrides,
    };
  }

  it('401 без ticket на любую /aa-admin/* ручку', async () => {
    const app = buildServer({ logger: false, deps: { aaAdminStores: { test: makeAdminStore(), prod: makeAdminStore() } } });
    expect((await POSTS(app, '/aa-admin/canary/state', { env: 'prod' }, {})).statusCode).toBe(401);
    expect((await POSTS(app, '/aa-admin/experiments/list', { env: 'prod' }, {})).statusCode).toBe(401);
    await app.close();
  });

  it('400 когда env отсутствует или невалиден', async () => {
    const app = buildServer({ logger: false, deps: { aaAdminStores: { test: makeAdminStore(), prod: makeAdminStore() } } });
    expect((await POSTS(app, '/aa-admin/canary/state', {})).statusCode).toBe(400);
    expect((await POSTS(app, '/aa-admin/canary/state', { env: 'staging' })).statusCode).toBe(400);
    await app.close();
  });

  it('/aa-admin/canary/state возвращает строку из выбранного env-стора (test vs prod разделены)', async () => {
    const app = buildServer({
      logger: false,
      deps: {
        aaAdminStores: {
          test: makeAdminStore({ getCanaryState: async () => ({ colour: 'blue', pct: 10, updated_at: 't', updated_by: 'a' }) }),
          prod: makeAdminStore({ getCanaryState: async () => ({ colour: 'green', pct: 20, updated_at: 't2', updated_by: 'b' }) }),
        },
      },
    });
    const test = await POSTS(app, '/aa-admin/canary/state', { env: 'test' });
    const prod = await POSTS(app, '/aa-admin/canary/state', { env: 'prod' });
    expect(body(test)).toMatchObject({ colour: 'blue', pct: 10 });
    expect(body(prod)).toMatchObject({ colour: 'green', pct: 20 });
    await app.close();
  });

  it('/aa-admin/canary/pct — 400 на дробный/строковый/вне-диапазона pct', async () => {
    const app = buildServer({ logger: false, deps: { aaAdminStores: { test: makeAdminStore(), prod: makeAdminStore() } } });
    for (const pct of [1.5, '10', -1, 100, undefined]) {
      const res = await POSTS(app, '/aa-admin/canary/pct', { env: 'prod', pct });
      expect(res.statusCode, `pct=${JSON.stringify(pct)}`).toBe(400);
    }
    await app.close();
  });

  it('/aa-admin/canary/pct — принимает границы 0 и 99', async () => {
    const setCanaryPct = vi.fn(async () => ({ ok: true as const }));
    const app = buildServer({
      logger: false,
      deps: { aaAdminStores: { test: makeAdminStore(), prod: makeAdminStore({ setCanaryPct }) } },
    });
    expect((await POSTS(app, '/aa-admin/canary/pct', { env: 'prod', pct: 0 })).statusCode).toBe(200);
    expect((await POSTS(app, '/aa-admin/canary/pct', { env: 'prod', pct: 99 })).statusCode).toBe(200);
    expect(setCanaryPct).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('/aa-admin/canary/pct — 409 canary_not_active когда стор отказывает (colour null)', async () => {
    const app = buildServer({
      logger: false,
      deps: {
        aaAdminStores: {
          test: makeAdminStore(),
          prod: makeAdminStore({ setCanaryPct: async () => ({ ok: false, error: 'Канарейка не включена на сервере' }) }),
        },
      },
    });
    const res = await POSTS(app, '/aa-admin/canary/pct', { env: 'prod', pct: 10 });
    expect(res.statusCode).toBe(409);
    expect(body(res).error).toBe('canary_not_active');
    await app.close();
  });

  it('/aa-admin/canary/pct — actor = auth.clientId (источник тикета/аутентификатора)', async () => {
    const setCanaryPct = vi.fn(async () => ({ ok: true as const }));
    const app = buildServer({
      logger: false,
      deps: { aaAdminStores: { test: makeAdminStore(), prod: makeAdminStore({ setCanaryPct }) } },
    });
    await POSTS(app, '/aa-admin/canary/pct', { env: 'prod', pct: 10 });
    // Стаб-аутентификатор (дефолт в тестах) отдаёт clientId='stub-client';
    // на проде это будет `src` из сервис-тикета (напр. 'promo-cabinet').
    // Литерал 'promo-cabinet' в server.ts — fallback на случай authorized:true
    // без clientId, который в норме не должен случаться ни у одного из двух
    // аутентификаторов репо (оставлен как defense-in-depth, не тестируется
    // отдельно: заставить authenticate() вернуть {authorized:true} без
    // clientId можно только подсунув свой Authenticator в opts).
    expect(setCanaryPct).toHaveBeenCalledWith(10, 'stub-client');
    await app.close();
  });

  it('502 когда стор бросает (Supabase недоступен)', async () => {
    const app = buildServer({
      logger: false,
      deps: {
        aaAdminStores: {
          test: makeAdminStore(),
          prod: makeAdminStore({ listExperiments: async () => { throw new Error('down'); } }),
        },
      },
    });
    const res = await POSTS(app, '/aa-admin/experiments/list', { env: 'prod' });
    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('503 env_not_configured когда выбранный env-стор не сконфигурен (configured=false)', async () => {
    const app = buildServer({
      logger: false,
      deps: { aaAdminStores: { test: makeAdminStore({ configured: false }), prod: makeAdminStore() } },
    });
    const res = await POSTS(app, '/aa-admin/canary/state', { env: 'test' });
    expect(res.statusCode).toBe(503);
    expect(body(res)).toEqual({ error: 'env_not_configured', env: 'test' });
    await app.close();
  });

  it('дефолтная сборка (без deps override) реально читает config.aa*Supabase — в тестовом env оба пусты → 503', async () => {
    // Регрессионный замок на резолвер: без деп-инъекции buildServer строит
    // createAaAdminStore(config.aaSupabase/aaTestSupabase) сам — в CI/локально
    // эти env-переменные не заданы, так что оба окружения должны быть 503, а
    // не молча притворяться настроенными.
    const app = buildServer({ logger: false });
    expect((await POSTS(app, '/aa-admin/canary/state', { env: 'test' })).statusCode).toBe(503);
    expect((await POSTS(app, '/aa-admin/canary/state', { env: 'prod' })).statusCode).toBe(503);
    await app.close();
  });
});

import type { AaAdminStore } from './services/aa-admin-store';
import type { ErrorStore } from './services/error-store';

describe('POST /errors', () => {
  const okStore = (): ErrorStore => ({ recordError: async () => {} });

  it('returns 401 without an Authorization header', async () => {
    const app = buildServer({ logger: false, deps: { errorStore: okStore() } });
    const res = await app.inject({ method: 'POST', url: '/errors', payload: { service: 'abkhaz-auto', message: 'x' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 when service or message is missing', async () => {
    const app = buildServer({ logger: false, deps: { errorStore: okStore() } });
    const res = await app.inject({ method: 'POST', url: '/errors', headers: { authorization: 'Bearer t' }, payload: { message: 'x' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 200 and forwards to the error store', async () => {
    const recordError = vi.fn<(payload: import('./services/error-store').ErrorPayload) => Promise<void>>(async () => {});
    const app = buildServer({ logger: false, deps: { errorStore: { recordError } } });
    const res = await app.inject({
      method: 'POST', url: '/errors', headers: { authorization: 'Bearer t' },
      payload: { service: 'abkhaz-auto', source: 'browser', message: 'boom', errorType: 'TypeError' },
    });
    expect(res.statusCode).toBe(200);
    expect(recordError).toHaveBeenCalledOnce();
    expect(recordError.mock.calls[0][0]).toMatchObject({ service: 'abkhaz-auto', source: 'browser', message: 'boom' });
    await app.close();
  });

  it('returns 502 when the error store write fails', async () => {
    const app = buildServer({ logger: false, deps: { errorStore: { recordError: async () => { throw new Error('down'); } } } });
    const res = await app.inject({ method: 'POST', url: '/errors', headers: { authorization: 'Bearer t' }, payload: { service: 'abkhaz-auto', message: 'boom' } });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

describe('health probes', () => {
  it('GET /health is 200 and unauthenticated', async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('GET /ready is 200 when AA Supabase is unconfigured (dev)', async () => {
    const app = buildServer({ logger: false });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('GET /leads', () => {
  const leads = [
    {
      createdAt: '2026-08-19T10:00:00Z',
      promoId: 'divany',
      promoTitle: 'Диваны',
      page: '/mebel',
      name: 'Пётр',
      phone: '+79781234567',
    },
  ];
  const get = (
    app: ReturnType<typeof buildServer>,
    query = '',
    headers: Record<string, string> = AUTH,
  ) => app.inject({ method: 'GET', url: `/leads${query}`, headers });

  it('returns 401 when not authorized — телефоны наружу не отдаём', async () => {
    const app = buildServer({ logger: false });
    expect((await get(app, '', {})).statusCode).toBe(401);
    await app.close();
  });

  it('returns the leads with the parsed filters', async () => {
    const seen: unknown[] = [];
    const app = buildServer({
      logger: false,
      deps: { leadStore: { getLeads: async (q) => { seen.push(q); return leads; } } },
    });

    const res = await get(app, '?promoId=divany&from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z&limit=10');

    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ leads, total: 1 });
    expect(seen).toEqual([
      { promoId: 'divany', from: '2026-08-01T00:00:00Z', to: '2026-09-01T00:00:00Z', limit: 10 },
    ]);
    await app.close();
  });

  it('rejects a non-numeric / out-of-range limit and unparsable dates', async () => {
    const app = buildServer({ logger: false, deps: { leadStore: { getLeads: async () => leads } } });
    expect((await get(app, '?limit=all')).statusCode).toBe(400);
    expect((await get(app, '?limit=0')).statusCode).toBe(400);
    expect((await get(app, '?limit=999999')).statusCode).toBe(400);
    expect((await get(app, '?from=вчера')).statusCode).toBe(400);
    await app.close();
  });

  it('returns 502 when the store read fails', async () => {
    const app = buildServer({
      logger: false,
      deps: { leadStore: { getLeads: async () => { throw new Error('supabase down'); } } },
    });
    expect((await get(app)).statusCode).toBe(502);
    await app.close();
  });
});
