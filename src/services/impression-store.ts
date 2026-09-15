/**
 * Per-user impression store backed by Supabase (PostgREST). Owns the single
 * source of truth for frequency: how many times a user has seen each promo
 * (count, drives the optional limit checker), when they last saw it
 * (last_shown_at, drives the cooldown checkers) and on what device
 * (last_device, drives CooldownSelfChecker's same-device match).
 *
 * Table: public.promo_impressions(user_id text, promo_id text, count int,
 *        last_shown_at timestamptz, last_device text, primary key (user_id, promo_id)).
 * Writes go through the atomic RPC record_promo_impression(p_user_id, p_promo_id, p_device)
 * which does `count = count + 1, last_shown_at = now(), last_device = coalesce(p_device, last_device)`
 * in one statement. `p_device` is the RPC's third, optional parameter — a call
 * without it (older callers, tests) stays a plain two-argument call.
 *
 * When Supabase is not configured (empty url/key) this degrades to a no-op store
 * so local/dev and unit tests run without a backend.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export type ImpressionDevice = 'desktop' | 'touch' | 'app';
const IMPRESSION_DEVICES: ReadonlySet<string> = new Set(['desktop', 'touch', 'app']);

/** Три класса устройства сайта (те же, что params.device select-promo); всё иное — undefined. */
export function parseImpressionDevice(value: unknown): ImpressionDevice | undefined {
  return typeof value === 'string' && IMPRESSION_DEVICES.has(value) ? (value as ImpressionDevice) : undefined;
}

export interface ImpressionData {
  /** promoId -> times seen by this user. */
  counts: Record<string, number>;
  /** promoId -> ISO-8601 timestamp of this user's most recent view. */
  lastShownAt: Record<string, string>;
  /** promoId -> устройство последнего показа; строки без last_device отсутствуют. */
  lastDevice?: Record<string, string>;
}

export interface ImpressionStore {
  getImpressions(userId: string): Promise<ImpressionData>;
  /** Atomically increment count, bump last_shown_at and remember the device. */
  recordImpression(userId: string, promoId: string, device?: ImpressionDevice): Promise<void>;
}

interface ImpressionRow {
  promo_id: string;
  count: number | null;
  last_shown_at: string | null;
  last_device?: string | null;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** No-op store used when Supabase isn't configured (dev/tests). */
function createNoopStore(): ImpressionStore {
  return {
    getImpressions: async () => ({ counts: {}, lastShownAt: {} }),
    recordImpression: async () => {},
  };
}

export function createImpressionStore(cfg: SupabaseConfig = config.supabase): ImpressionStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  const table = `${url}/rest/v1/promo_impressions`;
  const rpc = `${url}/rest/v1/rpc/record_promo_impression`;

  async function getImpressions(userId: string): Promise<ImpressionData> {
    const qs = `user_id=eq.${encodeURIComponent(userId)}&select=promo_id,count,last_shown_at,last_device`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`impression-store read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as ImpressionRow[];
    const counts: Record<string, number> = {};
    const lastShownAt: Record<string, string> = {};
    const lastDevice: Record<string, string> = {};
    for (const row of rows) {
      if (typeof row.count === 'number') counts[row.promo_id] = row.count;
      if (row.last_shown_at) lastShownAt[row.promo_id] = row.last_shown_at;
      if (row.last_device) lastDevice[row.promo_id] = row.last_device;
    }
    return { counts, lastShownAt, lastDevice };
  }

  async function recordImpression(userId: string, promoId: string, device?: ImpressionDevice): Promise<void> {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json' },
      // Без устройства вызов остаётся двухаргументным — миграция сайта с
      // default для p_device (третий параметр RPC) закрывает окно выката.
      body: JSON.stringify({ p_user_id: userId, p_promo_id: promoId, ...(device ? { p_device: device } : {}) }),
    });
    if (!res.ok) throw new Error(`impression-store write failed: HTTP ${res.status}`);
  }

  return {
    getImpressions: (userId) =>
      withTimeout(getImpressions(userId), timeoutMs, 'impressionStore.getImpressions'),
    recordImpression: (userId, promoId, device) =>
      withTimeout(recordImpression(userId, promoId, device), timeoutMs, 'impressionStore.recordImpression'),
  };
}
