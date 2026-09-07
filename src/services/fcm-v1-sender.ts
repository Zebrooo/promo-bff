import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

export interface FcmNotification {
  title: string;
  body: string;
  path: string;
  data?: Record<string, string>;
}

export type FcmSendResult =
  | { kind: 'accepted' }
  | { kind: 'unregistered' }
  | { kind: 'failed'; reason: string; fatal: boolean }
  | { kind: 'unknown'; reason: 'network_ambiguity' | 'request_timeout' };

export type FcmPrepareResult =
  | { kind: 'ready' }
  | { kind: 'unavailable'; reason: string; fatal: boolean };

export interface FcmSender {
  /** OAuth-only preflight. It never submits an FCM message. */
  prepare?(signal?: AbortSignal): Promise<FcmPrepareResult>;
  send(token: string, platform: 'android' | 'ios', message: FcmNotification, signal?: AbortSignal): Promise<FcmSendResult>;
}

class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

export async function loadFcmServiceAccount(
  filePath: string,
  expectedProjectId: string,
): Promise<FcmServiceAccount> {
  if (!filePath || !expectedProjectId) {
    throw new Error('FCM credential file and pinned project id are required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    throw new Error('FCM credential file is not readable JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FCM credential file has an invalid shape');
  }
  const account = parsed as Partial<FcmServiceAccount> & { token_uri?: unknown };
  if (
    typeof account.client_email !== 'string' ||
    !account.client_email.endsWith('.gserviceaccount.com') ||
    typeof account.private_key !== 'string' ||
    !account.private_key.includes('BEGIN PRIVATE KEY') ||
    typeof account.project_id !== 'string'
  ) {
    throw new Error('FCM credential file is missing required service-account fields');
  }
  if (account.project_id !== expectedProjectId) {
    throw new Error('FCM service-account project does not match the pinned project id');
  }
  if (account.token_uri !== undefined && account.token_uri !== GOOGLE_TOKEN_URI) {
    throw new Error('FCM service-account token endpoint is not allowed');
  }
  try {
    const key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw new Error('FCM service-account private key is invalid');
  }
  return {
    client_email: account.client_email,
    private_key: account.private_key,
    project_id: account.project_id,
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Release Undici's response stream without ever exposing or logging its body. */
async function consumeResponseBody(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // A proven HTTP status must keep its classification even if body draining
    // fails. Cancellation is the final best-effort way to release the socket.
    try {
      await response.body?.cancel();
    } catch {
      // Best effort only.
    }
  }
}

interface GoogleErrorBody {
  error?: {
    status?: unknown;
    details?: unknown;
  };
}

function fcmErrorCode(body: unknown): string | null {
  const details = (body as GoogleErrorBody | null)?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
    const code = (detail as { errorCode?: unknown }).errorCode;
    const type = (detail as { '@type'?: unknown })['@type'];
    if (
      type === 'type.googleapis.com/google.firebase.fcm.v1.FcmError' &&
      typeof code === 'string'
    ) {
      return code;
    }
  }
  return null;
}

function hasBadRequestDetail(body: unknown): boolean {
  const details = (body as GoogleErrorBody | null)?.error?.details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (detail) =>
      !!detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      (detail as { '@type'?: unknown })['@type'] ===
        'type.googleapis.com/google.rpc.BadRequest',
  );
}

function providerStatus(body: unknown): string | null {
  const value = (body as GoogleErrorBody | null)?.error?.status;
  return typeof value === 'string' ? value : null;
}

export function createFcmSender(opts: {
  serviceAccount: FcmServiceAccount;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): FcmSender {
  const { serviceAccount, requestTimeoutMs } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let cachedToken: { value: string; expiresAtMs: number } | null = null;
  let tokenRefresh: Promise<string> | null = null;

  async function requestAccessToken(signal?: AbortSignal): Promise<string> {
    const issuedAt = Math.floor(now() / 1000);
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: serviceAccount.client_email,
      scope: FCM_SCOPE,
      aud: GOOGLE_TOKEN_URI,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(serviceAccount.private_key)
      .toString('base64url');
    const assertion = `${signingInput}.${signature}`;

    const response = await fetchImpl(GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: combinedSignal(signal, requestTimeoutMs),
    });
    if (!response.ok) {
      const transient =
        response.status === 408 || response.status === 429 || response.status >= 500;
      await consumeResponseBody(response);
      throw new OAuthTokenError('oauth_rejected', !transient);
    }
    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;
    const value = body?.access_token;
    const expiresIn = Number(body?.expires_in);
    if (typeof value !== 'string' || !value || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OAuthTokenError('oauth_invalid_response', false);
    }
    cachedToken = { value, expiresAtMs: now() + expiresIn * 1000 };
    return value;
  }

  async function accessToken(signal?: AbortSignal, rejectedToken?: string): Promise<string> {
    // A prepared token must remain valid across a bounded delivery batch. This
    // avoids an avoidable OAuth refresh after recipients have already been leased.
    const cachedIsFresh = !!cachedToken && cachedToken.expiresAtMs - 10 * 60_000 > now();
    if (cachedIsFresh && rejectedToken === undefined) return cachedToken!.value;
    // Another request may already have refreshed after this caller received its
    // 401. Reuse that newer credential instead of launching N concurrent OAuth
    // exchanges for an N-wide FCM batch.
    if (cachedIsFresh && cachedToken!.value !== rejectedToken) return cachedToken!.value;
    if (rejectedToken && cachedToken?.value === rejectedToken) cachedToken = null;
    if (!tokenRefresh) {
      tokenRefresh = requestAccessToken(signal).finally(() => {
        tokenRefresh = null;
      });
    }
    return tokenRefresh;
  }

  function buildMessage(
    token: string,
    platform: 'android' | 'ios',
    message: FcmNotification,
  ): Record<string, unknown> {
    const data = {
      ...(message.data ?? {}),
      path: message.path,
      kind: 'campaign',
    };
    const common = {
      token,
      notification: { title: message.title, body: message.body },
      data,
    };
    if (platform === 'ios') {
      return {
        ...common,
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
          payload: { aps: { sound: 'default' } },
        },
      };
    }
    return {
      ...common,
      android: { priority: 'HIGH', notification: { sound: 'default' } },
    };
  }

  async function postMessage(
    bearer: string,
    token: string,
    platform: 'android' | 'ios',
    message: FcmNotification,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: buildMessage(token, platform, message) }),
        signal: combinedSignal(signal, requestTimeoutMs),
      },
    );
  }

  async function classify(response: Response): Promise<FcmSendResult> {
    if (response.ok) {
      // A 2xx proves provider acceptance. Draining is best-effort and must not
      // downgrade that accepted outcome if the response stream itself fails.
      await consumeResponseBody(response);
      return { kind: 'accepted' };
    }
    const body = await response.json().catch(() => null);
    const code = fcmErrorCode(body);
    const status = providerStatus(body);
    // Do not infer staleness from a generic HTTP 404/400. Only this typed FCM
    // detail proves that this exact registration token can be removed safely.
    if (code === 'UNREGISTERED') return { kind: 'unregistered' };
    if (code === 'SENDER_ID_MISMATCH') {
      return { kind: 'failed', reason: 'provider_token_project_mismatch', fatal: false };
    }
    // FCM uses its typed INVALID_ARGUMENT for malformed registration tokens as
    // well as google.rpc.BadRequest for malformed message fields. Neither case
    // is safe to prune as stale; only the latter is campaign-fatal.
    if (code === 'INVALID_ARGUMENT' && !hasBadRequestDetail(body)) {
      return { kind: 'failed', reason: 'provider_invalid_registration_token', fatal: false };
    }
    if (response.status === 401) {
      return { kind: 'failed', reason: 'provider_unauthorized', fatal: true };
    }
    if (status === 'PERMISSION_DENIED' || status === 'INVALID_ARGUMENT') {
      return { kind: 'failed', reason: 'provider_configuration_or_payload', fatal: true };
    }
    if (response.status === 429 || response.status >= 500) {
      // The provider explicitly rejected the request, so this is not ambiguous;
      // strict at-most-once policy still deliberately does not retry it.
      return { kind: 'failed', reason: 'provider_retryable_rejection', fatal: false };
    }
    return { kind: 'failed', reason: 'provider_rejection', fatal: response.status === 403 || response.status === 404 };
  }

  function classifyOAuthFailure(
    error: unknown,
    signal?: AbortSignal,
  ): Extract<FcmPrepareResult, { kind: 'unavailable' }> {
    if (signal?.aborted) {
      return { kind: 'unavailable', reason: 'worker_stopped_before_send', fatal: false };
    }
    if (error instanceof OAuthTokenError) {
      return { kind: 'unavailable', reason: 'oauth_rejected', fatal: error.fatal };
    }
    return {
      kind: 'unavailable',
      reason: isTimeout(error) ? 'oauth_timeout' : 'oauth_unavailable',
      fatal: false,
    };
  }

  return {
    async prepare(signal) {
      try {
        await accessToken(signal);
        return { kind: 'ready' };
      } catch (error) {
        return classifyOAuthFailure(error, signal);
      }
    },

    async send(token, platform, message, signal) {
      let bearer: string;
      try {
        bearer = await accessToken(signal);
      } catch (error) {
        const failure = classifyOAuthFailure(error, signal);
        return { kind: 'failed', reason: failure.reason, fatal: failure.fatal };
      }

      let response: Response;
      try {
        response = await postMessage(bearer, token, platform, message, signal);
      } catch (error) {
        return { kind: 'unknown', reason: isTimeout(error) ? 'request_timeout' : 'network_ambiguity' };
      }

      // A 401 is a proven rejection before FCM accepted a message. Refreshing
      // credentials and retrying the *same* token once cannot duplicate a send.
      if (response.status === 401) {
        await consumeResponseBody(response);
        try {
          bearer = await accessToken(signal, bearer);
        } catch (error) {
          const failure = classifyOAuthFailure(error, signal);
          return { kind: 'failed', reason: failure.reason, fatal: failure.fatal };
        }
        try {
          response = await postMessage(bearer, token, platform, message, signal);
        } catch (error) {
          return { kind: 'unknown', reason: isTimeout(error) ? 'request_timeout' : 'network_ambiguity' };
        }
      }
      return classify(response);
    },
  };
}
