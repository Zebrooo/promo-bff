/**
 * Batch-reads advertiser wallet balances from supabase-aa `ledger_accounts`
 * (B2C auction sub-project 3). A user's wallet is the kind='liability' row with
 * owner_user_id = <userId>, carrying a denormalized balance_kopecks (SP1 ledger).
 * Service-role read bypasses RLS. Unconfigured Supabase yields an empty map;
 * empty input skips the query; only a real HTTP/connection failure throws (the
 * auction handler treats that as fail-soft: all candidates insolvent).
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

// Same cap as purchase-ledger-service.ts's TIMEOUT_MS: the storefront's
// select-promo walk runs this read inside a Promise.all alongside the ledger
// reads (loadWalletDataForSelection), budgeted against an ~800ms selection
// deadline — the general cfg.timeoutMs (2500ms default) would blow that
// budget on a slow/hanging Supabase response. auction/feed-fill share this
// same factory and table and have no documented looser budget, so the cap
// applies uniformly rather than only to the select-promo call site.
const TIMEOUT_MS = 300;

export interface BalanceService {
  /** advertiserId -> balance_kopecks. Advertisers with no wallet row are absent. */
  getBalances(advertiserIds: string[]): Promise<Map<string, number>>;
}

interface AccountRow {
  owner_user_id: string;
  // Bug 3 fix: PostgREST serialises bigint/numeric as JSON strings to avoid JS
  // precision loss. We accept string | number here and coerce at the mapping
  // boundary so all downstream arithmetic (solvency check, budget comparisons)
  // always operates on JS numbers, not strings.
  balance_kopecks: number | string;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export function createBalanceService(cfg: SupabaseConfig = config.supabase): BalanceService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getBalances: async () => new Map() };
  }
  const budget = Math.min(timeoutMs, TIMEOUT_MS);
  const table = `${url}/rest/v1/ledger_accounts`;

  async function getBalances(advertiserIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (advertiserIds.length === 0) return out;
    const list = advertiserIds.map((id) => encodeURIComponent(id)).join(',');
    const qs = `kind=eq.liability&owner_user_id=in.(${list})&select=owner_user_id,balance_kopecks`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`balance-service read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as AccountRow[];
    for (const row of rows) {
      const kopecks = Number(row.balance_kopecks);
      // Guard against corrupted rows (NaN would break solvency arithmetic).
      out.set(row.owner_user_id, Number.isNaN(kopecks) ? 0 : kopecks);
    }
    return out;
  }

  return {
    getBalances: (ids) => withTimeout(getBalances(ids), budget, 'balanceService.getBalances'),
  };
}
