/**
 * Поведенческий сигнал зрителя из abkhaz-auto Supabase: RPC promo_viewer_behavior
 * отдаёт ТОЛЬКО агрегаты — категории с датой последнего просмотра (окно 14 дней)
 * и счётчик открытых телефонов за 7 дней. Сырые события не покидают Postgres.
 *
 * Пока миграция RPC не применена, каждый вызов падает (HTTP 404) — это
 * штатно: loadBehaviorForSelection глотает ошибку, и fail closed остаются
 * только interest/hot-buyer-таргетированные промо.
 *
 * In-memory TTL-кэш 60 с по (viewerKey, userId): одна страница сайта даёт до
 * трёх промо-запросов (topline/overlay/tooltip — отдельные route handlers),
 * кэш схлопывает их в одно чтение. Минута устаревания для окон «7/14 дней»
 * ничего не искажает.
 */
import { config, type SupabaseConfig } from '../config';
import type { BehaviorSignal } from '../promo-selector/checkers/Checker';
import { withTimeout } from '../util/with-timeout';

// Сайт рвёт весь промо-запрос по 800 мс; behavior — опциональный гейт, 300 мс
// оставляют времени продолжить с generic-кандидатами (как search-прецедент).
const BEHAVIOR_SIGNAL_TIMEOUT_MS = 300;
const CACHE_TTL_MS = 60_000;
// Потолок карты: при переполнении сбрасываем целиком (простое и достаточное
// поведение при нашем RPS; каждая запись — десятки байт агрегатов).
const CACHE_MAX_ENTRIES = 10_000;

export interface BehaviorSignalService {
  getSignal(viewerKey: string, userId?: string): Promise<BehaviorSignal>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

function parseSignal(body: unknown): BehaviorSignal {
  if (typeof body !== 'object' || body === null) {
    throw new Error('behavior-signal-service read failed: invalid response');
  }
  const b = body as { interests?: unknown; phoneViews7d?: unknown };
  if (!Array.isArray(b.interests) || typeof b.phoneViews7d !== 'number' || !Number.isFinite(b.phoneViews7d)) {
    throw new Error('behavior-signal-service read failed: invalid response');
  }
  // Кривые строки выбрасываются молча (паттерн parseRow search-сервиса):
  // чекеры должны видеть только валидные агрегаты.
  const interests = b.interests.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const r = row as { category?: unknown; lastViewedAt?: unknown };
    if (typeof r.category !== 'string' || r.category.trim() === '') return [];
    if (typeof r.lastViewedAt !== 'string' || !Number.isFinite(Date.parse(r.lastViewedAt))) return [];
    return [{ category: r.category, lastViewedAt: r.lastViewedAt }];
  });
  return { interests, phoneViews7d: b.phoneViews7d };
}

export function createBehaviorSignalService(
  cfg: SupabaseConfig = config.aaSupabase,
  now: () => number = Date.now,
): BehaviorSignalService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    // no-op (dev): пустой сигнал → behavior-промо честно fail closed.
    return { getSignal: async () => ({ interests: [], phoneViews7d: 0 }) };
  }

  const endpoint = `${url}/rest/v1/rpc/promo_viewer_behavior`;
  const cache = new Map<string, { value: BehaviorSignal; expiresAt: number }>();

  async function fetchSignal(
    viewerKey: string,
    userId: string | undefined,
    controller: AbortController,
  ): Promise<BehaviorSignal> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(serviceRoleKey),
      body: JSON.stringify({ p_viewer_key: viewerKey, p_user_id: userId ?? null }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`behavior-signal-service read failed: HTTP ${res.status}`);
    return parseSignal(await res.json());
  }

  return {
    async getSignal(viewerKey, userId) {
      const key = `${viewerKey}|${userId ?? ''}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
      cache.delete(key);

      const controller = new AbortController();
      const value = await withTimeout(
        fetchSignal(viewerKey, userId, controller),
        Math.min(timeoutMs, BEHAVIOR_SIGNAL_TIMEOUT_MS),
        'behaviorSignalService.getSignal',
        controller,
      );
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      cache.set(key, { value, expiresAt: now() + CACHE_TTL_MS });
      return value;
    },
  };
}
