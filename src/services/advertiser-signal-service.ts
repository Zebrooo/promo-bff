/**
 * Сигнал рекламодателя для AdvertiserChecker: агрегаты по рекламным кампаниям
 * зрителя (supabase-aa `ad_campaigns`, advertiser_id = user) и событиям
 * мастера подачи РК (`user_action_events`, form_id = 'ad_campaign'). Сырые
 * строки чекер не видит — только AdvertiserSignal.
 *
 * Два чтения идут параллельно (кампании всегда, события — только когда
 * какому-то промо в очереди нужен abandonedWizard, т.е. wizardLookbackDays > 0).
 * Любой сбой бросает: loadAdvertiserForSelection глотает ошибку, и fail closed
 * остаются только advertiser-таргетированные промо (паттерн behavior-signal).
 *
 * `select=*` у ad_campaigns сознательно (как в campaign-review-service): схему
 * таблицы ведёт витрина, колонка starts_at/ends_at на стенде может называться
 * иначе — маппим защитно, чего нет — null.
 *
 * In-memory TTL-кэш 60 с по (userId, окно мастера): одна страница даёт до трёх
 * промо-запросов (topline/overlay/tooltip), кэш схлопывает их в одно чтение.
 */
import { config, type SupabaseConfig } from '../config';
import { moscowDateKey } from '../auction/run-auction';
import type { AdvertiserSignal } from '../promo-selector/checkers/Checker';
import { withTimeout } from '../util/with-timeout';

// Сайт рвёт весь промо-запрос по 800 мс; advertiser — опциональный гейт.
const ADVERTISER_SIGNAL_TIMEOUT_MS = 300;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 10_000;
const CAMPAIGN_ROW_LIMIT = 200;
const WIZARD_EVENT_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** form_id, с которым витрина шлёт form_start/form_submit_success из мастера
 *  подачи РК (docs/event-taxonomy.md кабинета). */
export const WIZARD_FORM_ID = 'ad_campaign';

/** Статусы ad_campaigns, означающие «кампания запускалась» (доходила до
 *  показов). pending/draft/rejected сюда не входят. Дополнительно запуском
 *  считаются любые списания (spent_kopecks > 0) — они бывают только у крутившейся
 *  РК. Меняется деплоем BFF, не промо. */
export const LAUNCHED_STATUSES: ReadonlySet<string> = new Set([
  'active', 'paused', 'completed', 'finished', 'ended', 'stopped',
]);

export interface AdvertiserSignalService {
  /** wizardLookbackDays = 0 → события мастера не читаются (wizardEvents: []). */
  getSignal(userId: string, opts: { wizardLookbackDays: number; now: Date }): Promise<AdvertiserSignal>;
}

/** Нормализованная строка ad_campaigns — вход чистой агрегации. */
export interface AdvertiserCampaignRow {
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  spentKopecks: number;
  totalBudgetKopecks: number | null;
  dailyBudgetKopecks: number | null;
  spentTodayKopecks: number;
  spentTodayDate: string | null;
}

export interface WizardEventRow {
  eventName: string;
  createdAt: string;
}

export const EMPTY_ADVERTISER_SIGNAL: AdvertiserSignal = {
  statuses: [],
  hasActive: false,
  lastLaunchedAt: null,
  spentKopecks: 0,
  budgetExhausted: false,
  activeEndsAt: null,
  wizardEvents: [],
  wizardWindowDays: 0,
};

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

function iso(v: unknown): string | null {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
}

/** Защитный маппинг сырой строки ad_campaigns (select=*). Экспорт для тестов. */
export function mapCampaignRow(raw: Record<string, unknown>): AdvertiserCampaignRow {
  return {
    status: String(raw.status ?? ''),
    createdAt: iso(raw.created_at),
    updatedAt: iso(raw.updated_at),
    startsAt: iso(raw.starts_at) ?? iso(raw.start_at),
    endsAt: iso(raw.ends_at) ?? iso(raw.end_at),
    spentKopecks: num(raw.spent_kopecks),
    totalBudgetKopecks: numOrNull(raw.total_budget_kopecks),
    dailyBudgetKopecks: numOrNull(raw.daily_budget_kopecks),
    spentTodayKopecks: num(raw.spent_today_kopecks),
    spentTodayDate: typeof raw.spent_today_date === 'string' ? raw.spent_today_date : null,
  };
}

function isLaunched(row: AdvertiserCampaignRow): boolean {
  return LAUNCHED_STATUSES.has(row.status) || row.spentKopecks > 0;
}

/** Дата запуска РК: starts_at, иначе updated_at, иначе created_at. */
function launchedAt(row: AdvertiserCampaignRow): string | null {
  return row.startsAt ?? row.updatedAt ?? row.createdAt;
}

function isBudgetExhausted(row: AdvertiserCampaignRow, now: Date): boolean {
  if (row.totalBudgetKopecks !== null && row.spentKopecks >= row.totalBudgetKopecks) return true;
  if (row.dailyBudgetKopecks !== null) {
    // Та же семантика «сегодня», что у dailyBudgetCheck аукциона: счётчик
    // spent_today относится к дате spent_today_date (МСК); чужая дата = 0.
    const spentToday = row.spentTodayDate === moscowDateKey(now) ? row.spentTodayKopecks : 0;
    if (spentToday >= row.dailyBudgetKopecks) return true;
  }
  return false;
}

/** Чистая агрегация — экспорт для юнит-тестов без моков fetch. */
export function computeAdvertiserSignal(
  campaigns: AdvertiserCampaignRow[],
  wizardEvents: WizardEventRow[],
  wizardWindowDays: number,
  now: Date,
): AdvertiserSignal {
  const nowMs = now.getTime();
  const statuses = [...new Set(campaigns.map((c) => c.status).filter((s) => s !== ''))];
  const active = campaigns.filter((c) => c.status === 'active');
  const launched = campaigns.filter(isLaunched);

  let lastLaunchedMs = -Infinity;
  for (const c of launched) {
    const at = launchedAt(c);
    const ms = at ? Date.parse(at) : NaN;
    if (Number.isFinite(ms) && ms > lastLaunchedMs) lastLaunchedMs = ms;
  }
  // Запускалась, но дат нет вовсе (кривая строка) — считаем «запускал когда-то»:
  // launchedWithinDays такой сигнал не пройдёт, everLaunched=true пройдёт.
  const lastLaunchedAt = launched.length === 0
    ? null
    : Number.isFinite(lastLaunchedMs) ? new Date(lastLaunchedMs).toISOString() : '';

  let activeEndsMs = Infinity;
  for (const c of active) {
    const ms = c.endsAt ? Date.parse(c.endsAt) : NaN;
    if (Number.isFinite(ms) && ms >= nowMs && ms < activeEndsMs) activeEndsMs = ms;
  }

  const events = wizardEvents
    .flatMap((e) => {
      const kind = e.eventName === 'form_start' ? 'start' : e.eventName === 'form_submit_success' ? 'submit' : null;
      if (!kind || !Number.isFinite(Date.parse(e.createdAt))) return [];
      return [{ kind, at: e.createdAt } as const];
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    statuses,
    hasActive: active.length > 0,
    lastLaunchedAt,
    spentKopecks: campaigns.reduce((sum, c) => sum + c.spentKopecks, 0),
    budgetExhausted: launched.some((c) => isBudgetExhausted(c, now)),
    activeEndsAt: Number.isFinite(activeEndsMs) ? new Date(activeEndsMs).toISOString() : null,
    wizardEvents: events,
    wizardWindowDays,
  };
}

export function createAdvertiserSignalService(
  cfg: SupabaseConfig = config.aaSupabase,
  clock: () => number = Date.now,
): AdvertiserSignalService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    // no-op (dev): пустой сигнал → advertiser-промо честно fail closed (кроме
    // «никогда не запускал / не платил / нет активной» — они совпадут у всех,
    // как и у любого пользователя без кампаний).
    return { getSignal: async (_userId, opts) => ({ ...EMPTY_ADVERTISER_SIGNAL, wizardWindowDays: opts.wizardLookbackDays }) };
  }

  const campaignsTable = `${url}/rest/v1/ad_campaigns`;
  const eventsTable = `${url}/rest/v1/user_action_events`;
  const budget = Math.min(timeoutMs, ADVERTISER_SIGNAL_TIMEOUT_MS);
  const cache = new Map<string, { value: AdvertiserSignal; expiresAt: number }>();

  async function fetchCampaigns(userId: string, signal: AbortSignal): Promise<AdvertiserCampaignRow[]> {
    const qs = new URLSearchParams({
      advertiser_id: `eq.${userId}`,
      select: '*',
      order: 'id.desc',
      limit: String(CAMPAIGN_ROW_LIMIT),
    });
    const res = await fetch(`${campaignsTable}?${qs}`, { headers: authHeaders(serviceRoleKey), signal });
    if (!res.ok) throw new Error(`advertiser-signal-service campaigns read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error('advertiser-signal-service campaigns read failed: invalid response');
    return rows.map((r) => mapCampaignRow((typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>));
  }

  async function fetchWizardEvents(userId: string, sinceIso: string, signal: AbortSignal): Promise<WizardEventRow[]> {
    const qs = new URLSearchParams({
      user_id: `eq.${userId}`,
      event_name: 'in.(form_start,form_submit_success)',
      'props->>form_id': `eq.${WIZARD_FORM_ID}`,
      created_at: `gte.${sinceIso}`,
      select: 'event_name,created_at',
      order: 'created_at.desc',
      limit: String(WIZARD_EVENT_LIMIT),
    });
    const res = await fetch(`${eventsTable}?${qs}`, { headers: authHeaders(serviceRoleKey), signal });
    if (!res.ok) throw new Error(`advertiser-signal-service events read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error('advertiser-signal-service events read failed: invalid response');
    return rows.flatMap((r) => {
      if (typeof r !== 'object' || r === null) return [];
      const row = r as { event_name?: unknown; created_at?: unknown };
      if (typeof row.event_name !== 'string' || typeof row.created_at !== 'string') return [];
      return [{ eventName: row.event_name, createdAt: row.created_at }];
    });
  }

  async function load(userId: string, wizardLookbackDays: number, now: Date, controller: AbortController): Promise<AdvertiserSignal> {
    const sinceIso = new Date(now.getTime() - wizardLookbackDays * DAY_MS).toISOString();
    const [campaigns, events] = await Promise.all([
      fetchCampaigns(userId, controller.signal),
      wizardLookbackDays > 0 ? fetchWizardEvents(userId, sinceIso, controller.signal) : Promise.resolve([]),
    ]);
    return computeAdvertiserSignal(campaigns, events, wizardLookbackDays, now);
  }

  return {
    async getSignal(userId, { wizardLookbackDays, now }) {
      const key = `${userId}|${wizardLookbackDays}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > clock()) return hit.value;
      cache.delete(key);

      const controller = new AbortController();
      const value = await withTimeout(
        load(userId, wizardLookbackDays, now, controller),
        budget,
        'advertiserSignalService.getSignal',
        controller,
      );
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cache.set(key, { value, expiresAt: clock() + CACHE_TTL_MS });
      return value;
    },
  };
}
