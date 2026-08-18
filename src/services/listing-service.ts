/**
 * Listing facts backed by Supabase (PostgREST), reading abkhaz-auto `listings`.
 * Powers the seller-vs-buyer signal (activeListings), the listings-targeting
 * checker (category/promotion/recency facts) and the lifecycle checker
 * (sold_at/stalled/first-listing aggregates) — one load serves all of them,
 * cached once per selection walk by `suppliers.ts`'s 60s TTL.
 *
 * Two reads run in parallel:
 *  - the row query (existing fields) — a failure still throws, as before;
 *  - the `promo_listing_stats` RPC (lifecycle aggregates) — FAIL-SOFT: while
 *    the migration is not applied (or PostgREST errors/times out) the lifecycle
 *    fields simply stay undefined, so ONLY lifecycle-targeted promos fail
 *    closed and the rest of the queue is untouched.
 *
 * Unconfigured Supabase → empty stats (everyone is a "buyer" with no listings).
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

const ROW_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Пороги «зависшего» объявления (спека targeting-lifecycle §3): активно дольше
 *  STALLED_MIN_DAYS дней и меньше STALLED_MAX_VIEWS уникальных (viewer×hour)
 *  просмотров. Передаются аргументами RPC; меняются деплоем BFF, не промо. */
export const STALLED_MIN_DAYS = 30;
export const STALLED_MAX_VIEWS = 50;

// Лайфцикл — опциональный гейт: не даём его RPC съесть общий таймаут
// getListingStats (бюджет сайта 800 мс; тот же запас, что у search/behavior).
const LIFECYCLE_RPC_TIMEOUT_MS = 300;

export interface ListingStats {
  activeListings: number;
  everCategories: string[];
  activeCategories: string[];
  hasUnpromotedActive: boolean;
  daysSinceLastListing?: number;
  /** (б) Последний переход в sold, ISO. undefined = RPC недоступен (fail closed);
   *  null = не продавал. */
  lastSoldAt?: string | null;
  /** (в) Есть активное 30+ дней с < STALLED_MAX_VIEWS просмотров. undefined = RPC недоступен. */
  hasStalledActive?: boolean;
  /** (г) Всего объявлений за историю (всё кроме draft/deleted). undefined = RPC недоступен. */
  totalListings?: number;
  /** (г) min(created_at) по тем же статусам, ISO. undefined = RPC недоступен; null = нет объявлений. */
  firstCreatedAt?: string | null;
}

export interface ListingService {
  getListingStats(userId: string): Promise<ListingStats>;
}

interface ListingRow {
  category_slug: string;
  status: string;
  promotion: string;
  promotion_until: string | null;
  created_at: string;
}

/** Lifecycle-срез RPC promo_listing_stats; active_count/active_categories из
 *  того же ответа игнорируются намеренно — их источником остаётся row-запрос
 *  (единый с Seller/Listings-чекерами, без второго источника правды). */
interface LifecycleRpcRow {
  last_sold_at?: unknown;
  has_stalled_active?: unknown;
  total_count?: unknown;
  first_created_at?: unknown;
}

type LifecycleStats = Pick<ListingStats, 'lastSoldAt' | 'hasStalledActive' | 'totalListings' | 'firstCreatedAt'>;

const EMPTY_STATS: ListingStats = {
  activeListings: 0,
  everCategories: [],
  activeCategories: [],
  hasUnpromotedActive: false,
  daysSinceLastListing: undefined,
};

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** Pure aggregation over one user's listing rows — exported for direct unit testing (no fetch mocking needed). */
export function computeStats(rows: ListingRow[], nowMs: number): ListingStats {
  if (rows.length === 0) return EMPTY_STATS;

  const everCategories = [...new Set(rows.map((r) => r.category_slug))];
  const activeRows = rows.filter((r) => r.status === 'active');
  const activeCategories = [...new Set(activeRows.map((r) => r.category_slug))];
  const hasUnpromotedActive = activeRows.some(
    (r) => r.promotion === 'none' || (r.promotion_until !== null && Date.parse(r.promotion_until) < nowMs),
  );
  const latestCreatedMs = Math.max(...rows.map((r) => Date.parse(r.created_at)));
  const daysSinceLastListing = Math.floor((nowMs - latestCreatedMs) / DAY_MS);

  return { activeListings: activeRows.length, everCategories, activeCategories, hasUnpromotedActive, daysSinceLastListing };
}

function nullableIso(v: unknown): string | null | undefined {
  if (v === null) return null;
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : undefined;
}

/** Защитный маппинг ответа RPC; кривое поле → undefined (fail closed у чекера). */
export function parseLifecycleRow(row: unknown): LifecycleStats {
  if (typeof row !== 'object' || row === null) return {};
  const r = row as LifecycleRpcRow;
  return {
    lastSoldAt: nullableIso(r.last_sold_at),
    hasStalledActive: typeof r.has_stalled_active === 'boolean' ? r.has_stalled_active : undefined,
    totalListings: typeof r.total_count === 'number' && Number.isInteger(r.total_count) ? r.total_count : undefined,
    firstCreatedAt: nullableIso(r.first_created_at),
  };
}

export function createListingService(cfg: SupabaseConfig = config.supabase): ListingService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getListingStats: async () => EMPTY_STATS };
  }
  const table = `${url}/rest/v1/listings`;
  const rpc = `${url}/rest/v1/rpc/promo_listing_stats`;

  async function fetchRowStats(userId: string): Promise<ListingStats> {
    const qs = new URLSearchParams({
      user_id: `eq.${userId}`,
      select: 'category_slug,status,promotion,promotion_until,created_at',
      order: 'created_at.desc',
      limit: String(ROW_LIMIT),
    });
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`listing-service read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as ListingRow[];
    return computeStats(rows, Date.now());
  }

  async function fetchLifecycle(userId: string, controller: AbortController): Promise<LifecycleStats> {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        p_user_id: userId,
        p_stalled_min_days: STALLED_MIN_DAYS,
        p_stalled_max_views: STALLED_MAX_VIEWS,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`listing-service lifecycle rpc failed: HTTP ${res.status}`);
    const body: unknown = await res.json();
    return parseLifecycleRow(Array.isArray(body) ? body[0] : body);
  }

  async function getListingStats(userId: string): Promise<ListingStats> {
    const controller = new AbortController();
    const [rowStats, lifecycle] = await Promise.all([
      fetchRowStats(userId),
      // Fail-soft: пока миграция promo_listing_stats не применена (404) или
      // PostgREST/таймаут падают, lifecycle-поля остаются undefined — fail
      // closed только у lifecycle-таргетированных промо, без error-envelope.
      withTimeout(
        fetchLifecycle(userId, controller),
        Math.min(timeoutMs, LIFECYCLE_RPC_TIMEOUT_MS),
        'listingService.lifecycleRpc',
        controller,
      ).catch(() => ({}) as LifecycleStats),
    ]);
    return { ...rowStats, ...lifecycle };
  }

  return {
    getListingStats: (userId) =>
      withTimeout(getListingStats(userId), timeoutMs, 'listingService.getListingStats'),
  };
}
