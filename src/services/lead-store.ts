/**
 * Чтение «горячих лидов» (public.promo_leads) для промо-кабинета — зеркало
 * click-store по устройству, но ровно на чтение: пишет заявки сайт, у которого
 * телефон и так есть (спека 2026-08-19-promo-hot-lead-design §5).
 *
 * Таблица закрыта RLS без политик, поэтому единственный способ её прочитать —
 * service-role ключ, который есть только здесь. Без конфига Supabase (dev,
 * тесты) деградирует в пустой список, как и остальные сторы.
 *
 * ⚠️ Это ПДн: телефон и имя пользователя. Наружу они уходят ровно одним путём —
 * авторизованный GET /leads из кабинета. Никаких логов со значениями строк.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface Lead {
  createdAt: string;
  promoId: string;
  promoTitle: string;
  page: string;
  name: string;
  phone: string;
  /** Доставка заявки рекламодателю (миграция 0307): pending | sent |
   *  no_subscriber | failed. У старых строк колонки нет → 'pending'. */
  notifyStatus: string;
  notifiedAt: string | null;
}

export interface LeadQuery {
  /** Только заявки этого промо; не задан — все промо. */
  promoId?: string;
  /** ISO-границы периода (включительно снизу, исключительно сверху). */
  from?: string;
  to?: string;
  limit?: number;
}

export interface LeadStore {
  getLeads(query: LeadQuery): Promise<Lead[]>;
}

export const LEADS_DEFAULT_LIMIT = 500;
export const LEADS_MAX_LIMIT = 5000;

interface LeadRow {
  created_at: string;
  promo_id: string;
  promo_title: string | null;
  page: string | null;
  name: string | null;
  phone: string | null;
  notify_status?: string | null;
  notified_at?: string | null;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function mapRow(row: LeadRow): Lead {
  return {
    createdAt: row.created_at,
    promoId: row.promo_id,
    promoTitle: row.promo_title ?? '',
    page: row.page ?? '',
    name: row.name ?? '',
    phone: row.phone ?? '',
    notifyStatus: row.notify_status ?? 'pending',
    notifiedAt: row.notified_at ?? null,
  };
}

/** Не настроен Supabase — пустой список (dev/tests), как у click/impression-стора. */
function createNoopStore(): LeadStore {
  return { getLeads: async () => [] };
}

export function createLeadStore(cfg: SupabaseConfig = config.supabase): LeadStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  const table = `${url}/rest/v1/promo_leads`;

  async function getLeads(query: LeadQuery): Promise<Lead[]> {
    const limit = Math.min(Math.max(query.limit ?? LEADS_DEFAULT_LIMIT, 1), LEADS_MAX_LIMIT);
    const params = [
      'select=created_at,promo_id,promo_title,page,name,phone,notify_status,notified_at',
      'order=created_at.desc',
      `limit=${limit}`,
    ];
    if (query.promoId) params.push(`promo_id=eq.${encodeURIComponent(query.promoId)}`);
    if (query.from) params.push(`created_at=gte.${encodeURIComponent(query.from)}`);
    if (query.to) params.push(`created_at=lt.${encodeURIComponent(query.to)}`);

    const res = await fetch(`${table}?${params.join('&')}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`lead-store read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as LeadRow[];
    return rows.map(mapRow);
  }

  return {
    getLeads: (query) => withTimeout(getLeads(query), timeoutMs, 'leadStore.getLeads'),
  };
}
