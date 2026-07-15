/**
 * Mirrors the cabinet's `referral-invite` custom promo into abkhaz-auto
 * Supabase's `referral_config` singleton (id=1).
 *
 * The cabinet only persists promos to its own S3 pool (no creds for
 * abkhaz-Supabase); it POSTs the promo's referral fields here (via
 * POST /referral-config/sync) whenever it saves a `format:'custom',
 * variant:'referral-invite'` promo. This service does the actual upsert
 * using the AA service-role key.
 *
 * Idempotent: PostgREST upsert via `Prefer: resolution=merge-duplicates` +
 * `on_conflict=id` — replaying the same sync (retry, or an admin re-saving
 * unchanged values) is a no-op beyond overwriting the row with itself.
 * `id` is always 1 (schema is a hard singleton per the ТЗ), so there is
 * never a create-vs-update branch to get wrong.
 *
 * Same pattern as event-store/error-store: raw fetch, no SDK, no-op
 * fallback when AA Supabase isn't configured (dev/tests).
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface ReferralConfigPayload {
  active: boolean;
  /** Kopecks — mirrors abkhaz's price_kopecks convention. */
  inviterCreditKopecks: number;
  sellerBonusKopecks: number;
  dailyInviteCap: number;
  holdHours: number;
}

export interface ReferralConfigService {
  /** Upsert id=1. Throws on non-2xx HTTP — caller decides how to handle
   *  (best-effort at the route level: logged, never surfaced as a 5xx to
   *  the cabinet's own promo save, which already succeeded in S3). */
  sync(payload: ReferralConfigPayload): Promise<void>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** No-op store used when AA Supabase isn't configured (dev/tests). */
function createNoopService(): ReferralConfigService {
  return { sync: async () => {} };
}

export function createReferralConfigService(cfg: SupabaseConfig = config.aaSupabase): ReferralConfigService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopService();

  const table = `${url}/rest/v1/referral_config`;

  async function sync(p: ReferralConfigPayload): Promise<void> {
    const res = await fetch(`${table}?on_conflict=id`, {
      method: 'POST',
      headers: {
        ...authHeaders(serviceRoleKey),
        'content-type': 'application/json',
        // merge-duplicates = UPSERT on the on_conflict target; return=minimal
        // — the caller doesn't need the row back.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: 1,
        active: p.active,
        inviter_credit_kopecks: p.inviterCreditKopecks,
        seller_bonus_kopecks: p.sellerBonusKopecks,
        daily_invite_cap: p.dailyInviteCap,
        hold_hours: p.holdHours,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`referral-config-service sync failed: HTTP ${res.status}`);
  }

  return {
    sync: (p) => withTimeout(sync(p), timeoutMs, 'referralConfigService.sync'),
  };
}
