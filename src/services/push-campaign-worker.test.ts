import { describe, expect, it, vi } from 'vitest';
import type { FcmSender } from './fcm-v1-sender';
import type {
  ClaimedPushRecipient,
  PushCampaign,
  PushCampaignStore,
} from './push-campaign-store';
import {
  assertSafePushWorkerConfig,
  MAX_TOKEN_ATTEMPTS_PER_RECIPIENT,
  pushWorkerLeaseBudget,
  runPushWorkerLoop,
  runPushWorkerOnce,
  type PushWorkerConfig,
} from './push-campaign-worker';

const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);
const HASH_3 = 'c'.repeat(64);

const cfg: PushWorkerConfig = {
  workerId: 'worker-test',
  pollIntervalMs: 1,
  campaignLeaseSeconds: 60,
  recipientLeaseSeconds: 300,
  batchSize: 100,
  concurrency: 1,
  maxRequestsPerSecond: 500,
  requestTimeoutMs: 1000,
  supabaseTimeoutMs: 1000,
};

function campaign(): PushCampaign {
  return {
    id: CAMPAIGN_ID,
    revision: 1,
    dedupKey: 'test',
    title: 'T',
    body: 'B',
    path: '/',
    audienceMode: 'marketing_opt_in',
    consentBasis: null,
    status: 'running',
    scheduledAt: null,
    createdAt: new Date().toISOString(),
    preparedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    eligibleUsers: 1,
    candidateTokens: 1,
    maxRecipients: 10,
    exclusions: {},
    audienceDigest: HASH_1,
    payloadHash: HASH_2,
    accepted: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    cancelledCount: 0,
    createdBy: 'test',
    updatedAt: new Date().toISOString(),
  };
}

function recipient(
  overrides: Partial<ClaimedPushRecipient> = {},
): ClaimedPushRecipient {
  return {
    campaignId: CAMPAIGN_ID,
    userId: USER_ID,
    title: 'Нужна запчасть?',
    body: 'Спросите у магазинов',
    path: '/parts',
    data: {},
    tokens: [
      {
        token: 'newest',
        platform: 'ios',
        tokenHash: HASH_1,
        updatedAt: '2026-09-07T10:00:00.000Z',
      },
      {
        token: 'older',
        platform: 'android',
        tokenHash: HASH_2,
        updatedAt: '2026-09-06T10:00:00.000Z',
      },
    ],
    skipReason: null,
    ...overrides,
  };
}

function storeWith(
  recipients: ClaimedPushRecipient[],
  overrides: Partial<PushCampaignStore> = {},
): PushCampaignStore {
  return {
    configured: true,
    listCampaigns: async () => [],
    getCampaign: async () => null,
    getWorkerStatus: async () => ({ enabled: true, healthy: true }),
    upsertDraft: async () => campaign(),
    prepareCampaign: async () => campaign(),
    queueCampaign: async () => campaign(),
    cancelCampaign: async () => campaign(),
    heartbeatWorker: async () => {},
    claimDueCampaign: async () => ({ id: CAMPAIGN_ID, status: 'running' }),
    heartbeatCampaign: async () => true,
    recoverStaleRecipients: async () => 0,
    claimRecipients: async () => recipients,
    resolveRecipient: async (_campaignId, userId) => {
      const claimed = recipients.find((item) => item.userId === userId);
      if (!claimed) return { tokens: [], skipReason: 'recipient_not_claimed' };
      return {
        tokens: claimed.tokens,
        skipReason: claimed.skipReason,
      };
    },
    validateToken: async (input) => {
      const claimed = recipients.find((item) => item.userId === input.userId);
      const binding = claimed?.tokens.find(
        (item) =>
          item.token === input.token &&
          item.tokenHash === input.tokenHash &&
          item.updatedAt === input.updatedAt,
      );
      return {
        valid: !!binding,
        skipReason: binding ? null : 'token_binding_changed',
        platform: binding?.platform ?? null,
      };
    },
    finishRecipient: async () => true,
    pruneUnregisteredToken: async () => true,
    finalizeCampaign: async () => campaign(),
    failCampaign: async () => {},
    ...overrides,
  };
}

describe('durable push campaign worker', () => {
  it('budgets FCM 401 refresh/retry windows and accepts only the exact safe lease boundary', () => {
    const slowConfig: PushWorkerConfig = {
      ...cfg,
      campaignLeaseSeconds: 600,
      recipientLeaseSeconds: 600,
      batchSize: 500,
      concurrency: 8,
      maxRequestsPerSecond: 1,
      requestTimeoutMs: 10_000,
      supabaseTimeoutMs: 10_000,
    };
    const budget = pushWorkerLeaseBudget(slowConfig);
    expect(budget).toEqual({
      claimSize: 8,
      requiredCampaignLeaseSeconds: 161,
      requiredRecipientLeaseSeconds: 151,
    });
    expect(
      assertSafePushWorkerConfig({
        ...slowConfig,
        campaignLeaseSeconds: budget.requiredCampaignLeaseSeconds,
        recipientLeaseSeconds: budget.requiredRecipientLeaseSeconds,
      }),
    ).toEqual(budget);
    expect(() =>
      assertSafePushWorkerConfig({
        ...slowConfig,
        campaignLeaseSeconds: budget.requiredCampaignLeaseSeconds - 1,
      }),
    ).toThrow('PUSH_CAMPAIGN_LEASE_SECONDS must be at least 161');
    expect(() =>
      assertSafePushWorkerConfig({
        ...slowConfig,
        recipientLeaseSeconds: budget.requiredRecipientLeaseSeconds - 1,
      }),
    ).toThrow('PUSH_RECIPIENT_LEASE_SECONDS must be at least 151');
  });

  it('claims only one concurrency window even when the configured DB batch is much larger', async () => {
    const claimRecipients = vi.fn(async () => []);
    const heartbeatCampaign = vi.fn(async () => true);
    const slowButSafeConfig: PushWorkerConfig = {
      ...cfg,
      campaignLeaseSeconds: 180,
      recipientLeaseSeconds: 300,
      batchSize: 500,
      concurrency: 8,
      maxRequestsPerSecond: 1,
      requestTimeoutMs: 10_000,
      supabaseTimeoutMs: 10_000,
    };

    await runPushWorkerOnce({
      store: storeWith([], { claimRecipients, heartbeatCampaign }),
      sender: { send: vi.fn(async () => ({ kind: 'accepted' as const })) },
      config: slowButSafeConfig,
    });

    expect(heartbeatCampaign).toHaveBeenCalledWith(CAMPAIGN_ID, 'worker-test', 180);
    expect(claimRecipients).toHaveBeenCalledWith(CAMPAIGN_ID, 'worker-test', 8, 300);
  });

  it('does not claim recipients or a campaign while OAuth is unavailable', async () => {
    const claimDueCampaign = vi.fn(async () => ({ id: CAMPAIGN_ID, status: 'running' as const }));
    const store = storeWith([recipient()], { claimDueCampaign });
    const sender: FcmSender = {
      prepare: vi.fn(async () => ({
        kind: 'unavailable' as const,
        reason: 'oauth_unavailable',
        fatal: false,
      })),
      send: vi.fn(async () => ({ kind: 'accepted' as const })),
    };
    await expect(runPushWorkerOnce({ store, sender, config: cfg })).rejects.toThrow(
      'fcm_oauth_temporarily_unavailable',
    );
    expect(claimDueCampaign).not.toHaveBeenCalled();
  });

  it('stops after the newest token is accepted (one accepted push per user)', async () => {
    const finishRecipient = vi.fn(async () => true);
    const sender: FcmSender = { send: vi.fn(async () => ({ kind: 'accepted' as const })) };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient()], { finishRecipient }),
      sender,
      config: cfg,
    });
    expect(result).toMatchObject({ processed: 1, accepted: 1, fatal: false });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(
      'newest',
      'ios',
      expect.objectContaining({
        path: '/parts',
        data: expect.objectContaining({ uid: USER_ID }),
      }),
      undefined,
    );
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'accepted', tokenHash: HASH_1 }),
    );
  });

  it('falls back only after exact UNREGISTERED and prunes the same binding conditionally', async () => {
    const pruneUnregisteredToken = vi.fn(async () => true);
    const sender: FcmSender = {
      send: vi
        .fn<FcmSender['send']>()
        .mockResolvedValueOnce({ kind: 'unregistered' })
        .mockResolvedValueOnce({ kind: 'accepted' }),
    };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient()], { pruneUnregisteredToken }),
      sender,
      config: cfg,
    });
    expect(result.accepted).toBe(1);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(pruneUnregisteredToken).toHaveBeenCalledWith({
      userId: USER_ID,
      token: 'newest',
      tokenHash: HASH_1,
      updatedAt: '2026-09-07T10:00:00.000Z',
    });
  });

  it('bounds exact-UNREGISTERED fallbacks so the configured claim lease remains sufficient', async () => {
    const finishRecipient = vi.fn(async () => true);
    const pruneUnregisteredToken = vi.fn(async () => true);
    const withThreeTokens = recipient({
      tokens: [
        ...recipient().tokens,
        {
          token: 'oldest',
          platform: 'ios',
          tokenHash: HASH_3,
          updatedAt: '2026-09-05T10:00:00.000Z',
        },
      ],
    });
    const sender: FcmSender = {
      send: vi.fn(async () => ({ kind: 'unregistered' as const })),
    };

    const result = await runPushWorkerOnce({
      store: storeWith([withThreeTokens], {
        finishRecipient,
        pruneUnregisteredToken,
      }),
      sender,
      config: cfg,
    });

    expect(MAX_TOKEN_ATTEMPTS_PER_RECIPIENT).toBe(2);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(pruneUnregisteredToken).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(1);
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'skipped',
        reason: 'token_fallback_limit_reached',
      }),
    );
  });

  it('does not fallback or retry on an explicit non-UNREGISTERED rejection', async () => {
    const sender: FcmSender = {
      send: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'provider_retryable_rejection',
        fatal: false,
      })),
    };
    const result = await runPushWorkerOnce({ store: storeWith([recipient()]), sender, config: cfg });
    expect(result.failed).toBe(1);
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('opens the circuit after three consecutive provider 429/5xx outcomes across batches', async () => {
    const second = recipient({ userId: '33333333-3333-4333-8333-333333333333' });
    const third = recipient({ userId: '44444444-4444-4444-8444-444444444444' });
    const fourth = recipient({ userId: '55555555-5555-4555-8555-555555555555' });
    const circuitState = { consecutiveSystemicFailures: 0 };
    const sender: FcmSender = {
      send: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'provider_retryable_rejection',
        fatal: false,
      })),
    };

    const first = await runPushWorkerOnce({
      store: storeWith([recipient(), second]),
      sender,
      config: { ...cfg, concurrency: 1 },
      circuitState,
    });
    expect(first).toMatchObject({ fatal: false, failed: 2 });
    expect(circuitState.consecutiveSystemicFailures).toBe(2);

    const finishRecipient = vi.fn(async () => true);
    const failCampaign = vi.fn(async () => {});
    const secondRun = await runPushWorkerOnce({
      store: storeWith([third, fourth], { finishRecipient, failCampaign }),
      sender,
      config: { ...cfg, concurrency: 1 },
      circuitState,
    });
    expect(secondRun).toMatchObject({
      fatal: true,
      haltReason: 'fcm_systemic_circuit_open',
      processed: 2,
      failed: 2,
    });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: fourth.userId,
        outcome: 'failed',
        reason: 'provider_circuit_open_before_send',
      }),
    );
    expect(failCampaign).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      'worker-test',
      'fcm_systemic_circuit_open',
    );
  });

  it('opens the same circuit after three consecutive ambiguous FCM requests', async () => {
    const recipients = [
      recipient(),
      recipient({ userId: '33333333-3333-4333-8333-333333333333' }),
      recipient({ userId: '44444444-4444-4444-8444-444444444444' }),
      recipient({ userId: '55555555-5555-4555-8555-555555555555' }),
    ];
    const failCampaign = vi.fn(async () => {});
    const sender: FcmSender = {
      send: vi.fn(async () => ({
        kind: 'unknown' as const,
        reason: 'network_ambiguity' as const,
      })),
    };
    const result = await runPushWorkerOnce({
      store: storeWith(recipients, { failCampaign }),
      sender,
      config: { ...cfg, concurrency: 1 },
    });
    expect(result).toMatchObject({
      fatal: true,
      haltReason: 'fcm_systemic_circuit_open',
      processed: 4,
      unknown: 3,
      failed: 1,
    });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(failCampaign).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      'worker-test',
      'fcm_systemic_circuit_open',
    );
  });

  it('opens the circuit after three transient OAuth refresh failures following FCM 401', async () => {
    const recipients = [
      recipient(),
      recipient({ userId: '33333333-3333-4333-8333-333333333333' }),
      recipient({ userId: '44444444-4444-4444-8444-444444444444' }),
      recipient({ userId: '55555555-5555-4555-8555-555555555555' }),
    ];
    const finishRecipient = vi.fn(async () => true);
    const failCampaign = vi.fn(async () => {});
    const sender: FcmSender = {
      send: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'oauth_rejected',
        fatal: false,
      })),
    };
    const result = await runPushWorkerOnce({
      store: storeWith(recipients, { finishRecipient, failCampaign }),
      sender,
      config: { ...cfg, concurrency: 1 },
    });
    expect(result).toMatchObject({
      fatal: true,
      haltReason: 'fcm_systemic_circuit_open',
      processed: 4,
      failed: 4,
    });
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: recipients[3]?.userId,
        outcome: 'failed',
        reason: 'provider_circuit_open_before_send',
      }),
    );
    expect(failCampaign).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      'worker-test',
      'fcm_systemic_circuit_open',
    );
  });

  it('resets the systemic streak after a definite healthy FCM response', async () => {
    const recipients = [
      recipient(),
      recipient({ userId: '33333333-3333-4333-8333-333333333333' }),
      recipient({ userId: '44444444-4444-4444-8444-444444444444' }),
      recipient({ userId: '55555555-5555-4555-8555-555555555555' }),
    ];
    const failCampaign = vi.fn(async () => {});
    const sender: FcmSender = {
      send: vi
        .fn<FcmSender['send']>()
        .mockResolvedValueOnce({
          kind: 'failed',
          reason: 'provider_retryable_rejection',
          fatal: false,
        })
        .mockResolvedValueOnce({ kind: 'accepted' })
        .mockResolvedValueOnce({
          kind: 'failed',
          reason: 'provider_retryable_rejection',
          fatal: false,
        })
        .mockResolvedValueOnce({
          kind: 'failed',
          reason: 'provider_retryable_rejection',
          fatal: false,
        }),
    };
    const circuitState = { consecutiveSystemicFailures: 0 };
    const result = await runPushWorkerOnce({
      store: storeWith(recipients, { failCampaign }),
      sender,
      config: { ...cfg, concurrency: 1 },
      circuitState,
    });
    expect(result.fatal).toBe(false);
    expect(circuitState.consecutiveSystemicFailures).toBe(2);
    expect(failCampaign).not.toHaveBeenCalled();
  });

  it('records network ambiguity as unknown and never retries/falls back', async () => {
    const finishRecipient = vi.fn(async () => true);
    const sender: FcmSender = {
      send: vi.fn(async () => ({ kind: 'unknown' as const, reason: 'network_ambiguity' as const })),
    };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient()], { finishRecipient }),
      sender,
      config: cfg,
    });
    expect(result.unknown).toBe(1);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unknown', reason: 'network_ambiguity' }),
    );
  });

  it('persists an eligibility skip without calling FCM', async () => {
    const finishRecipient = vi.fn(async () => true);
    const sender: FcmSender = { send: vi.fn(async () => ({ kind: 'accepted' as const })) };
    const result = await runPushWorkerOnce({
      store: storeWith([
        recipient({ tokens: [], skipReason: 'marketing_opt_out' }),
      ], { finishRecipient }),
      sender,
      config: cfg,
    });
    expect(result.skipped).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped', reason: 'marketing_opt_out' }),
    );
  });

  it('rechecks consent and exact token ownership immediately before FCM', async () => {
    const finishRecipient = vi.fn(async () => true);
    const resolveRecipient = vi.fn(async () => ({
      tokens: recipient().tokens,
      skipReason: null,
    }));
    const validateToken = vi.fn(async () => ({
      valid: false,
      skipReason: 'marketing_opt_out',
      platform: null,
    }));
    const sender: FcmSender = { send: vi.fn(async () => ({ kind: 'accepted' as const })) };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient()], { resolveRecipient, validateToken, finishRecipient }),
      sender,
      config: cfg,
    });
    expect(result.skipped).toBe(1);
    expect(resolveRecipient).toHaveBeenCalledWith(CAMPAIGN_ID, USER_ID, 'worker-test');
    expect(validateToken).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: CAMPAIGN_ID,
        userId: USER_ID,
        token: 'newest',
        tokenHash: HASH_1,
      }),
    );
    expect(sender.send).not.toHaveBeenCalled();
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped', reason: 'marketing_opt_out' }),
    );
  });

  it('does not send a claimed recipient after cancellation commits', async () => {
    const finishRecipient = vi.fn(async () => true);
    const sender: FcmSender = { send: vi.fn(async () => ({ kind: 'accepted' as const })) };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient()], {
        validateToken: async () => ({
          valid: false,
          skipReason: 'campaign_cancelled',
          platform: null,
        }),
        finishRecipient,
      }),
      sender,
      config: cfg,
    });
    expect(result.skipped).toBe(1);
    expect(sender.send).not.toHaveBeenCalled();
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'skipped', reason: 'campaign_cancelled' }),
    );
  });

  it('halts a campaign on fatal provider configuration failure and closes unstarted claims', async () => {
    const second = recipient({ userId: '33333333-3333-4333-8333-333333333333' });
    const finishRecipient = vi.fn(async () => true);
    const failCampaign = vi.fn(async () => {});
    const sender: FcmSender = {
      send: vi.fn(async () => ({
        kind: 'failed' as const,
        reason: 'provider_configuration_or_payload',
        fatal: true,
      })),
    };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient(), second], { finishRecipient, failCampaign }),
      sender,
      config: { ...cfg, concurrency: 1 },
    });
    expect(result).toMatchObject({ processed: 2, failed: 2, fatal: true });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: second.userId,
        outcome: 'failed',
        reason: 'campaign_halted_before_send',
      }),
    );
    expect(failCampaign).toHaveBeenCalledWith(
      CAMPAIGN_ID,
      'worker-test',
      'fcm_configuration_failure',
    );
  });

  it('latches a recipient persistence error without falsely failing the provider campaign', async () => {
    const failCampaign = vi.fn(async () => {});
    const store = storeWith([recipient()], {
      finishRecipient: vi.fn(async () => {
        throw new Error('database timeout');
      }),
      failCampaign,
    });
    const sender: FcmSender = {
      send: vi.fn(async () => ({ kind: 'accepted' as const })),
    };

    await expect(runPushWorkerOnce({ store, sender, config: cfg })).resolves.toMatchObject({
      fatal: true,
      haltReason: 'worker_persistence_failure',
    });
    expect(failCampaign).not.toHaveBeenCalled();
  });

  it('never claims or sends a second window after an accepted result cannot be persisted', async () => {
    const abort = new AbortController();
    const claimDueCampaign = vi.fn(async () => ({
      id: CAMPAIGN_ID,
      status: 'running' as const,
    }));
    const finishRecipient = vi.fn(async () => {
      throw new Error('database timeout after FCM accepted');
    });
    const failCampaign = vi.fn(async () => {});
    const heartbeatWorker = vi.fn(async (input: Parameters<PushCampaignStore['heartbeatWorker']>[0]) => {
      if (!input.healthy && input.lastError === 'worker_persistence_failure') abort.abort();
    });
    const sender: FcmSender = {
      send: vi.fn(async () => ({ kind: 'accepted' as const })),
    };
    const store = storeWith([recipient()], {
      claimDueCampaign,
      finishRecipient,
      failCampaign,
      heartbeatWorker,
    });

    await runPushWorkerLoop({ store, sender, config: cfg, signal: abort.signal });

    expect(claimDueCampaign).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledOnce();
    expect(heartbeatWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        healthy: false,
        lastError: 'worker_persistence_failure',
      }),
    );
    expect(failCampaign).not.toHaveBeenCalled();
  });

  it('never retries an ambiguous claimRecipients RPC after the campaign is claimed', async () => {
    const abort = new AbortController();
    const claimDueCampaign = vi.fn(async () => ({
      id: CAMPAIGN_ID,
      status: 'running' as const,
    }));
    const claimRecipients = vi.fn(async () => {
      throw new Error('claim response lost after commit');
    });
    const heartbeatWorker = vi.fn(async (input: Parameters<PushCampaignStore['heartbeatWorker']>[0]) => {
      if (!input.healthy && input.lastError === 'worker_persistence_failure') abort.abort();
    });
    const sender: FcmSender = {
      send: vi.fn(async () => ({ kind: 'accepted' as const })),
    };
    const store = storeWith([], {
      claimDueCampaign,
      claimRecipients,
      heartbeatWorker,
    });

    await runPushWorkerLoop({ store, sender, config: cfg, signal: abort.signal });

    expect(claimDueCampaign).toHaveBeenCalledOnce();
    expect(claimRecipients).toHaveBeenCalledOnce();
    expect(sender.send).not.toHaveBeenCalled();
    expect(heartbeatWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        healthy: false,
        lastError: 'worker_persistence_failure',
      }),
    );
  });

  it('marks stale claimed recipients unknown before claiming a new batch', async () => {
    const order: string[] = [];
    const store = storeWith([], {
      recoverStaleRecipients: async () => {
        order.push('recover');
        return 2;
      },
      claimRecipients: async () => {
        order.push('claim');
        return [];
      },
      finalizeCampaign: async () => {
        order.push('finalize');
        return campaign();
      },
    });
    await runPushWorkerOnce({
      store,
      sender: { send: vi.fn(async () => ({ kind: 'accepted' as const })) },
      config: cfg,
    });
    expect(order).toEqual(['recover', 'claim', 'finalize']);
  });

  it('never claims new recipients after cancellation was requested', async () => {
    const claimRecipients = vi.fn(async () => [recipient()]);
    const finalizeCampaign = vi.fn(async () => campaign());
    const store = storeWith([], {
      claimDueCampaign: async () => ({ id: CAMPAIGN_ID, status: 'cancel_requested' }),
      claimRecipients,
      finalizeCampaign,
    });
    const sender: FcmSender = { send: vi.fn(async () => ({ kind: 'accepted' as const })) };
    await runPushWorkerOnce({ store, sender, config: cfg });
    expect(claimRecipients).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
    expect(finalizeCampaign).toHaveBeenCalledWith(CAMPAIGN_ID, 'worker-test');
  });

  it('closes claims that were not started when graceful shutdown begins', async () => {
    const abort = new AbortController();
    const second = recipient({ userId: '33333333-3333-4333-8333-333333333333' });
    const finishRecipient = vi.fn(async () => true);
    const sender: FcmSender = {
      send: vi.fn(async () => {
        abort.abort();
        return { kind: 'accepted' as const };
      }),
    };
    const result = await runPushWorkerOnce({
      store: storeWith([recipient(), second], { finishRecipient }),
      sender,
      config: { ...cfg, concurrency: 1 },
      signal: abort.signal,
    });
    expect(result).toMatchObject({ processed: 2, accepted: 1, failed: 1 });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(finishRecipient).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: second.userId,
        outcome: 'failed',
        reason: 'worker_stopped_before_send',
      }),
    );
  });

  it('never opens the systemic circuit from SIGTERM-aborted in-flight requests', async () => {
    const abort = new AbortController();
    const users = Array.from({ length: 8 }, (_, index) =>
      recipient({
        userId: `${String(index + 3).padStart(8, '0')}-3333-4333-8333-333333333333`,
      }),
    );
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const sender: FcmSender = {
      send: vi.fn(async () => {
        started += 1;
        if (started === 3) {
          abort.abort();
          release();
        }
        await inFlight;
        return { kind: 'unknown' as const, reason: 'request_timeout' as const };
      }),
    };
    const failCampaign = vi.fn(async () => {});
    const circuitState = { consecutiveSystemicFailures: 0 };
    const result = await runPushWorkerOnce({
      store: storeWith(users, { failCampaign }),
      sender,
      config: { ...cfg, concurrency: 8 },
      signal: abort.signal,
      circuitState,
    });
    expect(result).toMatchObject({ fatal: false, haltReason: null });
    expect(result.unknown).toBe(3);
    expect(sender.send).toHaveBeenCalledTimes(3);
    expect(circuitState.consecutiveSystemicFailures).toBe(0);
    expect(failCampaign).not.toHaveBeenCalled();
  });
});
