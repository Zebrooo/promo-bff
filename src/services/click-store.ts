/**
 * Per-user click store backed by Supabase (PostgREST) — зеркало impression-store.
 * Таблица: public.promo_clicks(user_id, promo_id, kind, count, last_click_at,
 * PK (user_id, promo_id, kind)); запись — атомарный RPC record_promo_click.
 * Чекеры читают только НАЛИЧИЕ клика (count > 0); kind'ы схлопываются суммой,
 * так что «конверсионная» строка суппрессит промо наравне с cta.
 * Без Supabase-конфига деградирует в no-op (dev/tests).
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export type ClickKind = 'cta' | 'conversion' | 'lead';

export interface ClickData {
  /** promoId -> суммарные клики этого пользователя (все kind'ы). */
  counts: Record<string, number>;
}

export interface ClickStore {
  getClicks(userId: string): Promise<ClickData>;
  /** Atomically increment count and bump last_click_at to "now". */
  recordClick(userId: string, promoId: string, kind: ClickKind): Promise<void>;
}

interface ClickRow {
  promo_id: string;
  count: number | null;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** No-op store used when Supabase isn't configured (dev/tests). */
function createNoopStore(): ClickStore {
  return {
    getClicks: async () => ({ counts: {} }),
    recordClick: async () => {},
  };
}

export function createClickStore(cfg: SupabaseConfig = config.supabase): ClickStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  const table = `${url}/rest/v1/promo_clicks`;
  const rpc = `${url}/rest/v1/rpc/record_promo_click`;

  async function getClicks(userId: string): Promise<ClickData> {
    const qs = `user_id=eq.${encodeURIComponent(userId)}&select=promo_id,count`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`click-store read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as ClickRow[];
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (typeof row.count === 'number') counts[row.promo_id] = (counts[row.promo_id] ?? 0) + row.count;
    }
    return { counts };
  }

  async function recordClick(userId: string, promoId: string, kind: ClickKind): Promise<void> {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json' },
      body: JSON.stringify({ p_user_id: userId, p_promo_id: promoId, p_kind: kind }),
    });
    if (!res.ok) throw new Error(`click-store write failed: HTTP ${res.status}`);
  }

  return {
    getClicks: (userId) => withTimeout(getClicks(userId), timeoutMs, 'clickStore.getClicks'),
    recordClick: (userId, promoId, kind) =>
      withTimeout(recordClick(userId, promoId, kind), timeoutMs, 'clickStore.recordClick'),
  };
}
