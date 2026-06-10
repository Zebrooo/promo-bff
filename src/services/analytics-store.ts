/**
 * Analytics RPC reader. Обёртка над user_actions_* (миграция 0064) и
 * promo_analytics_* (миграция 0066) функциями на abkhaz-auto Supabase.
 * Все запросы — POST в /rest/v1/rpc/<fn> с named params (PostgREST convention).
 *
 * Same pattern as event-store/impression-store: raw fetch, no SDK, no-op
 * fallback когда Supabase не сконфигурен. Использует AA-supabase config —
 * все эти RPC живут в abkhaz-auto deployment, не в promo.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface KpiResult {
  dau: number; wau: number; mau: number;
  events_today: number; events_7d: number; events_total: number;
}
export interface TopRow {
  event_name: string;
  curr_count: number;
  prev_count: number;
  delta_pct: number | null;
}
export interface FunnelRow {
  step: number;
  event_name: string;
  sessions: number;
  conversion_pct: number | null;
}
export interface DailyRow {
  day: string;  // YYYY-MM-DD
  count: number;
}

// ── Promo-specific shapes (migration 0066) ──────────────────────────────
export interface PromoTopRow {
  promo_id: string;
  title: string | null;
  format: string | null;
  views: number;
  views_visible: number;
  cta_clicks: number;
  closes: number;
  dismisses: number;
  ctr_pct: number;
}
export interface PromoZeroRow {
  promo_id: string;
  title: string | null;
  format: string | null;
  views: number;
  last_seen: string;
}
export interface PromoFunnelByFormatRow {
  format: string;
  views: number;
  views_visible: number;
  cta_clicks: number;
  visible_pct: number;
  ctr_pct: number;
}
export interface PromoTimelineRow {
  day: string;
  views: number;
  views_visible: number;
  cta_clicks: number;
}

// ── Onboarding (migration 0067) — derived from user_action_events where
// event_name LIKE 'onboarding_%'. Shape see migration SQL.
export interface OnboardingOverview {
  welcome_shown:        number;
  welcome_skipped:      number;
  role_picked:          number;
  role_buyer:           number;
  role_seller:          number;
  completed:            number;
  completed_finished:   number;
  completed_autoskip:   number;
  skipped_explicit:     number;
  auto_skipped_steps:   number;
  restarted:            number;
  step_shown_total:     number;
  step_next_total:      number;
}
export interface OnboardingFunnelRow {
  step_id:            string;
  step_idx:           number;
  shown_count:        number;
  next_count:         number;
  auto_skipped_count: number;
}

export interface AnalyticsStore {
  getKpi(): Promise<KpiResult>;
  getTop(days: number, limit: number): Promise<TopRow[]>;
  getFunnel(events: string[], days: number): Promise<FunnelRow[]>;
  getDaily(days: number): Promise<DailyRow[]>;
  // Promo (migration 0066) — derived from user_action_events where
  // event_name LIKE 'promo_%'. promo_id pulled from props->>'promo_id'.
  getPromoTop(days: number, limit: number): Promise<PromoTopRow[]>;
  getPromoZero(days: number, limit: number): Promise<PromoZeroRow[]>;
  getPromoFunnelByFormat(days: number): Promise<PromoFunnelByFormatRow[]>;
  getPromoTimeline(promoId: string, days: number): Promise<PromoTimelineRow[]>;
  // Onboarding (миграция 0067 на AA Supabase).
  getOnboardingOverview(days: number): Promise<OnboardingOverview>;
  getOnboardingFunnel(days: number):   Promise<OnboardingFunnelRow[]>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function createNoopStore(): AnalyticsStore {
  return {
    getKpi: async () => ({ dau: 0, wau: 0, mau: 0, events_today: 0, events_7d: 0, events_total: 0 }),
    getTop: async () => [],
    getFunnel: async () => [],
    getDaily: async () => [],
    getPromoTop: async () => [],
    getPromoZero: async () => [],
    getPromoFunnelByFormat: async () => [],
    getPromoTimeline: async () => [],
    getOnboardingOverview: async () => ({
      welcome_shown: 0, welcome_skipped: 0,
      role_picked: 0, role_buyer: 0, role_seller: 0,
      completed: 0, completed_finished: 0, completed_autoskip: 0,
      skipped_explicit: 0, auto_skipped_steps: 0, restarted: 0,
      step_shown_total: 0, step_next_total: 0,
    }),
    getOnboardingFunnel: async () => [],
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
    getKpi: () =>
      withTimeout(callRpc<KpiResult>('user_actions_kpi'), timeoutMs, 'analyticsStore.getKpi'),
    getTop: (days, limit) =>
      withTimeout(
        callRpc<TopRow[]>('user_actions_top', { _days: days, _limit: limit }),
        timeoutMs,
        'analyticsStore.getTop',
      ),
    getFunnel: (events, days) =>
      withTimeout(
        callRpc<FunnelRow[]>('user_actions_funnel', { _events: events, _days: days }),
        timeoutMs,
        'analyticsStore.getFunnel',
      ),
    getDaily: (days) =>
      withTimeout(
        callRpc<DailyRow[]>('user_actions_daily', { _days: days }),
        timeoutMs,
        'analyticsStore.getDaily',
      ),
    getPromoTop: (days, limit) =>
      withTimeout(
        callRpc<PromoTopRow[]>('promo_analytics_top', { _days: days, _limit: limit }),
        timeoutMs,
        'analyticsStore.getPromoTop',
      ),
    getPromoZero: (days, limit) =>
      withTimeout(
        callRpc<PromoZeroRow[]>('promo_analytics_zero', { _days: days, _limit: limit }),
        timeoutMs,
        'analyticsStore.getPromoZero',
      ),
    getPromoFunnelByFormat: (days) =>
      withTimeout(
        callRpc<PromoFunnelByFormatRow[]>('promo_analytics_funnel_by_format', { _days: days }),
        timeoutMs,
        'analyticsStore.getPromoFunnelByFormat',
      ),
    getPromoTimeline: (promoId, days) =>
      withTimeout(
        callRpc<PromoTimelineRow[]>('promo_analytics_per_promo', { _promo_id: promoId, _days: days }),
        timeoutMs,
        'analyticsStore.getPromoTimeline',
      ),
    getOnboardingOverview: (days) =>
      withTimeout(
        callRpc<OnboardingOverview>('user_actions_onboarding_overview', { _days: days }),
        timeoutMs,
        'analyticsStore.getOnboardingOverview',
      ),
    getOnboardingFunnel: (days) =>
      withTimeout(
        callRpc<OnboardingFunnelRow[]>('user_actions_onboarding_funnel', { _days: days }),
        timeoutMs,
        'analyticsStore.getOnboardingFunnel',
      ),
  };
}
