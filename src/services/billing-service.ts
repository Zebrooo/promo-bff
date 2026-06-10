/**
 * Billing client backed by Supabase (PostgREST), reading abkhaz-auto `profiles`.
 *
 *   level ← profiles.is_pro: true → 'plus' (PRO), false/missing → 'none'.
 *
 * abkhaz-auto has a single paid tier (PRO); 'premium' is unused for now. Missing
 * row and unconfigured Supabase yield 'none'; only a query failure throws.
 */
import type { SubscriptionLevel } from '../promo-selector/types';
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface Subscription {
  level: SubscriptionLevel;
}

export interface BillingService {
  getSubscription(userId: string): Promise<Subscription>;
}

interface ProRow {
  is_pro: boolean | null;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export function createBillingService(cfg: SupabaseConfig = config.supabase): BillingService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getSubscription: async () => ({ level: 'none' }) };
  }
  const table = `${url}/rest/v1/profiles`;

  async function getSubscription(userId: string): Promise<Subscription> {
    const qs = `id=eq.${encodeURIComponent(userId)}&select=is_pro&limit=1`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`billing-service read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as ProRow[];
    return { level: rows[0]?.is_pro ? 'plus' : 'none' };
  }

  return {
    getSubscription: (userId) =>
      withTimeout(getSubscription(userId), timeoutMs, 'billingService.getSubscription'),
  };
}
