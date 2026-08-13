/**
 * Listing facts backed by Supabase (PostgREST), reading abkhaz-auto `listings`.
 * Powers the seller-vs-buyer signal (activeListings) and the listings-targeting
 * checker (category/promotion/recency facts) — one row-level query serves both,
 * cached once per selection walk by `suppliers.ts`'s 60s TTL.
 *
 * Unconfigured Supabase → empty stats (everyone is a "buyer" with no listings);
 * a query failure throws.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

const ROW_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ListingStats {
  activeListings: number;
  everCategories: string[];
  activeCategories: string[];
  hasUnpromotedActive: boolean;
  daysSinceLastListing?: number;
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

export function createListingService(cfg: SupabaseConfig = config.supabase): ListingService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getListingStats: async () => EMPTY_STATS };
  }
  const table = `${url}/rest/v1/listings`;

  async function getListingStats(userId: string): Promise<ListingStats> {
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

  return {
    getListingStats: (userId) =>
      withTimeout(getListingStats(userId), timeoutMs, 'listingService.getListingStats'),
  };
}
