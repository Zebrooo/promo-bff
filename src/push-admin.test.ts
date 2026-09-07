import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register as promRegister } from 'prom-client';
import { buildServer } from './server';
import type { Authenticator } from './auth';
import {
  PushStoreError,
  type PushCampaign,
  type PushCampaignStore,
} from './services/push-campaign-store';

beforeEach(() => promRegister.clear());
afterEach(() => promRegister.clear());

const AUTH = { authorization: 'Bearer test-token' };
const ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const CABINET_AUTHENTICATOR: Authenticator = {
  authenticate: async (request) =>
    request.headers.authorization
      ? { authorized: true, clientId: 'promo-cabinet' }
      : { authorized: false },
};

function campaign(overrides: Partial<PushCampaign> = {}): PushCampaign {
  return {
    id: ID,
    revision: 1,
    dedupKey: 'parts-launch',
    title: 'Нужна запчасть?',
    body: 'Один запрос — несколько предложений',
    path: '/parts/request',
    audienceMode: 'marketing_opt_in',
    consentBasis: null,
    status: 'draft',
    scheduledAt: null,
    createdAt: '2026-09-07T10:00:00.000Z',
    preparedAt: null,
    startedAt: null,
    completedAt: null,
    eligibleUsers: 0,
    candidateTokens: 0,
    maxRecipients: null,
    exclusions: {},
    audienceDigest: null,
    payloadHash: HASH,
    accepted: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    cancelledCount: 0,
    createdBy: 'promo-cabinet',
    updatedAt: '2026-09-07T10:00:00.000Z',
    ...overrides,
  };
}

function makeStore(overrides: Partial<PushCampaignStore> = {}): PushCampaignStore {
  return {
    configured: true,
    listCampaigns: async () => [],
    getCampaign: async () => null,
    getWorkerStatus: async () => ({ enabled: true, healthy: true }),
    upsertDraft: async () => campaign(),
    prepareCampaign: async () => campaign({ status: 'prepared', revision: 2 }),
    queueCampaign: async () => campaign({ status: 'scheduled', revision: 3 }),
    cancelCampaign: async () => campaign({ status: 'cancelled', revision: 3 }),
    heartbeatWorker: async () => {},
    claimDueCampaign: async () => null,
    heartbeatCampaign: async () => true,
    recoverStaleRecipients: async () => 0,
    claimRecipients: async () => [],
    resolveRecipient: async () => ({ tokens: [], skipReason: 'not_claimed' }),
    validateToken: async () => ({ valid: false, skipReason: 'not_claimed', platform: null }),
    finishRecipient: async () => true,
    pruneUnregisteredToken: async () => true,
    finalizeCampaign: async () => campaign({ status: 'completed' }),
    failCampaign: async () => {},
    ...overrides,
  };
}

function appWith(store = makeStore()) {
  return buildServer({
    logger: false,
    authenticator: CABINET_AUTHENTICATOR,
    deps: { pushCampaignStores: { test: makeStore(), prod: store } },
  });
}

function post(
  app: ReturnType<typeof buildServer>,
  url: string,
  payload: unknown,
  auth: Record<string, string> = AUTH,
) {
  return app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
}

describe('POST /push-admin/campaigns/*', () => {
  it('requires service-ticket authentication', async () => {
    const app = appWith();
    const res = await post(app, '/push-admin/campaigns/list', { env: 'prod' }, {});
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a valid service ticket from a non-cabinet caller', async () => {
    const app = buildServer({
      logger: false,
      authenticator: {
        authenticate: async () => ({ authorized: true, clientId: 'abkhaz-auto' }),
      },
      deps: { pushCampaignStores: { test: makeStore(), prod: makeStore() } },
    });
    const res = await post(app, '/push-admin/campaigns/list', { env: 'prod' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden' });
    await app.close();
  });

  it('lists only campaign summaries and worker health', async () => {
    const listCampaigns = vi.fn(async () => [campaign()]);
    const store = makeStore({
      listCampaigns,
      getWorkerStatus: async () => ({
        enabled: true,
        healthy: true,
        lastHeartbeatAt: '2026-09-07T10:01:00.000Z',
      }),
    });
    const app = appWith(store);
    const res = await post(app, '/push-admin/campaigns/list', { env: 'prod', limit: 20 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      campaigns: [{ id: ID, dedupKey: 'parts-launch', revision: 1 }],
      worker: { enabled: true, healthy: true },
    });
    expect(JSON.stringify(res.json())).not.toContain('token');
    expect(listCampaigns).toHaveBeenCalledWith(20);
    await app.close();
  });

  it('defaults terminal history to 100 while the store retains all active campaigns', async () => {
    const listCampaigns = vi.fn(async () => []);
    const app = appWith(makeStore({ listCampaigns }));

    const res = await post(app, '/push-admin/campaigns/list', { env: 'prod' });

    expect(res.statusCode).toBe(200);
    expect(listCampaigns).toHaveBeenCalledWith(100);
    await app.close();
  });

  it('strictly rejects unknown input fields', async () => {
    const app = appWith();
    const res = await post(app, '/push-admin/campaigns/list', { env: 'prod', secret: 'x' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('requires a consent basis only for the offline-consent audience', async () => {
    const upsertDraft = vi.fn(async () => campaign());
    const app = appWith(makeStore({ upsertDraft }));
    const common = {
      env: 'prod',
      commandId: COMMAND_ID,
      dedupKey: 'parts-launch',
      title: 'T',
      body: 'B',
      path: '/parts',
      maxRecipients: 20000,
    };
    expect(
      (await post(app, '/push-admin/campaigns/upsert', { ...common, audienceMode: 'offline_consent' })).statusCode,
    ).toBe(400);
    expect(
      (
        await post(app, '/push-admin/campaigns/upsert', {
          ...common,
          audienceMode: 'marketing_opt_in',
          consentBasis: 'paper forms',
        })
      ).statusCode,
    ).toBe(400);
    const ok = await post(app, '/push-admin/campaigns/upsert', {
      ...common,
      audienceMode: 'offline_consent',
      consentBasis: 'Signed paper forms stored in the office',
    });
    expect(ok.statusCode).toBe(200);
    expect(upsertDraft).toHaveBeenCalledOnce();
    await app.close();
  });

  it('requires optimistic revision when editing a campaign', async () => {
    const app = appWith();
    const res = await post(app, '/push-admin/campaigns/upsert', {
      env: 'prod',
      commandId: COMMAND_ID,
      id: ID,
      dedupKey: 'parts-launch',
      title: 'T',
      body: 'B',
      path: '/parts',
      maxRecipients: 20000,
      audienceMode: 'marketing_opt_in',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('expectedRevision');
    await app.close();
  });

  it('passes revision, command id and authenticated actor into prepare', async () => {
    const prepareCampaign = vi.fn(async () => campaign({ status: 'prepared' }));
    const app = appWith(makeStore({ prepareCampaign }));
    const res = await post(app, '/push-admin/campaigns/prepare', {
      env: 'prod',
      id: ID,
      expectedRevision: 1,
      commandId: COMMAND_ID,
    });
    expect(res.statusCode).toBe(200);
    expect(prepareCampaign).toHaveBeenCalledWith(ID, 1, COMMAND_ID, 'promo-cabinet');
    await app.close();
  });

  it('queues durably with 202 only after exact count confirmation', async () => {
    const queueCampaign = vi.fn<PushCampaignStore['queueCampaign']>(
      async () => campaign({ status: 'scheduled' }),
    );
    const app = appWith(makeStore({ queueCampaign }));
    const payload = {
      env: 'prod',
      id: ID,
      expectedRevision: 2,
      commandId: COMMAND_ID,
      expectedEligibleUsers: 15646,
      expectedAudienceDigest: HASH.toUpperCase(),
      expectedPayloadHash: HASH,
      confirmation: '15646',
      maxRecipients: 16000,
    };
    const res = await post(app, '/push-admin/campaigns/queue', payload);
    expect(res.statusCode).toBe(202);
    expect(queueCampaign.mock.calls[0]?.[0]).toMatchObject({
      expectedAudienceDigest: HASH,
      maxRecipients: 16000,
    });

    const rejected = await post(app, '/push-admin/campaigns/queue', {
      ...payload,
      confirmation: '15645',
    });
    expect(rejected.statusCode).toBe(400);
    expect(queueCampaign).toHaveBeenCalledOnce();
    await app.close();
  });

  it('does not queue when the delivery worker is disabled or unhealthy', async () => {
    const queueCampaign = vi.fn<PushCampaignStore['queueCampaign']>(
      async () => campaign({ status: 'scheduled' }),
    );
    const getWorkerStatus = vi.fn(async () => ({ enabled: true, healthy: false }));
    const app = appWith(
      makeStore({
        getWorkerStatus,
        queueCampaign,
      }),
    );
    const res = await post(app, '/push-admin/campaigns/queue', {
      env: 'prod',
      id: ID,
      expectedRevision: 2,
      commandId: COMMAND_ID,
      expectedEligibleUsers: 100,
      expectedAudienceDigest: HASH,
      expectedPayloadHash: HASH,
      confirmation: '100',
      maxRecipients: 100,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'worker_unavailable' });
    expect(getWorkerStatus).toHaveBeenCalledWith(30_000);
    expect(queueCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps an audience safety-cap violation to 422', async () => {
    const app = appWith(
      makeStore({
        queueCampaign: async () => {
          throw new PushStoreError('audience_too_large', 'cap exceeded');
        },
      }),
    );
    const res = await post(app, '/push-admin/campaigns/queue', {
      env: 'prod',
      id: ID,
      expectedRevision: 2,
      commandId: COMMAND_ID,
      expectedEligibleUsers: 100,
      expectedAudienceDigest: HASH,
      expectedPayloadHash: HASH,
      confirmation: '100',
      maxRecipients: 50,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('returns 503 before touching an unconfigured environment', async () => {
    const disabled = makeStore({ configured: false });
    const app = buildServer({
      logger: false,
      authenticator: CABINET_AUTHENTICATOR,
      deps: { pushCampaignStores: { test: disabled, prod: makeStore() } },
    });
    const res = await post(app, '/push-admin/campaigns/list', { env: 'test' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
