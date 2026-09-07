import { fileURLToPath } from 'node:url';
import { config } from './config';
import {
  createFcmSender,
  loadFcmServiceAccount,
  type FcmServiceAccount,
} from './services/fcm-v1-sender';
import { createPushCampaignStore } from './services/push-campaign-store';
import {
  assertSafePushWorkerConfig,
  runPushWorkerLoop,
  type PushWorkerConfig,
  type PushWorkerLogger,
} from './services/push-campaign-worker';

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

const logger: PushWorkerLogger = {
  info(fields, message) {
    console.info(JSON.stringify({ level: 'info', message, ...fields }));
  },
  warn(fields, message) {
    console.warn(JSON.stringify({ level: 'warn', message, ...fields }));
  },
  error(fields, message) {
    console.error(JSON.stringify({ level: 'error', message, ...fields }));
  },
};

function workerConfig(): PushWorkerConfig {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(config.pushDelivery.workerId)) {
    throw new Error('PUSH_WORKER_ID has an invalid format');
  }
  const cfg: PushWorkerConfig = {
    workerId: config.pushDelivery.workerId,
    pollIntervalMs: boundedInteger(config.pushDelivery.pollIntervalMs, 250, 60_000, 'PUSH_WORKER_POLL_MS'),
    campaignLeaseSeconds: boundedInteger(
      config.pushDelivery.campaignLeaseSeconds,
      15,
      600,
      'PUSH_CAMPAIGN_LEASE_SECONDS',
    ),
    recipientLeaseSeconds: boundedInteger(
      config.pushDelivery.recipientLeaseSeconds,
      30,
      1800,
      'PUSH_RECIPIENT_LEASE_SECONDS',
    ),
    batchSize: boundedInteger(config.pushDelivery.batchSize, 1, 500, 'PUSH_WORKER_BATCH_SIZE'),
    concurrency: boundedInteger(config.pushDelivery.concurrency, 1, 32, 'PUSH_WORKER_CONCURRENCY'),
    maxRequestsPerSecond: boundedInteger(
      config.pushDelivery.maxRequestsPerSecond,
      1,
      500,
      'PUSH_WORKER_MAX_RPS',
    ),
    requestTimeoutMs: boundedInteger(
      config.pushDelivery.requestTimeoutMs,
      1000,
      60_000,
      'FCM_REQUEST_TIMEOUT_MS',
    ),
    supabaseTimeoutMs: boundedInteger(
      config.pushDelivery.supabaseTimeoutMs,
      1000,
      60_000,
      'PUSH_SUPABASE_TIMEOUT_MS',
    ),
  };
  assertSafePushWorkerConfig(cfg);
  return cfg;
}

async function markDisabledUntilStopped(
  signal: AbortSignal,
  reason: string,
): Promise<void> {
  const store = createPushCampaignStore({
    ...config.aaSupabase,
    timeoutMs: config.pushDelivery.supabaseTimeoutMs,
  });
  if (!store.configured) {
    logger.error({ reason: 'storage_unconfigured' }, 'push worker is disabled');
    return;
  }
  while (!signal.aborted) {
    await store
      .heartbeatWorker({
        workerId: config.pushDelivery.workerId,
        enabled: false,
        healthy: false,
        lastError: reason,
      })
      .catch(() => {});
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 30_000);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

export async function runPushWorkerProcess(): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    if (!config.pushDelivery.enabled) {
      logger.warn({ reason: 'explicitly_disabled' }, 'push worker is disabled');
      await markDisabledUntilStopped(abort.signal, 'explicitly_disabled');
      return;
    }
    if (!config.aaSupabase.url || !config.aaSupabase.serviceRoleKey) {
      logger.error({ reason: 'storage_unconfigured' }, 'push worker cannot start');
      throw new Error('AA Supabase configuration is required');
    }
    if (!config.pushDelivery.fcmServiceAccountFile || !config.pushDelivery.fcmProjectId) {
      logger.error({ reason: 'credentials_unconfigured' }, 'push worker is disabled');
      await markDisabledUntilStopped(abort.signal, 'credentials_unconfigured');
      return;
    }

    const cfg = workerConfig();

    const store = createPushCampaignStore({
      ...config.aaSupabase,
      timeoutMs: cfg.supabaseTimeoutMs,
    });
    let serviceAccount: FcmServiceAccount;
    try {
      serviceAccount = await loadFcmServiceAccount(
        config.pushDelivery.fcmServiceAccountFile,
        config.pushDelivery.fcmProjectId,
      );
    } catch {
      await store
        .heartbeatWorker({
          workerId: config.pushDelivery.workerId,
          enabled: false,
          healthy: false,
          lastError: 'credentials_invalid',
        })
        .catch(() => {});
      logger.error({ reason: 'credentials_invalid' }, 'push worker is disabled');
      await markDisabledUntilStopped(abort.signal, 'credentials_invalid');
      return;
    }
    const sender = createFcmSender({
      serviceAccount,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    logger.info(
      {
        batchSize: cfg.batchSize,
        concurrency: cfg.concurrency,
        maxRequestsPerSecond: cfg.maxRequestsPerSecond,
      },
      'push worker started',
    );
    await runPushWorkerLoop({ store, sender, config: cfg, logger, signal: abort.signal });
    await store
      .heartbeatWorker({
        workerId: cfg.workerId,
        enabled: true,
        healthy: false,
        lastError: 'worker_stopped',
      })
      .catch(() => {});
    logger.info({}, 'push worker stopped');
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runPushWorkerProcess().catch(() => {
    logger.error({ reason: 'startup_failed' }, 'push worker exited');
    process.exitCode = 1;
  });
}
