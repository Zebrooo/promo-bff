/**
 * Bills a campaign impression by calling the supabase-aa RPC
 * record_campaign_impression (B2C auction sub-project 4), which does the
 * cumulative-owed CPM charge + budget pacing atomically in Postgres. Mirrors
 * impression-store: no-op when Supabase is unconfigured; only a real HTTP/
 * connection failure throws (the /impressions handler maps that to 502).
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface ChargeService {
  /** Record + bill one campaign impression (atomic, in Postgres). */
  recordCampaignImpression(campaignId: number, userId: string): Promise<void>;
}

/** "campaign:<digits>" -> the numeric id; anything else -> null. */
export function parseCampaignId(promoId: string): number | null {
  const m = /^campaign:(\d+)$/.exec(promoId);
  return m ? Number(m[1]) : null;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export function createChargeService(cfg: SupabaseConfig = config.aaSupabase): ChargeService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { recordCampaignImpression: async () => {} };
  }
  const rpc = `${url}/rest/v1/rpc/record_campaign_impression`;

  async function recordCampaignImpression(
    campaignId: number,
    userId: string,
    signal: AbortSignal,
  ): Promise<void> {
    // signal is wired to the AbortController passed into withTimeout; if the BFF
    // deadline fires, the in-flight Supabase HTTP request is cancelled here,
    // preventing the slow-RPC double-charge (Bug 1 fix).
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json' },
      body: JSON.stringify({ p_campaign_id: campaignId, p_user_id: userId }),
      signal,
    });
    if (!res.ok) throw new Error(`charge-service write failed: HTTP ${res.status}`);
  }

  return {
    recordCampaignImpression: (campaignId, userId) => {
      const controller = new AbortController();
      return withTimeout(
        recordCampaignImpression(campaignId, userId, controller.signal),
        timeoutMs,
        'chargeService.recordCampaignImpression',
        controller,
      );
    },
  };
}
