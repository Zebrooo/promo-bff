import { createHash } from 'node:crypto';
import type { FcmSender } from './fcm-v1-sender';
import type {
  ClaimedPushRecipient,
  FinishPushRecipientInput,
  PushCampaignStore,
  PushRecipientOutcome,
} from './push-campaign-store';

export interface PushWorkerConfig {
  workerId: string;
  pollIntervalMs: number;
  campaignLeaseSeconds: number;
  recipientLeaseSeconds: number;
  batchSize: number;
  concurrency: number;
  maxRequestsPerSecond: number;
  requestTimeoutMs: number;
  supabaseTimeoutMs: number;
}

export interface PushWorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface PushWorkerRunResult {
  campaignClaimed: boolean;
  processed: number;
  accepted: number;
  skipped: number;
  failed: number;
  unknown: number;
  fatal: boolean;
  haltReason: PushWorkerHaltReason | null;
}

export type PushWorkerHaltReason =
  | 'fcm_configuration_failure'
  | 'fcm_systemic_circuit_open'
  | 'worker_persistence_failure';

export interface PushCircuitState {
  consecutiveSystemicFailures: number;
}

/** Three consecutive system-level outcomes stop the campaign before it burns its audience. */
export const SYSTEMIC_FAILURE_CIRCUIT_THRESHOLD = 3;
/** Newest binding plus one exact-UNREGISTERED fallback. Bounds claim lease duration. */
export const MAX_TOKEN_ATTEMPTS_PER_RECIPIENT = 2;
const LEASE_SAFETY_MARGIN_MS = 5_000;
const NETWORK_TIMEOUT_WINDOWS_PER_TOKEN = 3;

const SYSTEMIC_FAILURE_REASONS = new Set([
  'provider_retryable_rejection',
  'oauth_rejected',
  'oauth_timeout',
  'oauth_unavailable',
]);

const SILENT_LOGGER: PushWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface PushWorkerLeaseBudget {
  claimSize: number;
  requiredCampaignLeaseSeconds: number;
  requiredRecipientLeaseSeconds: number;
}

/**
 * Computes a conservative upper bound for one claimed concurrency window.
 * The DB term covers claim response, live resolution, per-token validation and
 * prune, plus the terminal recipient write. Each token reserves three network
 * windows for FCM 401, OAuth refresh and the single authorized FCM retry. The
 * rate term also covers a previously occupied limiter slot.
 */
export function pushWorkerLeaseBudget(config: PushWorkerConfig): PushWorkerLeaseBudget {
  const values = [
    config.batchSize,
    config.concurrency,
    config.maxRequestsPerSecond,
    config.requestTimeoutMs,
    config.supabaseTimeoutMs,
  ];
  if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('push worker lease budget inputs must be positive integers');
  }
  const claimSize = Math.min(config.batchSize, config.concurrency);
  const providerSlots = claimSize * MAX_TOKEN_ATTEMPTS_PER_RECIPIENT;
  const startIntervalMs = Math.ceil(1000 / config.maxRequestsPerSecond);
  const recipientDbOperations = 3 + 2 * MAX_TOKEN_ATTEMPTS_PER_RECIPIENT;
  const recipientRequiredMs =
    recipientDbOperations * config.supabaseTimeoutMs +
    MAX_TOKEN_ATTEMPTS_PER_RECIPIENT *
      NETWORK_TIMEOUT_WINDOWS_PER_TOKEN *
      config.requestTimeoutMs +
    providerSlots * startIntervalMs +
    LEASE_SAFETY_MARGIN_MS;
  // Campaign lease starts inside the heartbeat RPC, one response window before
  // the recipient lease is created by the following claim RPC.
  const campaignRequiredMs = recipientRequiredMs + config.supabaseTimeoutMs;
  if (
    !Number.isSafeInteger(recipientRequiredMs) ||
    !Number.isSafeInteger(campaignRequiredMs)
  ) {
    throw new Error('push worker lease budget exceeds the safe integer range');
  }
  return {
    claimSize,
    requiredCampaignLeaseSeconds: Math.ceil(campaignRequiredMs / 1000),
    requiredRecipientLeaseSeconds: Math.ceil(recipientRequiredMs / 1000),
  };
}

export function assertSafePushWorkerConfig(config: PushWorkerConfig): PushWorkerLeaseBudget {
  const budget = pushWorkerLeaseBudget(config);
  if (config.campaignLeaseSeconds < budget.requiredCampaignLeaseSeconds) {
    throw new Error(
      `PUSH_CAMPAIGN_LEASE_SECONDS must be at least ${budget.requiredCampaignLeaseSeconds} for the configured delivery window`,
    );
  }
  if (config.recipientLeaseSeconds < budget.requiredRecipientLeaseSeconds) {
    throw new Error(
      `PUSH_RECIPIENT_LEASE_SECONDS must be at least ${budget.requiredRecipientLeaseSeconds} for the configured delivery window`,
    );
  }
  return budget;
}

function campaignRef(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

function safeReason(reason: string | null | undefined, fallback: string): string {
  if (!reason || !/^[a-z][a-z0-9_]{0,63}$/.test(reason)) return fallback;
  return reason;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Serializes only request *start times*; FCM requests can still run concurrently. */
export function createStartRateLimiter(maxPerSecond: number): (signal?: AbortSignal) => Promise<void> {
  const intervalMs = Math.ceil(1000 / Math.max(1, maxPerSecond));
  let tail = Promise.resolve();
  let nextStartAt = 0;
  return async (signal) => {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const delay = Math.max(0, nextStartAt - Date.now());
      await abortableDelay(delay, signal);
      if (!signal?.aborted) nextStartAt = Date.now() + intervalMs;
    } finally {
      release();
    }
  };
}

interface RecipientResult {
  outcome: PushRecipientOutcome;
  fatal: boolean;
  providerSignals: Array<'healthy' | 'systemic'>;
}

async function finish(
  store: PushCampaignStore,
  recipient: ClaimedPushRecipient,
  workerId: string,
  input: Omit<FinishPushRecipientInput, 'campaignId' | 'userId' | 'workerId'>,
): Promise<RecipientResult> {
  const completed = await store.finishRecipient({
    campaignId: recipient.campaignId,
    userId: recipient.userId,
    workerId,
    ...input,
  });
  if (!completed) throw new Error('recipient_lease_lost');
  return { outcome: input.outcome, fatal: false, providerSignals: [] };
}

async function processRecipient(opts: {
  store: PushCampaignStore;
  sender: FcmSender;
  recipient: ClaimedPushRecipient;
  workerId: string;
  beforeRequest: (signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}): Promise<RecipientResult> {
  const { store, sender, recipient, workerId, beforeRequest, signal } = opts;
  const providerSignals: Array<'healthy' | 'systemic'> = [];
  const live = await store.resolveRecipient(
    recipient.campaignId,
    recipient.userId,
    workerId,
  );
  if (live.skipReason || live.tokens.length === 0) {
    return finish(store, recipient, workerId, {
      outcome: 'skipped',
      reason: safeReason(live.skipReason, 'no_eligible_mobile_token'),
    });
  }

  const bindings = live.tokens.slice(0, MAX_TOKEN_ATTEMPTS_PER_RECIPIENT);
  for (const binding of bindings) {
    if (signal?.aborted) {
      return finish(store, recipient, workerId, {
        outcome: 'failed',
        reason: 'worker_stopped_before_send',
      });
    }
    await beforeRequest(signal);
    if (signal?.aborted) {
      return finish(store, recipient, workerId, {
        outcome: 'failed',
        reason: 'worker_stopped_before_send',
      });
    }

    const validation = await store.validateToken({
      campaignId: recipient.campaignId,
      userId: recipient.userId,
      workerId,
      token: binding.token,
      tokenHash: binding.tokenHash,
      updatedAt: binding.updatedAt,
    });
    if (!validation.valid || !validation.platform) {
      return finish(store, recipient, workerId, {
        outcome: 'skipped',
        reason: safeReason(validation.skipReason, 'token_binding_changed'),
      });
    }
    if (signal?.aborted) {
      return finish(store, recipient, workerId, {
        outcome: 'failed',
        reason: 'worker_stopped_before_send',
      });
    }

    const result = await sender.send(
      binding.token,
      validation.platform,
      {
        title: recipient.title,
        body: recipient.body,
        path: recipient.path,
        data: { ...recipient.data, uid: recipient.userId },
      },
      signal,
    );
    if (result.kind === 'unregistered') {
      providerSignals.push('healthy');
      await store.pruneUnregisteredToken({
        userId: recipient.userId,
        token: binding.token,
        tokenHash: binding.tokenHash,
        updatedAt: binding.updatedAt,
      });
      // Exact UNREGISTERED is the sole condition that permits trying the next
      // newest token. No accepted notification exists for this attempt.
      continue;
    }
    if (result.kind === 'accepted') {
      const completed = await finish(store, recipient, workerId, {
        outcome: 'accepted',
        reason: 'fcm_accepted',
        platform: validation.platform,
        tokenHash: binding.tokenHash,
      });
      return { ...completed, providerSignals: [...providerSignals, 'healthy'] };
    }
    if (result.kind === 'unknown') {
      const completed = await finish(store, recipient, workerId, {
        outcome: 'unknown',
        reason: result.reason,
        platform: validation.platform,
        tokenHash: binding.tokenHash,
      });
      return { ...completed, providerSignals: [...providerSignals, 'systemic'] };
    }
    const completed = await finish(store, recipient, workerId, {
      outcome: 'failed',
      reason: safeReason(result.reason, 'provider_rejection'),
      platform: validation.platform,
      tokenHash: binding.tokenHash,
    });
    return {
      ...completed,
      fatal: result.fatal,
      providerSignals: [
        ...providerSignals,
        !result.fatal && SYSTEMIC_FAILURE_REASONS.has(result.reason)
          ? 'systemic'
          : 'healthy',
      ],
    };
  }

  const completed = await finish(store, recipient, workerId, {
    outcome: 'skipped',
    reason:
      live.tokens.length > bindings.length
        ? 'token_fallback_limit_reached'
        : 'all_tokens_unregistered',
  });
  return { ...completed, providerSignals };
}

export async function runPushWorkerOnce(opts: {
  store: PushCampaignStore;
  sender: FcmSender;
  config: PushWorkerConfig;
  logger?: PushWorkerLogger;
  signal?: AbortSignal;
  /** Shared by the long-running loop so rate limiting spans batch boundaries. */
  beforeRequest?: (signal?: AbortSignal) => Promise<void>;
  /** Shared by the long-running loop so a systemic streak spans DB batches. */
  circuitState?: PushCircuitState;
}): Promise<PushWorkerRunResult> {
  const { store, sender, config, signal } = opts;
  const leaseBudget = assertSafePushWorkerConfig(config);
  const logger = opts.logger ?? SILENT_LOGGER;
  const empty: PushWorkerRunResult = {
    campaignClaimed: false,
    processed: 0,
    accepted: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    fatal: false,
    haltReason: null,
  };
  if (signal?.aborted) return empty;

  const readiness = await sender.prepare?.(signal);
  if (readiness?.kind === 'unavailable') {
    if (readiness.fatal) {
      return { ...empty, fatal: true, haltReason: 'fcm_configuration_failure' };
    }
    throw new Error('fcm_oauth_temporarily_unavailable');
  }

  const campaign = await store.claimDueCampaign(config.workerId, config.campaignLeaseSeconds);
  if (!campaign) return empty;
  const result = { ...empty, campaignClaimed: true };
  const ref = campaignRef(campaign.id);

  try {
  const recovered = await store.recoverStaleRecipients(campaign.id, config.workerId);
  if (recovered > 0) {
    logger.warn({ campaignRef: ref, recovered }, 'ambiguous stale recipient leases marked unknown');
  }
  if (campaign.status === 'cancel_requested') {
    await store.finalizeCampaign(campaign.id, config.workerId);
    logger.info({ campaignRef: ref }, 'cancelled push campaign finalization checked');
    return result;
  }
  if (signal?.aborted) return result;
  const leaseOkBeforeClaim = await store.heartbeatCampaign(
    campaign.id,
    config.workerId,
    config.campaignLeaseSeconds,
  );
  if (!leaseOkBeforeClaim) throw new Error('campaign_lease_lost');
  const recipients = await store.claimRecipients(
    campaign.id,
    config.workerId,
    leaseBudget.claimSize,
    config.recipientLeaseSeconds,
  );
  if (recipients.length === 0) {
    await store.finalizeCampaign(campaign.id, config.workerId);
    logger.info({ campaignRef: ref }, 'push campaign finalized');
    return result;
  }

  const beforeRequest =
    opts.beforeRequest ?? createStartRateLimiter(config.maxRequestsPerSecond);
  const circuitState = opts.circuitState ?? { consecutiveSystemicFailures: 0 };
  for (let offset = 0; offset < recipients.length; offset += config.concurrency) {
    const chunk = recipients.slice(offset, offset + config.concurrency);
    const settled = await Promise.allSettled(
      chunk.map((recipient) =>
        processRecipient({
          store,
          sender,
          recipient,
          workerId: config.workerId,
          beforeRequest,
          signal,
        }),
      ),
    );

    let infrastructureFailure = false;
    let providerFatal = false;
    let systemicCircuitOpen = false;
    for (const item of settled) {
      result.processed += 1;
      if (item.status === 'rejected') {
        infrastructureFailure = true;
        continue;
      }
      result[item.value.outcome] += 1;
      providerFatal ||= item.value.fatal;
      if (!signal?.aborted) {
        for (const providerSignal of item.value.providerSignals) {
          if (providerSignal === 'healthy') {
            circuitState.consecutiveSystemicFailures = 0;
          } else {
            circuitState.consecutiveSystemicFailures += 1;
            systemicCircuitOpen ||=
              circuitState.consecutiveSystemicFailures >=
              SYSTEMIC_FAILURE_CIRCUIT_THRESHOLD;
          }
        }
      }
    }

    // Operator shutdown wins over provider classification. Requests already
    // started remain terminal unknown if ambiguous; known-unstarted claims are
    // closed, while DB-pending recipients stay pending for a later worker.
    if (signal?.aborted) {
      const unstarted = recipients.slice(offset + chunk.length);
      const closed = await Promise.allSettled(
        unstarted.map((recipient) =>
          finish(store, recipient, config.workerId, {
            outcome: 'failed',
            reason: 'worker_stopped_before_send',
          }),
        ),
      );
      for (const item of closed) {
        result.processed += 1;
        if (item.status === 'fulfilled') result.failed += 1;
      }
      break;
    }

    const haltReason: PushWorkerHaltReason | null = providerFatal
      ? 'fcm_configuration_failure'
      : systemicCircuitOpen
        ? 'fcm_systemic_circuit_open'
        : null;

    if (infrastructureFailure) {
      const unstarted = recipients.slice(offset + chunk.length);
      await Promise.allSettled(
        unstarted.map((recipient) =>
          finish(store, recipient, config.workerId, {
            outcome: 'failed',
            reason: 'worker_halted_before_send',
          }),
        ),
      );
      // A provider request may already have been accepted while its terminal
      // DB write failed. Do not mutate campaign state or claim another window:
      // leave unresolved claims to expire as unknown and require operator
      // restart after storage health is restored.
      result.fatal = true;
      result.haltReason = 'worker_persistence_failure';
      logger.error(
        { campaignRef: ref, reason: 'worker_persistence_failure' },
        'push worker halted after a post-claim persistence failure',
      );
      return result;
    }

    if (haltReason) {
      result.fatal = true;
      result.haltReason = haltReason;
      const unstarted = recipients.slice(offset + chunk.length);
      await Promise.allSettled(
        unstarted.map((recipient) =>
          finish(store, recipient, config.workerId, {
            outcome: 'failed',
            reason:
              haltReason === 'fcm_systemic_circuit_open'
                ? 'provider_circuit_open_before_send'
                : 'campaign_halted_before_send',
          }),
        ),
      );
      result.processed += unstarted.length;
      result.failed += unstarted.length;
      await store
        .failCampaign(campaign.id, config.workerId, haltReason)
        .catch(() => {
          logger.error(
            { campaignRef: ref, reason: 'campaign_fail_persistence_failed' },
            'could not persist fatal push campaign state',
          );
        });
      logger.error(
        { campaignRef: ref, processed: result.processed, reason: haltReason },
        'push campaign halted by the provider safety circuit',
      );
      return result;
    }

    const leaseOk = await store.heartbeatCampaign(
      campaign.id,
      config.workerId,
      config.campaignLeaseSeconds,
    );
    if (!leaseOk) throw new Error('campaign_lease_lost');
  }

  logger.info(
    {
      campaignRef: ref,
      processed: result.processed,
      accepted: result.accepted,
      skipped: result.skipped,
      failed: result.failed,
      unknown: result.unknown,
    },
    'push campaign batch processed',
  );
  return result;
  } catch {
    // Once the campaign claim is known to have succeeded, every ambiguous DB
    // failure is safety-critical: claimRecipients itself may have committed
    // before its response was lost. Latch globally so the next window is not
    // claimed and sent with the ledger unavailable.
    logger.error(
      { campaignRef: ref, reason: 'worker_persistence_failure' },
      'push worker halted after an ambiguous post-claim failure',
    );
    return {
      ...result,
      fatal: true,
      haltReason: 'worker_persistence_failure',
    };
  }
}

export async function runPushWorkerLoop(opts: {
  store: PushCampaignStore;
  sender: FcmSender;
  config: PushWorkerConfig;
  logger?: PushWorkerLogger;
  signal: AbortSignal;
}): Promise<void> {
  const { store, sender, config, signal } = opts;
  const logger = opts.logger ?? SILENT_LOGGER;
  const beforeRequest = createStartRateLimiter(config.maxRequestsPerSecond);
  const circuitState: PushCircuitState = { consecutiveSystemicFailures: 0 };
  while (!signal.aborted) {
    try {
      await store.heartbeatWorker({
        workerId: config.workerId,
        enabled: true,
        healthy: true,
        metadata: {
          batchSize: config.batchSize,
          concurrency: config.concurrency,
          maxRequestsPerSecond: config.maxRequestsPerSecond,
        },
      });
      const result = await runPushWorkerOnce({
        store,
        sender,
        config,
        logger,
        signal,
        beforeRequest,
        circuitState,
      });
      if (result.fatal) {
        // Latch open until an operator restarts/redeploys the worker. Continuing
        // would sacrifice recipients while provider or persistence health is
        // unknown. The latch never transitions campaign state by itself.
        const haltReason = result.haltReason ?? 'fcm_configuration_failure';
        logger.error({ reason: haltReason }, 'push worker halted fail-closed');
        while (!signal.aborted) {
          await store
            .heartbeatWorker({
              workerId: config.workerId,
              enabled: true,
              healthy: false,
              lastError: haltReason,
            })
            .catch(() => {});
          await abortableDelay(30_000, signal);
        }
        return;
      }
      if (!result.campaignClaimed || result.processed === 0) {
        await abortableDelay(config.pollIntervalMs, signal);
      }
    } catch {
      logger.error({ reason: 'worker_iteration_failed' }, 'push worker iteration failed');
      await store
        .heartbeatWorker({
          workerId: config.workerId,
          enabled: true,
          healthy: false,
          lastError: 'worker_iteration_failed',
        })
        .catch(() => {});
      await abortableDelay(config.pollIntervalMs, signal);
    }
  }
}
