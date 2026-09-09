/**
 * Чтение/правка рекламных кампаний рекламодателей (supabase-aa `ad_campaigns`)
 * для МОДЕРАЦИИ — в отличие от campaign-service.ts, который читает только
 * активные кампании для аукциона узким select'ом, здесь нужны все поля карточки
 * (кто, когда, сколько, что за креатив) и возможность поменять статус.
 *
 * `select=*` сознательно: схему таблицы ведёт витрина (abkhaz-auto), и мы не
 * хотим падать 400-м PostgREST из-за колонки, которой на этом стенде ещё/уже
 * нет. Все поля маппятся защитно: чего нет — null.
 *
 * Тот же паттерн, что у остальных сторов: service-role, withTimeout, без
 * конфига Supabase — no-op (configured=false), только реальный HTTP/сетевой
 * сбой бросает.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface CampaignReviewRow {
  id: number;
  advertiserId: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Название кампании, как назвал её рекламодатель (колонка name/title), либо
   *  заголовок креатива, либо null. */
  name: string | null;
  format: string | null;
  slot: string | null;
  bannerFormat: string | null;
  cpmKopecks: number;
  totalBudgetKopecks: number | null;
  dailyBudgetKopecks: number | null;
  spentKopecks: number;
  targetPages: string[] | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Сырой jsonb креатива — кабинет показывает title/description/imageUrl. */
  creative: unknown;
}

export interface CampaignReviewService {
  /** false = Supabase не задана (dev/тесты) — модерация недоступна. */
  configured: boolean;
  /** Кампании по статусам и/или id (обе выборки — И). Без фильтров — все. */
  listCampaigns(query: { ids?: number[]; statuses?: string[]; limit?: number }): Promise<CampaignReviewRow[]>;
  /** PATCH status. ok:false — PostgREST ответил не-2xx (например, CHECK на
   *  статус не знает такого значения); сетевой сбой — throw. */
  setStatus(id: number, status: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export const CAMPAIGN_REVIEW_DEFAULT_LIMIT = 200;

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function strArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
}

/** Экспортирован для тестов и для orchestrator'а (одна логика чтения строки). */
export function mapCampaignRow(raw: Record<string, unknown>): CampaignReviewRow {
  const creative = raw.creative;
  const creativeTitle =
    typeof creative === 'object' && creative !== null
      ? str((creative as Record<string, unknown>).title)
      : null;
  return {
    id: num(raw.id),
    advertiserId: String(raw.advertiser_id ?? ''),
    status: String(raw.status ?? ''),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    name: str(raw.name) ?? str(raw.title) ?? creativeTitle,
    format: str(raw.format),
    slot: str(raw.slot),
    bannerFormat: str(raw.banner_format),
    cpmKopecks: num(raw.cpm_kopecks),
    totalBudgetKopecks: numOrNull(raw.total_budget_kopecks),
    dailyBudgetKopecks: numOrNull(raw.daily_budget_kopecks),
    spentKopecks: num(raw.spent_kopecks),
    targetPages: strArray(raw.target_pages),
    startsAt: str(raw.starts_at) ?? str(raw.start_at),
    endsAt: str(raw.ends_at) ?? str(raw.end_at),
    creative,
  };
}

export function createCampaignReviewService(cfg: SupabaseConfig = config.supabase): CampaignReviewService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return {
      configured: false,
      listCampaigns: async () => [],
      setStatus: async () => ({ ok: false, error: 'not_configured' }),
    };
  }
  const table = `${url}/rest/v1/ad_campaigns`;

  async function listCampaigns(query: { ids?: number[]; statuses?: string[]; limit?: number }): Promise<CampaignReviewRow[]> {
    if (query.ids !== undefined && query.ids.length === 0) return [];
    const parts = ['select=*', 'order=id.desc', `limit=${query.limit ?? CAMPAIGN_REVIEW_DEFAULT_LIMIT}`];
    if (query.statuses && query.statuses.length > 0) {
      parts.push(`status=in.(${query.statuses.map((s) => encodeURIComponent(s)).join(',')})`);
    }
    if (query.ids && query.ids.length > 0) {
      parts.push(`id=in.(${query.ids.map((id) => String(id)).join(',')})`);
    }
    const res = await fetch(`${table}?${parts.join('&')}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`campaign-review read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Record<string, unknown>[];
    return rows.map(mapCampaignRow);
  }

  async function setStatus(id: number, status: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await fetch(`${table}?id=eq.${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      headers: {
        ...authHeaders(serviceRoleKey),
        'content-type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  }

  return {
    configured: true,
    listCampaigns: (query) => withTimeout(listCampaigns(query), timeoutMs, 'campaignReview.listCampaigns'),
    setStatus: (id, status) => withTimeout(setStatus(id, status), timeoutMs, 'campaignReview.setStatus'),
  };
}
