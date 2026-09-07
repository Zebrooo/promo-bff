import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPushCampaignStore, PushStoreError } from './push-campaign-store';

const cfg = { url: 'https://aa.example.com', serviceRoleKey: 'service-role', timeoutMs: 1000 };
const ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    revision: 2,
    dedup_key: 'parts-launch',
    title: 'Нужна запчасть?',
    body: 'Спросите сразу у магазинов',
    path: '/parts',
    audience_mode: 'marketing_opt_in',
    consent_basis: null,
    status: 'prepared',
    scheduled_at: null,
    created_at: '2026-09-07T10:00:00.000Z',
    audience_prepared_at: '2026-09-07T10:01:00.000Z',
    started_at: null,
    completed_at: null,
    audience_count: '15646',
    audience_candidate_tokens: '15800',
    max_recipients: 16000,
    audience_exclusions: { explicit_opt_out: 570, 'unsafe key': 1 },
    audience_digest: HASH,
    payload_hash: HASH,
    accepted_count: 0,
    skipped_count: 0,
    failed_count: 0,
    unknown_count: 0,
    cancelled_count: 7,
    created_by: 'promo-cabinet',
    updated_at: '2026-09-07T10:01:00.000Z',
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('push campaign PostgREST store', () => {
  it('maps service-only rows to the safe cabinet campaign shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify([row({ data: { internal: 'never expose' }, lease_owner: 'worker-1' })]),
          { status: 200 },
        ),
    );
    const store = createPushCampaignStore(cfg);
    const campaigns = await store.listCampaigns(20);
    expect(campaigns).toEqual([
      expect.objectContaining({
        id: ID,
        revision: 2,
        eligibleUsers: 15646,
        candidateTokens: 15800,
        maxRecipients: 16000,
        exclusions: { explicitOptOut: 570 },
        cancelledCount: 7,
      }),
    ]);
    expect(campaigns[0]).not.toHaveProperty('data');
    expect(campaigns[0]).not.toHaveProperty('lease_owner');
  });

  it('keeps an old scheduled campaign alongside the bounded recent terminal history', async () => {
    const scheduledId = '11111111-1111-4111-8111-999999999999';
    const scheduled = row({
      id: scheduledId,
      status: 'scheduled',
      created_at: '2025-01-01T00:00:00.000Z',
    });
    const terminalRows = Array.from({ length: 130 }, (_, index) =>
      row({
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        status: 'completed',
        created_at: new Date(Date.UTC(2026, 8, 7, 0, index)).toISOString(),
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const statuses = url.searchParams.get('status') ?? '';
      if (statuses.includes('scheduled')) {
        return new Response(JSON.stringify([scheduled]), { status: 200 });
      }
      expect(statuses).toContain('completed');
      expect(url.searchParams.get('limit')).toBe('100');
      return new Response(JSON.stringify(terminalRows.slice(0, 100)), { status: 200 });
    });

    const store = createPushCampaignStore(cfg);
    const campaigns = await store.listCampaigns(100);

    expect(campaigns).toHaveLength(101);
    expect(campaigns.some((campaign) => campaign.id === scheduledId)).toBe(true);
    expect(campaigns.filter((campaign) => campaign.status === 'completed')).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('paginates nonterminal campaigns explicitly instead of relying on PostgREST defaults', async () => {
    const scheduledId = '11111111-1111-4111-8111-999999999998';
    const activeRows = Array.from({ length: 501 }, (_, index) =>
      row({
        id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
        status: index === 500 ? 'scheduled' : 'draft',
        created_at: new Date(Date.UTC(2026, 8, 7, 0, index)).toISOString(),
        ...(index === 500 ? { id: scheduledId, created_at: '2025-01-01T00:00:00.000Z' } : {}),
      }),
    );
    const activeRequests: Array<{ limit: number; before: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const statuses = url.searchParams.get('status') ?? '';
      const limit = Number(url.searchParams.get('limit'));
      if (statuses.includes('scheduled')) {
        const before = url.searchParams.get('or');
        activeRequests.push({ limit, before });
        const start = before ? 500 : 0;
        return new Response(JSON.stringify(activeRows.slice(start, start + limit)), {
          status: 200,
        });
      }
      return new Response('[]', { status: 200 });
    });

    const campaigns = await createPushCampaignStore(cfg).listCampaigns(100);

    expect(campaigns).toHaveLength(501);
    expect(campaigns.some((campaign) => campaign.id === scheduledId)).toBe(true);
    expect(activeRequests[0]).toEqual({ limit: 500, before: null });
    expect(activeRequests[1]?.limit).toBe(500);
    expect(activeRequests[1]?.before).toContain('created_at.lt.');
    expect(activeRequests[1]?.before).toContain('id.lt.');
  });

  it('fails closed instead of silently truncating an excessive nonterminal set', async () => {
    let pageNumber = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      const statuses = url.searchParams.get('status') ?? '';
      expect(statuses).toContain('scheduled');
      const limit = Number(url.searchParams.get('limit'));
      const createdAt = new Date(Date.UTC(2026, 8, 7) - pageNumber * 1000).toISOString();
      pageNumber += 1;
      return new Response(
        JSON.stringify(
          Array.from({ length: limit }, () =>
            row({
              id: `33333333-3333-4333-8333-${String(pageNumber).padStart(12, '0')}`,
              status: 'draft',
              created_at: createdAt,
            }),
          ),
        ),
        { status: 200 },
      );
    });

    await expect(createPushCampaignStore(cfg).listCampaigns(100)).rejects.toEqual(
      new PushStoreError('unavailable', 'Nonterminal campaign safety cap exceeded'),
    );
    expect(fetchMock).toHaveBeenCalledTimes(11);
    const sentinelUrl = new URL(String(fetchMock.mock.calls[10]?.[0]));
    expect(sentinelUrl.searchParams.get('limit')).toBe('1');
    expect(sentinelUrl.searchParams.get('or')).toContain('created_at.lt.');
  });

  it('calls the CAS/idempotent draft RPC with command id, revision and stored cap', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([row({ status: 'draft' })]), { status: 200 }),
    );
    const store = createPushCampaignStore(cfg);
    await store.upsertDraft(
      {
        commandId: COMMAND_ID,
        id: ID,
        expectedRevision: 1,
        dedupKey: 'parts-launch',
        title: 'T',
        body: 'B',
        path: '/parts',
        audienceMode: 'marketing_opt_in',
        scheduledAt: null,
        maxRecipients: 16000,
      },
      'promo-cabinet',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/push_campaign_upsert_draft');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      p_command_id: COMMAND_ID,
      p_campaign_id: ID,
      p_expected_revision: 1,
      p_max_recipients: 16000,
      p_source: 'promo-cabinet',
    });
  });

  it('checks the stored safety cap before the queue transition RPC', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([row({ max_recipients: 16000 })]), { status: 200 }),
    );
    const store = createPushCampaignStore(cfg);
    await expect(
      store.queueCampaign(
        {
          id: ID,
          commandId: COMMAND_ID,
          expectedRevision: 2,
          expectedEligibleUsers: 15646,
          expectedAudienceDigest: HASH,
          expectedPayloadHash: HASH,
          confirmation: '15646',
          maxRecipients: 17000,
        },
        'promo-cabinet',
      ),
    ).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps DB SQLSTATEs to stable API-safe errors without returning DB messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'P4221', message: 'raw database detail' }), { status: 400 }),
    );
    const store = createPushCampaignStore(cfg);
    await expect(store.prepareCampaign(ID, 2, COMMAND_ID, 'promo-cabinet')).rejects.toEqual(
      new PushStoreError('audience_too_large', 'Frozen audience exceeds the configured safety cap'),
    );
  });

  it('parses only current mobile token bindings from a worker claim', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            campaign_id: ID,
            user_id: USER_ID,
            title: 'T',
            body: 'B',
            path: '/parts',
            data: { path: '/parts', numeric: 1 },
            skip_reason: null,
            tokens: [
              {
                token: 'mobile-token',
                platform: 'ios',
                token_hash: HASH,
                updated_at: '2026-09-07T10:00:00.000Z',
              },
              {
                token: 'web-token',
                platform: 'web',
                token_hash: HASH,
                updated_at: '2026-09-07T10:00:00.000Z',
              },
              {
                token: 'x'.repeat(8193),
                platform: 'ios',
                token_hash: HASH,
                updated_at: '2026-09-07T10:00:00.000Z',
              },
              { token: 'bad', platform: 'android', token_hash: 'not-a-hash', updated_at: 'x' },
            ],
          },
        ]),
        { status: 200 },
      ),
    );
    const store = createPushCampaignStore(cfg);
    const claims = await store.claimRecipients(ID, 'worker', 100, 300);
    expect(claims[0]?.tokens).toEqual([
      {
        token: 'mobile-token',
        platform: 'ios',
        tokenHash: HASH,
        updatedAt: '2026-09-07T10:00:00.000Z',
      },
    ]);
    expect(claims[0]?.data).toEqual({ path: '/parts' });
  });

  it('uses the live recipient resolver and exact pre-FCM token CAS gate', async () => {
    const binding = {
      token: 'mobile-token',
      platform: 'ios',
      token_hash: HASH,
      updated_at: '2026-09-07T10:00:00.000Z',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('push_campaign_resolve_recipient')) {
        return new Response(JSON.stringify([{ skip_reason: null, tokens: [binding] }]), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify([{ valid: true, skip_reason: null, platform: 'ios' }]),
        { status: 200 },
      );
    });
    const store = createPushCampaignStore(cfg);
    await expect(store.resolveRecipient(ID, USER_ID, 'worker')).resolves.toEqual({
      skipReason: null,
      tokens: [
        {
          token: 'mobile-token',
          platform: 'ios',
          tokenHash: HASH,
          updatedAt: binding.updated_at,
        },
      ],
    });
    await expect(
      store.validateToken({
        campaignId: ID,
        userId: USER_ID,
        workerId: 'worker',
        token: 'mobile-token',
        tokenHash: HASH,
        updatedAt: binding.updated_at,
      }),
    ).resolves.toEqual({ valid: true, skipReason: null, platform: 'ios' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/rest/v1/rpc/push_campaign_resolve_recipient',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/rest/v1/rpc/push_campaign_validate_token',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      p_campaign_id: ID,
      p_user_id: USER_ID,
      p_worker_id: 'worker',
      p_token: 'mobile-token',
      p_token_hash: HASH,
      p_updated_at: binding.updated_at,
    });
  });
});
