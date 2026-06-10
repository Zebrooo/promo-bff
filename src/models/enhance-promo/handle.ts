/**
 * enhance-promo: ask OpenRouter to rewrite the draft's text fields (title /
 * description / action.label), optionally also suggest pages (which sections
 * to target) and a CPM bid value, with rate-limiting per advertiser, an
 * in-memory cache keyed by canonical(draft+advertiser), and a JSONL cost log
 * for each fresh (cache-miss) call. Returns just the suggested text +
 * targeting — the cabinet diffs each piece against the current values and
 * lets the user accept per field.
 *
 * Failure policies (always 200 + envelope, per BFF convention):
 *   - rate-limit reached → status:'error', reason:'rate_limited'
 *   - openrouter unavailable / throws → 'openrouter_unavailable'
 *   - model returns non-JSON or no usable fields → 'malformed_response'
 *   - cost-log append failures are NOT fatal — logged + ignored.
 *
 * Pages/CPM are returned ONLY when the request included `availablePages`
 * (promo-cabinet doesn't send it and isn't interested). Even when requested,
 * suggestions are filtered against the whitelist + range; if nothing usable
 * is left, the field is omitted from the response.
 */
import type { OpenrouterClient } from '../../services/openrouter-client';
import type { AiCache } from '../../services/ai-cache';
import type { RateLimitStore } from '../../services/rate-limit-store';
import type { CostLog } from '../../services/cost-log';
import { canonicalCacheKey } from '../../services/ai-cache';
import type {
  AvailablePage,
  EnhanceParams,
  EnhanceResult,
  PromoSuggestions,
} from './types';
import { filterPagesAgainstWhitelist, validateCpmRange } from './validate';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** What goes into the cache — just the bits we need to reconstruct the
 *  response on a hit (timestamp & cacheHit flag are derived). */
export interface CachedSuggestion {
  suggestions: PromoSuggestions;
  model: string;
}

export interface EnhanceDeps {
  openrouter: OpenrouterClient;
  cache: AiCache<CachedSuggestion>;
  rateLimit: RateLimitStore;
  costLog: CostLog;
  logger?: Logger;
}

const SYSTEM_PROMPT_BASE = `Ты — редактор для российского сайта объявлений (промо и баннеры).
Перепиши черновик, чтобы он стал ярче, понятнее и короче, СОХРАНЯЯ смысл.
Правила:
- Только русский язык.
- НЕ выдумывай новых офферов, товаров и цифр; не добавляй того, чего не было в исходнике.
- title: до 60 символов, энергично, без кликбейта.
- description: до 180 символов, без восклицательного спама.
- action.label: до 24 символов, повелительное наклонение (например, «Купить →», «Узнать», «Подключить»).
- Верни ТОЛЬКО JSON-объект (без преамбулы и пояснений) с теми полями, которые ты улучшил.
  Те поля, что улучшать не нужно, опусти.`;

const SYSTEM_PROMPT_TARGETING_EXT = `
Дополнительно можешь предложить:
- pages: { "keys": [...из availablePages ключей], "reason": "почему именно эти разделы" } — только если эти разделы дадут лучший охват целевой аудитории И отличаются от draft.pages. Не выдумывай разделов, которых нет в availablePages.
- cpm: { "value": число от 1 до 200, "reason": "почему такая ставка" } — ВАЖНО про ставку:
  * draft.suggestedCpmRub — это рекомендация нашего pricing-движка для выбранной конфигурации (reach-weighted формула на основе baseCpm разделов и format-множителя, где baseCpm = half of Yandex.Direct CPMs). Это baseline.
  * Предлагай cpm.value в диапазоне ~ от 0.5× до 2× draft.suggestedCpmRub — НЕ выдумывай «стандартный CPM для рынка» из своих training-данных, у нас своя экономика.
  * Если у юзера ставка УЖЕ нормальная (вблизи или выше suggested) — предложи небольшой апсайд (e.g. +10-20%) с обоснованием либо опусти cpm.
  * Если ставка юзера сильно ниже suggested (<0.5×) — обязательно предложи поднять как минимум до suggested.
  * Если draft.suggestedCpmRub отсутствует — действуй консервативно, не предлагай число выше 30₽.
  * reason должен ссылаться на конкретные разделы/формат и юзеровские pages, а не общие фразы.
Если pages или cpm улучшать не нужно — опусти соответствующее поле.`;

const SCHEMA_TEXT_ONLY = `Схема: { "title"?: string, "description"?: string, "action"?: { "label": string } }`;

const SCHEMA_FULL = `Схема: { "title"?: string, "description"?: string, "action"?: { "label": string }, "pages"?: { "keys": string[], "reason": string }, "cpm"?: { "value": number, "reason": string } }`;

const MAX_OUTPUT_TOKENS = 600;
const TEMPERATURE = 0.6;

export async function handleEnhancePromo(
  params: EnhanceParams,
  deps: EnhanceDeps,
): Promise<EnhanceResult> {
  const { openrouter, cache, rateLimit, costLog, logger } = deps;

  // 1. Cache check first — cache hits don't burn rate-limit budget or money.
  const cacheKey = canonicalCacheKey({
    advertiserId: params.advertiserId,
    draft: params.draft,
    availablePages: params.availablePages,
  });
  const cached = cache.get(cacheKey);
  if (cached) {
    return {
      status: 'ok',
      data: { suggestions: cached.suggestions, cacheHit: true, model: cached.model },
    };
  }

  // 2. Rate-limit per advertiser. Rejected attempts are NOT recorded against
  //    the budget (see rate-limit-store) so a user can't lock themselves out.
  const limit = rateLimit.hit(params.advertiserId);
  if (!limit.ok) {
    return { status: 'error', reason: 'rate_limited' };
  }

  // 3. Build prompt. When availablePages is present, ask for pages+cpm too.
  const wantsTargeting = params.availablePages !== undefined && params.availablePages.length > 0;
  const system = wantsTargeting
    ? `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_TARGETING_EXT}\n${SCHEMA_FULL}`
    : `${SYSTEM_PROMPT_BASE}\n${SCHEMA_TEXT_ONLY}`;

  // 4. User prompt — text fields always; targeting context when applicable.
  //    When targeting is requested, everything goes under a single `draft` key
  //    so the LLM sees a consistent structure. Back-compat (no targeting) keeps
  //    the original flat shape to preserve existing cache-entry shape stability.
  const userPayload: Record<string, unknown> = wantsTargeting
    ? {
        draft: {
          title: params.draft.title,
          description: params.draft.description,
          action: params.draft.action,
          pages: params.draft.pages,
          cpmRub: params.draft.cpmRub,
          bannerFormat: params.draft.bannerFormat,
          suggestedCpmRub: params.draft.suggestedCpmRub,
        },
        availablePages: params.availablePages,
      }
    : {
        title: params.draft.title,
        description: params.draft.description,
        action: params.draft.action,
      };
  const userPrompt = JSON.stringify(userPayload);

  let result;
  try {
    result = await openrouter.call({
      system,
      user: userPrompt,
      maxTokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
    });
  } catch (err) {
    logger?.error({ err }, 'enhance-promo: openrouter call failed');
    return { status: 'error', reason: 'openrouter_unavailable' };
  }

  // 5. Parse the model's reply. Be lenient about ```fences``` / preambles —
  //    pull the largest valid JSON object from the text.
  //    suggestedCpmRub передаётся в санитайзер для bound-check'а на cpm.value
  //    (LLM иногда игнорит prompt и выдумывает «рыночный CPM» — отбрасываем
  //    значения вне ±50% от нашего baseline).
  const suggestedCpmRub = typeof params.draft.suggestedCpmRub === 'number'
    ? params.draft.suggestedCpmRub
    : null;
  const suggestions = parseSuggestions(result.text, params.availablePages, suggestedCpmRub);
  if (!suggestions) {
    logger?.error({ excerpt: result.text.slice(0, 200) }, 'enhance-promo: model returned malformed JSON');
    return { status: 'error', reason: 'malformed_response' };
  }

  // 6. Cache + cost-log (cost-log is best-effort; failure doesn't sink the user).
  cache.set(cacheKey, { suggestions, model: result.model });
  try {
    await costLog.append({
      advertiserId: params.advertiserId,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costRub: result.costRub,
    });
  } catch (err) {
    logger?.error({ err }, 'enhance-promo: cost-log append failed (best-effort)');
  }

  return { status: 'ok', data: { suggestions, cacheHit: false, model: result.model } };
}

/** Pull a JSON object out of the model's reply. Handles ```json fences and
 *  leading/trailing chatter by trying progressively shorter `{ ... }` ranges. */
function parseSuggestions(
  text: string,
  availablePages: readonly AvailablePage[] | undefined,
  suggestedCpmRub: number | null,
): PromoSuggestions | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const firstBrace = candidate.indexOf('{');
  if (firstBrace < 0) return null;
  for (let end = candidate.lastIndexOf('}'); end > firstBrace; end = candidate.lastIndexOf('}', end - 1)) {
    try {
      const obj = JSON.parse(candidate.slice(firstBrace, end + 1));
      if (typeof obj !== 'object' || obj === null) continue;
      return sanitizeSuggestions(obj as Record<string, unknown>, availablePages, suggestedCpmRub);
    } catch {
      /* try shorter range */
    }
  }
  return null;
}

/** Whitelist of fields we accept from the model — everything else is dropped.
 *  pages/cpm are accepted ONLY when availablePages was passed in the request. */
/** Bounds для cpm.value относительно baseline нашего pricing-движка.
 *  LLM хронически возвращает "стандартный рыночный CPM" из training-датасета.
 *  Окно [0.3×, 2.5×] — отбрасываем только абсурдные выбросы (10×+ нашего
 *  baseline), но даём AI пространство для значимых deviation'ов вверх/вниз.
 *  Раньше было [0.5, 1.5] — слишком узко, AI часто вообще не предлагал. */
const CPM_BASELINE_MIN_RATIO = 0.3;
const CPM_BASELINE_MAX_RATIO = 2.5;

function sanitizeSuggestions(
  obj: Record<string, unknown>,
  availablePages: readonly AvailablePage[] | undefined,
  suggestedCpmRub: number | null,
): PromoSuggestions | null {
  const out: PromoSuggestions = {};
  if (typeof obj.title === 'string' && obj.title.trim() !== '') out.title = obj.title.trim();
  if (typeof obj.description === 'string' && obj.description.trim() !== '') {
    out.description = obj.description.trim();
  }
  if (typeof obj.action === 'object' && obj.action !== null) {
    const a = obj.action as Record<string, unknown>;
    if (typeof a.label === 'string' && a.label.trim() !== '') {
      out.action = { label: a.label.trim() };
    }
  }

  // pages suggestion — only when caller opted in via availablePages.
  if (availablePages && typeof obj.pages === 'object' && obj.pages !== null) {
    const p = obj.pages as Record<string, unknown>;
    const keys = Array.isArray(p.keys) ? p.keys.filter((k): k is string => typeof k === 'string') : [];
    const reason = typeof p.reason === 'string' && p.reason.trim() !== '' ? p.reason.trim() : null;
    const filtered = filterPagesAgainstWhitelist(keys, availablePages);
    if (filtered.length > 0 && reason !== null) {
      out.pages = { keys: filtered, reason };
    }
  }

  // cpm suggestion — only when caller opted in via availablePages (same gate;
  // both fields are "targeting suggestions" conceptually).
  if (availablePages && typeof obj.cpm === 'object' && obj.cpm !== null) {
    const c = obj.cpm as Record<string, unknown>;
    const value = typeof c.value === 'number' ? c.value : NaN;
    const reason = typeof c.reason === 'string' && c.reason.trim() !== '' ? c.reason.trim() : null;
    // Базовая валидация: в диапазоне [1, 50] и с reason.
    let pass = validateCpmRange(value) && reason !== null;
    // Hard-bound против "рыночного CPM" из training-датасета: если cabinet
    // прислал suggestedCpmRub — отбрасываем значения вне [0.5×, 1.5×] от него.
    // Без baseline'а (старые промо-cabinet вызовы) — оставляем только базовую валидацию.
    if (pass && suggestedCpmRub !== null && suggestedCpmRub > 0) {
      const minAllowed = suggestedCpmRub * CPM_BASELINE_MIN_RATIO;
      const maxAllowed = suggestedCpmRub * CPM_BASELINE_MAX_RATIO;
      if (value < minAllowed || value > maxAllowed) pass = false;
    }
    if (pass && reason !== null) {
      out.cpm = { value, reason };
    }
  }

  // If the model returned a valid JSON object with no usable fields at all,
  // treat it as malformed (no suggestions = nothing useful to offer the editor).
  return out.title || out.description || out.action || out.pages || out.cpm ? out : null;
}
