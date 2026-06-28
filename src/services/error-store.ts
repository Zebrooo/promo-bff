import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';
import { fingerprint } from './fingerprint';

export interface ErrorPayload {
  service: string;
  environment?: string;
  level?: string;
  source: string;
  message: string;
  errorType?: string | null;
  stack?: string | null;
  release?: string | null;
  route?: string | null;
  method?: string | null;
  statusCode?: number | null;
  userId?: string | null;
  sessionId?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown>;
}

export interface ErrorStore {
  recordError(payload: ErrorPayload): Promise<void>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function createNoopStore(): ErrorStore {
  return { recordError: async () => {} };
}

export function createErrorStore(cfg: SupabaseConfig = config.aaSupabase): ErrorStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();
  const table = `${url}/rest/v1/error_events`;

  async function recordError(p: ErrorPayload): Promise<void> {
    const res = await fetch(table, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        service: p.service,
        environment: p.environment ?? 'production',
        level: p.level ?? 'error',
        source: p.source,
        message: p.message,
        error_type: p.errorType ?? null,
        stack: p.stack ?? null,
        fingerprint: fingerprint(p.message, p.stack, p.errorType),
        release: p.release ?? null,
        route: p.route ?? null,
        method: p.method ?? null,
        status_code: p.statusCode ?? null,
        user_id: p.userId ?? null,
        session_id: p.sessionId ?? null,
        user_agent: p.userAgent ?? null,
        context: p.context ?? {},
      }),
    });
    if (!res.ok) throw new Error(`error-store write failed: HTTP ${res.status}`);
  }

  return {
    recordError: (p) => withTimeout(recordError(p), timeoutMs, 'errorStore.recordError'),
  };
}
