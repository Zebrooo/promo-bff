/**
 * UX-event writer backed by abkhaz-auto Supabase. Owns INSERT'ы в
 * public.user_action_events (миграция 0063 на abkhaz-auto Supabase).
 *
 * Принимает уже отвалидированные/sanitized данные от POST /events handler.
 * Каждый вызов — отдельный row; пакетной записи не нужно, event-беакон в
 * cabinet'е приходит по одному.
 *
 * Same pattern as impression-store: raw fetch, no SDK, no-op fallback когда
 * Supabase не сконфигурен (dev/тесты). Использует AA-supabase config, не
 * promo-supabase — таблица живёт в abkhaz-auto deployment.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface EventPayload {
  /** Уже trimmed/length-limited на cabinet side. */
  eventName: string;
  /** Произвольный jsonb. Обязательное поле в таблице — пустой объект, не null. */
  props: Record<string, unknown>;
  pagePath: string | null;
  sessionId: string | null;
  /** Authenticated user.id из cookie (cabinet проксирует), либо null для анона. */
  userId: string | null;
  userAgent: string | null;
}

export interface EventStore {
  /** INSERT one row. Throws on non-2xx HTTP — caller maps to 502. */
  recordEvent(payload: EventPayload): Promise<void>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** No-op store used when AA Supabase isn't configured (dev/tests). */
function createNoopStore(): EventStore {
  return {
    recordEvent: async () => {},
  };
}

export function createEventStore(cfg: SupabaseConfig = config.aaSupabase): EventStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  const table = `${url}/rest/v1/user_action_events`;

  async function recordEvent(payload: EventPayload): Promise<void> {
    // PostgREST direct INSERT. Prefer: return=minimal — не нужен response body.
    const res = await fetch(table, {
      method: 'POST',
      headers: {
        ...authHeaders(serviceRoleKey),
        'content-type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        event_name: payload.eventName,
        props: payload.props,
        page_path: payload.pagePath,
        session_id: payload.sessionId,
        user_id: payload.userId,
        user_agent: payload.userAgent,
      }),
    });
    if (!res.ok) throw new Error(`event-store write failed: HTTP ${res.status}`);
  }

  return {
    recordEvent: (payload) =>
      withTimeout(recordEvent(payload), timeoutMs, 'eventStore.recordEvent'),
  };
}
