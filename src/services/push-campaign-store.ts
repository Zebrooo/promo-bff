import type { SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export const PUSH_AUDIENCE_MODES = ['marketing_opt_in', 'offline_consent'] as const;
export type PushAudienceMode = (typeof PUSH_AUDIENCE_MODES)[number];

export const PUSH_CAMPAIGN_STATUSES = [
  'draft',
  'prepared',
  'scheduled',
  'running',
  'cancel_requested',
  'cancelled',
  'completed',
  'completed_with_failures',
  'failed',
] as const;
export type PushCampaignStatus = (typeof PUSH_CAMPAIGN_STATUSES)[number];

const NONTERMINAL_CAMPAIGN_STATUSES: PushCampaignStatus[] = [
  'draft',
  'prepared',
  'scheduled',
  'running',
  'cancel_requested',
];
const TERMINAL_CAMPAIGN_STATUSES: PushCampaignStatus[] = [
  'cancelled',
  'completed',
  'completed_with_failures',
  'failed',
];
const CAMPAIGN_PAGE_SIZE = 500;
const MAX_NONTERMINAL_CAMPAIGNS = 5_000;

export const PUSH_RECIPIENT_OUTCOMES = [
  'accepted',
  'skipped',
  'failed',
  'unknown',
] as const;
export type PushRecipientOutcome = (typeof PUSH_RECIPIENT_OUTCOMES)[number];

/** The only campaign shape exposed to the cabinet. Recipient ids and tokens never leave the worker. */
export interface PushCampaign {
  id: string;
  revision: number;
  dedupKey: string;
  title: string;
  body: string;
  path: string;
  audienceMode: PushAudienceMode;
  consentBasis: string | null;
  status: PushCampaignStatus;
  scheduledAt: string | null;
  createdAt: string;
  preparedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  eligibleUsers: number;
  candidateTokens: number;
  maxRecipients: number | null;
  exclusions: Record<string, number>;
  audienceDigest: string | null;
  payloadHash: string;
  accepted: number;
  skipped: number;
  failed: number;
  unknown: number;
  cancelledCount: number;
  createdBy: string;
  updatedAt: string;
}

export interface PushWorkerStatus {
  enabled: boolean;
  healthy: boolean;
  lastHeartbeatAt?: string;
}

export interface UpsertPushCampaignInput {
  commandId: string;
  id?: string;
  expectedRevision?: number;
  dedupKey: string;
  title: string;
  body: string;
  path: string;
  audienceMode: PushAudienceMode;
  consentBasis?: string | null;
  scheduledAt?: string | null;
  maxRecipients: number;
}

export interface QueuePushCampaignInput {
  id: string;
  expectedRevision: number;
  commandId: string;
  expectedEligibleUsers: number;
  expectedAudienceDigest: string;
  expectedPayloadHash: string;
  confirmation: string;
  maxRecipients: number;
}

export interface ClaimedPushCampaign {
  id: string;
  status: PushCampaignStatus;
}

export interface PushTokenBinding {
  token: string;
  platform: 'android' | 'ios';
  tokenHash: string;
  updatedAt: string;
}

export interface ClaimedPushRecipient {
  campaignId: string;
  userId: string;
  title: string;
  body: string;
  path: string;
  data: Record<string, string>;
  tokens: PushTokenBinding[];
  skipReason: string | null;
}

export interface ResolvedPushRecipient {
  tokens: PushTokenBinding[];
  skipReason: string | null;
}

export interface ValidatedPushToken {
  valid: boolean;
  skipReason: string | null;
  platform: 'android' | 'ios' | null;
}

export interface FinishPushRecipientInput {
  campaignId: string;
  userId: string;
  workerId: string;
  outcome: PushRecipientOutcome;
  reason: string;
  platform?: 'android' | 'ios' | null;
  tokenHash?: string | null;
}

export interface PushCampaignStore {
  configured: boolean;
  /** All nonterminal campaigns plus at most `terminalLimit` recent history rows. */
  listCampaigns(terminalLimit: number): Promise<PushCampaign[]>;
  getCampaign(id: string): Promise<PushCampaign | null>;
  getWorkerStatus(maxAgeMs?: number): Promise<PushWorkerStatus>;
  upsertDraft(input: UpsertPushCampaignInput, actor: string): Promise<PushCampaign>;
  prepareCampaign(id: string, expectedRevision: number, commandId: string, actor: string): Promise<PushCampaign>;
  queueCampaign(input: QueuePushCampaignInput, actor: string): Promise<PushCampaign>;
  cancelCampaign(id: string, expectedRevision: number, commandId: string, actor: string): Promise<PushCampaign>;
  heartbeatWorker(input: {
    workerId: string;
    enabled: boolean;
    healthy: boolean;
    lastError?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  claimDueCampaign(workerId: string, leaseSeconds: number): Promise<ClaimedPushCampaign | null>;
  heartbeatCampaign(campaignId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  recoverStaleRecipients(campaignId: string, workerId: string): Promise<number>;
  claimRecipients(
    campaignId: string,
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
  ): Promise<ClaimedPushRecipient[]>;
  resolveRecipient(
    campaignId: string,
    userId: string,
    workerId: string,
  ): Promise<ResolvedPushRecipient>;
  validateToken(input: {
    campaignId: string;
    userId: string;
    workerId: string;
    token: string;
    tokenHash: string;
    updatedAt: string;
  }): Promise<ValidatedPushToken>;
  finishRecipient(input: FinishPushRecipientInput): Promise<boolean>;
  pruneUnregisteredToken(input: {
    userId: string;
    token: string;
    tokenHash: string;
    updatedAt: string;
  }): Promise<boolean>;
  finalizeCampaign(campaignId: string, workerId: string): Promise<PushCampaign>;
  failCampaign(campaignId: string, workerId: string, reason: string): Promise<void>;
}

export class PushStoreError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_state'
      | 'confirmation_mismatch'
      | 'audience_too_large'
      | 'validation'
      | 'conflict'
      | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'PushStoreError';
  }
}

type JsonObject = Record<string, unknown>;

const CAMPAIGN_SELECT = [
  'id',
  'revision',
  'dedup_key',
  'title',
  'body',
  'path',
  'audience_mode',
  'consent_basis',
  'status',
  'scheduled_at',
  'created_at',
  'audience_prepared_at',
  'started_at',
  'completed_at',
  'audience_count',
  'audience_candidate_tokens',
  'max_recipients',
  'audience_exclusions',
  'audience_digest',
  'payload_hash',
  'accepted_count',
  'skipped_count',
  'failed_count',
  'unknown_count',
  'cancelled_count',
  'created_by',
  'updated_at',
].join(',');

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function stringField(row: JsonObject, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

function nullableString(row: JsonObject, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function exclusionsField(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const publicNames: Record<string, string> = {
    mobile_token_users: 'mobileTokenUsers',
    eligible_users: 'eligibleUsers',
    candidate_tokens: 'candidateTokens',
    ios_tokens: 'iosTokens',
    android_tokens: 'androidTokens',
    missing_profile: 'missingProfile',
    missing_auth: 'missingAuth',
    deleted: 'deleted',
    banned: 'banned',
    explicit_opt_out: 'explicitOptOut',
    missing_opt_in: 'missingOptIn',
    invalid_preference: 'invalidPreference',
    no_mobile_token: 'noMobileToken',
  };
  const safe: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    const publicName = publicNames[key];
    if (publicName) safe[publicName] = nonNegativeInt(count);
  }
  return safe;
}

function campaignFromRow(row: JsonObject): PushCampaign {
  const audienceMode = stringField(row, 'audience_mode');
  const status = stringField(row, 'status');
  if (!PUSH_AUDIENCE_MODES.includes(audienceMode as PushAudienceMode)) {
    throw new PushStoreError('unavailable', 'Campaign has an unsupported audience mode');
  }
  if (!PUSH_CAMPAIGN_STATUSES.includes(status as PushCampaignStatus)) {
    throw new PushStoreError('unavailable', 'Campaign has an unsupported status');
  }
  return {
    id: stringField(row, 'id'),
    revision: nonNegativeInt(row.revision),
    dedupKey: stringField(row, 'dedup_key'),
    title: stringField(row, 'title'),
    body: stringField(row, 'body'),
    path: stringField(row, 'path'),
    audienceMode: audienceMode as PushAudienceMode,
    consentBasis: nullableString(row, 'consent_basis'),
    status: status as PushCampaignStatus,
    scheduledAt: nullableString(row, 'scheduled_at'),
    createdAt: stringField(row, 'created_at'),
    preparedAt: nullableString(row, 'audience_prepared_at'),
    startedAt: nullableString(row, 'started_at'),
    completedAt: nullableString(row, 'completed_at'),
    eligibleUsers: nonNegativeInt(row.audience_count),
    candidateTokens: nonNegativeInt(row.audience_candidate_tokens),
    maxRecipients: row.max_recipients == null ? null : nonNegativeInt(row.max_recipients),
    exclusions: exclusionsField(row.audience_exclusions),
    audienceDigest: nullableString(row, 'audience_digest'),
    payloadHash: stringField(row, 'payload_hash'),
    accepted: nonNegativeInt(row.accepted_count),
    skipped: nonNegativeInt(row.skipped_count),
    failed: nonNegativeInt(row.failed_count),
    unknown: nonNegativeInt(row.unknown_count),
    cancelledCount: nonNegativeInt(row.cancelled_count),
    createdBy: stringField(row, 'created_by'),
    updatedAt: stringField(row, 'updated_at'),
  };
}

function tokensFromValue(value: unknown): PushTokenBinding[] {
  if (!Array.isArray(value)) return [];
  const tokens: PushTokenBinding[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as JsonObject;
    const token = stringField(row, 'token');
    const platform = stringField(row, 'platform');
    const tokenHash = stringField(row, 'token_hash');
    const updatedAt = stringField(row, 'updated_at');
    if (
      token &&
      token.length <= 8192 &&
      (platform === 'android' || platform === 'ios') &&
      /^[a-f0-9]{64}$/i.test(tokenHash) &&
      Number.isFinite(Date.parse(updatedAt))
    ) {
      tokens.push({ token, platform, tokenHash: tokenHash.toLowerCase(), updatedAt });
    }
  }
  return tokens;
}

function dataFromValue(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const data: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^[a-zA-Z0-9_.-]{1,64}$/.test(key) && typeof item === 'string') data[key] = item;
  }
  return data;
}

function recipientFromRow(row: JsonObject): ClaimedPushRecipient {
  return {
    campaignId: stringField(row, 'campaign_id'),
    userId: stringField(row, 'user_id'),
    title: stringField(row, 'title'),
    body: stringField(row, 'body'),
    path: stringField(row, 'path'),
    data: dataFromValue(row.data),
    tokens: tokensFromValue(row.tokens),
    skipReason: nullableString(row, 'skip_reason'),
  };
}

function createNoopStore(): PushCampaignStore {
  const unavailable = async (): Promise<never> => {
    throw new PushStoreError('unavailable', 'Push campaign storage is not configured');
  };
  return {
    configured: false,
    listCampaigns: async () => [],
    getCampaign: async () => null,
    getWorkerStatus: async () => ({ enabled: false, healthy: false }),
    upsertDraft: unavailable,
    prepareCampaign: unavailable,
    queueCampaign: unavailable,
    cancelCampaign: unavailable,
    heartbeatWorker: async () => unavailable(),
    claimDueCampaign: unavailable,
    heartbeatCampaign: unavailable,
    recoverStaleRecipients: unavailable,
    claimRecipients: unavailable,
    resolveRecipient: unavailable,
    validateToken: unavailable,
    finishRecipient: unavailable,
    pruneUnregisteredToken: unavailable,
    finalizeCampaign: unavailable,
    failCampaign: async () => unavailable(),
  };
}

export function createPushCampaignStore(cfg: SupabaseConfig): PushCampaignStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  async function pgFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const request = fetch(`${url}/rest/v1/${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...authHeaders(serviceRoleKey),
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    return withTimeout(
      request,
      timeoutMs,
      `pushCampaignStore ${init.method ?? 'GET'}`,
      controller,
    );
  }

  async function responseBody(res: Response): Promise<unknown> {
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  async function checked(res: Response): Promise<unknown> {
    const body = await responseBody(res);
    if (res.ok) return body;
    const object = body && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject) : {};
    const message = typeof object.message === 'string' ? object.message : '';
    const detail = typeof object.details === 'string' ? object.details : '';
    const combined = `${message} ${detail}`.toLowerCase();
    const sqlCode = typeof object.code === 'string' ? object.code : '';
    if (sqlCode === 'P4040' || res.status === 404 || combined.includes('not found')) {
      throw new PushStoreError('not_found', 'Campaign not found');
    }
    if (combined.includes('confirmation') || combined.includes('digest') || combined.includes('payload hash')) {
      throw new PushStoreError('confirmation_mismatch', 'Campaign confirmation no longer matches');
    }
    if (sqlCode === 'P4221' || combined.includes('max_recipients') || combined.includes('audience cap')) {
      throw new PushStoreError('audience_too_large', 'Frozen audience exceeds the configured safety cap');
    }
    if (sqlCode === 'P4220') {
      throw new PushStoreError('validation', 'Campaign data failed server validation');
    }
    if (sqlCode === 'P4091' || sqlCode === '23505' || res.status === 409) {
      throw new PushStoreError('conflict', 'Campaign conflicts with an existing operation');
    }
    if (sqlCode === 'P4090' || sqlCode === 'P0001' || combined.includes('state') || combined.includes('status')) {
      throw new PushStoreError('invalid_state', 'Campaign state does not allow this operation');
    }
    throw new PushStoreError('unavailable', `Push campaign storage returned HTTP ${res.status}`);
  }

  async function rpc(name: string, body: JsonObject): Promise<unknown> {
    return checked(await pgFetch(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) }));
  }

  function firstRow(value: unknown): JsonObject | null {
    if (Array.isArray(value)) {
      const first = value[0];
      return first && typeof first === 'object' && !Array.isArray(first) ? (first as JsonObject) : null;
    }
    return value && typeof value === 'object' ? (value as JsonObject) : null;
  }

  async function requiredCampaign(value: unknown): Promise<PushCampaign> {
    const row = firstRow(value);
    if (!row) throw new PushStoreError('not_found', 'Campaign not found');
    return campaignFromRow(row);
  }

  async function getCampaignById(id: string): Promise<PushCampaign | null> {
    const res = await pgFetch(
      `push_campaigns?id=eq.${encodeURIComponent(id)}&select=${CAMPAIGN_SELECT}&limit=1`,
    );
    const row = firstRow(await checked(res));
    return row ? campaignFromRow(row) : null;
  }

  async function campaignRows(input: {
    statuses: PushCampaignStatus[];
    limit: number;
    before?: { createdAt: string; id: string };
  }): Promise<JsonObject[]> {
    const query = new URLSearchParams({
      select: CAMPAIGN_SELECT,
      status: `in.(${input.statuses.join(',')})`,
      order: 'created_at.desc,id.desc',
      limit: String(input.limit),
    });
    if (input.before) {
      query.set(
        'or',
        `(created_at.lt.${input.before.createdAt},and(created_at.eq.${input.before.createdAt},id.lt.${input.before.id}))`,
      );
    }
    const body = await checked(await pgFetch(`push_campaigns?${query.toString()}`));
    if (!Array.isArray(body)) {
      throw new PushStoreError('unavailable', 'Campaign list returned an invalid response');
    }
    const rows: JsonObject[] = [];
    for (const value of body) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PushStoreError('unavailable', 'Campaign list contained an invalid row');
      }
      rows.push(value as JsonObject);
    }
    return rows;
  }

  async function allNonterminalCampaignRows(): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    let before: { createdAt: string; id: string } | undefined;
    while (true) {
      // The +1 sentinel request distinguishes exactly-at-cap from truncated.
      const requestLimit = Math.min(
        CAMPAIGN_PAGE_SIZE,
        MAX_NONTERMINAL_CAMPAIGNS - rows.length + 1,
      );
      const page = await campaignRows({
        statuses: NONTERMINAL_CAMPAIGN_STATUSES,
        limit: requestLimit,
        before,
      });
      if (rows.length + page.length > MAX_NONTERMINAL_CAMPAIGNS) {
        throw new PushStoreError(
          'unavailable',
          'Nonterminal campaign safety cap exceeded',
        );
      }
      rows.push(...page);
      if (page.length < requestLimit) return rows;
      const last = page.at(-1);
      const next = last
        ? { createdAt: stringField(last, 'created_at'), id: stringField(last, 'id') }
        : null;
      if (
        !next?.id ||
        !Number.isFinite(Date.parse(next.createdAt)) ||
        (before && next.createdAt === before.createdAt && next.id === before.id)
      ) {
        throw new PushStoreError('unavailable', 'Campaign pagination cursor is invalid');
      }
      before = next;
    }
  }

  return {
    configured: true,

    async listCampaigns(terminalLimit) {
      const nonterminalRows = await allNonterminalCampaignRows();
      const terminalRows = await campaignRows({
        statuses: TERMINAL_CAMPAIGN_STATUSES,
        limit: terminalLimit,
      });
      const campaignsById = new Map<string, PushCampaign>();
      for (const row of nonterminalRows) {
        const campaign = campaignFromRow(row);
        campaignsById.set(campaign.id, campaign);
      }
      // A campaign may transition while the two reads are in flight. The later
      // terminal snapshot wins and the map prevents duplicate cabinet rows.
      for (const row of terminalRows) {
        const campaign = campaignFromRow(row);
        campaignsById.set(campaign.id, campaign);
      }
      return [...campaignsById.values()].sort((left, right) => {
        const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
        return right.id.localeCompare(left.id);
      });
    },

    getCampaign: getCampaignById,

    async getWorkerStatus(maxAgeMs = 120_000) {
      const res = await pgFetch(
        'push_worker_heartbeats?select=enabled,healthy,last_heartbeat_at&order=last_heartbeat_at.desc&limit=1',
      );
      const row = firstRow(await checked(res));
      if (!row) return { enabled: false, healthy: false };
      const lastHeartbeatAt = nullableString(row, 'last_heartbeat_at') ?? undefined;
      const fresh = !!lastHeartbeatAt && Date.now() - Date.parse(lastHeartbeatAt) <= maxAgeMs;
      return {
        enabled: row.enabled === true,
        healthy: row.enabled === true && row.healthy === true && fresh,
        ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
      };
    },

    async upsertDraft(input, actor) {
      const value = await rpc('push_campaign_upsert_draft', {
        p_command_id: input.commandId,
        p_campaign_id: input.id ?? null,
        p_expected_revision: input.expectedRevision ?? null,
        p_dedup_key: input.dedupKey,
        p_title: input.title,
        p_body: input.body,
        p_path: input.path,
        p_data: { path: input.path, kind: 'campaign' },
        p_audience_mode: input.audienceMode,
        p_consent_basis: input.consentBasis ?? null,
        p_scheduled_at: input.scheduledAt ?? null,
        p_max_recipients: input.maxRecipients,
        p_actor: actor,
        p_source: actor,
      });
      return requiredCampaign(value);
    },

    async prepareCampaign(id, expectedRevision, commandId, actor) {
      return requiredCampaign(
        await rpc('push_campaign_prepare', {
          p_campaign_id: id,
          p_expected_revision: expectedRevision,
          p_command_id: commandId,
          p_actor: actor,
          p_source: actor,
        }),
      );
    },

    async queueCampaign(input, actor) {
      const current = await getCampaignById(input.id);
      if (!current) throw new PushStoreError('not_found', 'Campaign not found');
      if (current.maxRecipients !== input.maxRecipients) {
        throw new PushStoreError('confirmation_mismatch', 'Campaign safety cap no longer matches');
      }
      if (current.eligibleUsers > input.maxRecipients) {
        throw new PushStoreError('audience_too_large', 'Frozen audience exceeds the configured safety cap');
      }
      return requiredCampaign(
        await rpc('push_campaign_queue', {
          p_campaign_id: input.id,
          p_expected_revision: input.expectedRevision,
          p_command_id: input.commandId,
          p_expected_audience_count: input.expectedEligibleUsers,
          p_expected_audience_digest: input.expectedAudienceDigest,
          p_expected_payload_hash: input.expectedPayloadHash,
          p_actor: actor,
          p_source: actor,
        }),
      );
    },

    async cancelCampaign(id, expectedRevision, commandId, actor) {
      return requiredCampaign(
        await rpc('push_campaign_cancel', {
          p_campaign_id: id,
          p_expected_revision: expectedRevision,
          p_command_id: commandId,
          p_actor: actor,
          p_source: actor,
        }),
      );
    },

    async heartbeatWorker(input) {
      await rpc('push_worker_heartbeat', {
        p_worker_id: input.workerId,
        p_enabled: input.enabled,
        p_healthy: input.healthy,
        p_last_error: input.lastError ?? null,
        p_metadata: input.metadata ?? {},
      });
    },

    async claimDueCampaign(workerId, leaseSeconds) {
      const row = firstRow(
        await rpc('push_campaign_claim_due', {
          p_worker_id: workerId,
          p_lease_seconds: leaseSeconds,
        }),
      );
      if (!row) return null;
      const status = stringField(row, 'status');
      if (!PUSH_CAMPAIGN_STATUSES.includes(status as PushCampaignStatus)) {
        throw new PushStoreError('unavailable', 'Claimed campaign has an unsupported status');
      }
      return { id: stringField(row, 'id'), status: status as PushCampaignStatus };
    },

    async heartbeatCampaign(campaignId, workerId, leaseSeconds) {
      const value = await rpc('push_campaign_heartbeat', {
        p_campaign_id: campaignId,
        p_worker_id: workerId,
        p_lease_seconds: leaseSeconds,
      });
      return value === true;
    },

    async recoverStaleRecipients(campaignId, workerId) {
      const value = await rpc('push_campaign_recover_stale', {
        p_campaign_id: campaignId,
        p_worker_id: workerId,
      });
      return nonNegativeInt(value);
    },

    async claimRecipients(campaignId, workerId, batchSize, leaseSeconds) {
      const value = await rpc('push_campaign_claim_recipients', {
        p_campaign_id: campaignId,
        p_worker_id: workerId,
        p_batch_size: batchSize,
        p_lease_seconds: leaseSeconds,
      });
      if (!Array.isArray(value)) return [];
      return value
        .filter((row): row is JsonObject => !!row && typeof row === 'object' && !Array.isArray(row))
        .map(recipientFromRow);
    },

    async resolveRecipient(campaignId, userId, workerId) {
      const row = firstRow(
        await rpc('push_campaign_resolve_recipient', {
          p_campaign_id: campaignId,
          p_user_id: userId,
          p_worker_id: workerId,
        }),
      );
      if (!row) {
        throw new PushStoreError('unavailable', 'Recipient resolution returned no result');
      }
      return {
        skipReason: nullableString(row, 'skip_reason'),
        tokens: tokensFromValue(row.tokens),
      };
    },

    async validateToken(input) {
      const row = firstRow(
        await rpc('push_campaign_validate_token', {
          p_campaign_id: input.campaignId,
          p_user_id: input.userId,
          p_worker_id: input.workerId,
          p_token: input.token,
          p_token_hash: input.tokenHash,
          p_updated_at: input.updatedAt,
        }),
      );
      if (!row) {
        throw new PushStoreError('unavailable', 'Token validation returned no result');
      }
      const platform = stringField(row, 'platform');
      return {
        valid: row.valid === true && (platform === 'android' || platform === 'ios'),
        skipReason: nullableString(row, 'skip_reason'),
        platform: platform === 'android' || platform === 'ios' ? platform : null,
      };
    },

    async finishRecipient(input) {
      const value = await rpc('push_campaign_finish_recipient', {
        p_campaign_id: input.campaignId,
        p_user_id: input.userId,
        p_worker_id: input.workerId,
        p_outcome: input.outcome,
        p_reason: input.reason,
        p_platform: input.platform ?? null,
        p_token_hash: input.tokenHash ?? null,
      });
      return value === true;
    },

    async pruneUnregisteredToken(input) {
      const value = await rpc('push_campaign_prune_unregistered_token', {
        p_user_id: input.userId,
        p_token: input.token,
        p_token_hash: input.tokenHash,
        p_updated_at: input.updatedAt,
      });
      return value === true;
    },

    async finalizeCampaign(campaignId, workerId) {
      return requiredCampaign(
        await rpc('push_campaign_finalize', {
          p_campaign_id: campaignId,
          p_worker_id: workerId,
        }),
      );
    },

    async failCampaign(campaignId, workerId, reason) {
      await rpc('push_campaign_fail', {
        p_campaign_id: campaignId,
        p_worker_id: workerId,
        p_reason: reason,
      });
    },
  };
}
