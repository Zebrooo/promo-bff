/**
 * Per-viewer feed-ad frequency counts, backed by the supabase-aa RPC
 * get_feed_view_counts (reads banner_view_events). Powers the /feed-fill
 * frequency cap: how many times THIS viewer has seen each campaign in the
 * rolling hour and rolling day. Mirrors charge-service / impression-store:
 * no-op when Supabase is unconfigured (dev/tests), and only a real HTTP/
 * connection failure throws (the handler then fails soft — no cap, never a
 * blocked feed).
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface FeedViewCounts {
  /** "campaign:<id>" -> views by this viewer in the last hour. */
  hour: Record<string, number>;
  /** "campaign:<id>" -> views by this viewer in the last day. */
  day: Record<string, number>;
}

export interface FeedFrequencyService {
  /** Per-campaign view counts for this viewer in the rolling hour + day. */
  getViewCounts(viewerKey: string): Promise<FeedViewCounts>;
}

interface CountRow {
  campaign_id: number;
  hour_views: number | string;
  day_views: number | string;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** No-op store (Supabase unconfigured): empty counts → the cap is a no-op. */
function createNoopService(): FeedFrequencyService {
  return { getViewCounts: async () => ({ hour: {}, day: {} }) };
}

export function createFeedFrequencyService(cfg: SupabaseConfig = config.supabase): FeedFrequencyService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopService();
  const rpc = `${url}/rest/v1/rpc/get_feed_view_counts`;

  async function getViewCounts(viewerKey: string): Promise<FeedViewCounts> {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json' },
      body: JSON.stringify({ p_viewer_key: viewerKey }),
    });
    if (!res.ok) throw new Error(`feed-frequency read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as CountRow[];
    const hour: Record<string, number> = {};
    const day: Record<string, number> = {};
    for (const r of rows) {
      const key = `campaign:${r.campaign_id}`;
      hour[key] = Number(r.hour_views) || 0;
      day[key] = Number(r.day_views) || 0;
    }
    return { hour, day };
  }

  return {
    getViewCounts: (viewerKey) =>
      withTimeout(getViewCounts(viewerKey), timeoutMs, 'feedFrequencyService.getViewCounts'),
  };
}
