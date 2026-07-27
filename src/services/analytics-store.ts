/**
 * Analytics RPC reader — после чистки 2026-07-27 остался ОДИН метод.
 *
 * История: здесь была обёртка над десятком RPC (user_actions_* 0064,
 * promo_analytics_* 0066, onboarding 0067), питавших агрегатные дашборды
 * кабинета. По инициативе «Метрика — единственный источник продуктовой
 * аналитики» кабинет урезан до счётчика показов конкретной промки
 * (Zebrooo/promo-cabinet PR #3), и все ручки, кроме таймлайна, умерли.
 * Мёртвый код снесён вместе с роутами /analytics/* в server.ts — «безвредные»
 * эндпоинты с service-role-доступом к БД это не удобство, а поверхность атаки.
 *
 * Same pattern as event-store/impression-store: raw fetch, no SDK, no-op
 * fallback когда Supabase не сконфигурен. Использует AA-supabase config —
 * RPC живёт в abkhaz-auto deployment, не в promo.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface PromoTimelineRow {
  day: string;
  views: number;
  views_visible: number;
  cta_clicks: number;
}

export interface AnalyticsStore {
  /** Показы/клики конкретной промки по дням (RPC promo_analytics_per_promo,
   *  миграция 0066). Единственный живой потребитель — PromoAnalyticsBlock
   *  кабинета через POST /analytics/promos/timeline. */
  getPromoTimeline(promoId: string, days: number): Promise<PromoTimelineRow[]>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function createNoopStore(): AnalyticsStore {
  return {
    getPromoTimeline: async () => [],
  };
}

export function createAnalyticsStore(cfg: SupabaseConfig = config.aaSupabase): AnalyticsStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  async function callRpc<T>(fn: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`analytics-store ${fn} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  return {
    getPromoTimeline: (promoId, days) =>
      withTimeout(
        callRpc<PromoTimelineRow[]>('promo_analytics_per_promo', { _promo_id: promoId, _days: days }),
        timeoutMs,
        'analyticsStore.getPromoTimeline',
      ),
  };
}
