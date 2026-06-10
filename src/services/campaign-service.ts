/**
 * Reads active advertiser campaigns for a slot from supabase-aa `ad_campaigns`
 * (B2C auction sub-project 3). Service-role PostgREST read; mirrors user-service.
 * Unconfigured Supabase (empty url/key) yields [] so local/dev and tests run
 * without a backend. Only a real HTTP/connection failure throws.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface CampaignCandidate {
  id: number;
  advertiserId: string;
  cpmKopecks: number;
  /** Raw jsonb creative; campaign-to-ad extracts the known renderable fields. */
  creative: unknown;
  /** Kopecks charged so far (SP4 charging fills this). */
  spentKopecks: number;
  /** Total budget cap in kopecks, or null for no cap. */
  totalBudgetKopecks: number | null;
  /** Targeted page keys; null/empty = all pages. */
  targetPages: string[] | null;
  /** Size-format family the creative was made for (horizontal|block|vertical). */
  bannerFormat: string | null;
}

export interface CampaignService {
  getCampaignsForSlot(slot: string): Promise<CampaignCandidate[]>;
  /** All active banner campaigns (slotless inventory for the batch auction). */
  getActiveBannerCampaigns(): Promise<CampaignCandidate[]>;
}

interface CampaignRow {
  id: number;
  advertiser_id: string;
  cpm_kopecks: number;
  creative: unknown;
  spent_kopecks: number;
  total_budget_kopecks: number | null;
  target_pages: string[] | null;
  banner_format: string | null;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

export function createCampaignService(cfg: SupabaseConfig = config.supabase): CampaignService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getCampaignsForSlot: async () => [], getActiveBannerCampaigns: async () => [] };
  }
  const table = `${url}/rest/v1/ad_campaigns`;

  const mapRow = (r: CampaignRow): CampaignCandidate => ({
    id: r.id,
    advertiserId: r.advertiser_id,
    cpmKopecks: r.cpm_kopecks,
    creative: r.creative,
    spentKopecks: r.spent_kopecks,
    totalBudgetKopecks: r.total_budget_kopecks,
    targetPages: r.target_pages,
    bannerFormat: r.banner_format,
  });

  async function getCampaignsForSlot(slot: string): Promise<CampaignCandidate[]> {
    const qs = `status=eq.active&slot=eq.${encodeURIComponent(slot)}&select=id,advertiser_id,cpm_kopecks,creative,spent_kopecks,total_budget_kopecks,target_pages,banner_format`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`campaign-service read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as CampaignRow[];
    return rows.map(mapRow);
  }

  async function getActiveBannerCampaigns(): Promise<CampaignCandidate[]> {
    const qs = `status=eq.active&format=eq.banner&select=id,advertiser_id,cpm_kopecks,creative,spent_kopecks,total_budget_kopecks,target_pages,banner_format`;
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`campaign-service banner read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as CampaignRow[];
    return rows.map(mapRow);
  }

  return {
    getCampaignsForSlot: (slot) =>
      withTimeout(getCampaignsForSlot(slot), timeoutMs, 'campaignService.getCampaignsForSlot'),
    getActiveBannerCampaigns: () =>
      withTimeout(getActiveBannerCampaigns(), timeoutMs, 'campaignService.getActiveBannerCampaigns'),
  };
}
