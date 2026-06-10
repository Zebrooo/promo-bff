/**
 * Listing facts backed by Supabase (PostgREST), reading abkhaz-auto `listings`.
 * Powers the seller-vs-buyer signal: how many active listings a user has.
 *
 * Uses PostgREST's exact-count header so we get the total without fetching rows.
 * Unconfigured Supabase → 0 (everyone is a "buyer"); a query failure throws.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface ListingStats {
  activeListings: number;
}

export interface ListingService {
  getListingStats(userId: string): Promise<ListingStats>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** Parse PostgREST Content-Range ("0-0/42" or "*\/0") into a total. */
function totalFromContentRange(header: string | null): number {
  if (!header) return 0;
  const total = Number(header.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

export function createListingService(cfg: SupabaseConfig = config.supabase): ListingService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getListingStats: async () => ({ activeListings: 0 }) };
  }
  const table = `${url}/rest/v1/listings`;

  async function getListingStats(userId: string): Promise<ListingStats> {
    const qs = `user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=id&limit=1`;
    const res = await fetch(`${table}?${qs}`, {
      headers: { ...authHeaders(serviceRoleKey), Prefer: 'count=exact' },
    });
    if (!res.ok) throw new Error(`listing-service read failed: HTTP ${res.status}`);
    // Drain the body so the connection is reusable; we only need the count header.
    await res.json().catch(() => undefined);
    return { activeListings: totalFromContentRange(res.headers.get('content-range')) };
  }

  return {
    getListingStats: (userId) =>
      withTimeout(getListingStats(userId), timeoutMs, 'listingService.getListingStats'),
  };
}
